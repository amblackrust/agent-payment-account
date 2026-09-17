import { describe, expect, it } from 'vitest'
import type { V2PaymentView } from '@agent-payment/db'
import type { V2SigningRequestRecord } from '@agent-payment/db'
import { WalletSecretCipher } from './custody.js'
import { V2OutgoingWorker } from './outgoing-v2.js'

function view(): V2PaymentView {
  return {
    payment: {
      id: 'pay_1',
      payerAccountId: 'acct_1',
      recipientId: 'rcpt_1',
      recipientManagedAccountId: null,
      kind: 'PAY',
      description: null,
      externalReference: null,
      amountAtomic: 100n,
      amountScale: 2,
      denominationId: 'denom_usd',
      currency: 'USD',
      status: 'ROUTING',
      routeId: 'route_1',
      routeSelectionReason: 'priority',
      settlementAssetId: 'asset_1',
      destinationSnapshotJson: JSON.stringify({
        rail: 'SOLANA_SPL',
        network: 'localnet',
        asset_reference: 'asset_1',
        wallet_address: 'destination_1',
      }),
      policyDecisionId: 'decision_1',
      approvalId: null,
      executionState: 'QUEUED',
      settlementState: 'NOT_SUBMITTED',
      outcomeState: 'NONE',
      rowVersion: 1,
      originalPaymentId: null,
      confirmedAt: null,
      failedAt: null,
      failureCode: null,
      failureMessageSafe: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    },
    policyDecision: 'ALLOW',
    reasonCodes: [],
    approvalState: 'NOT_REQUIRED',
    reservationStatus: 'HELD',
    attempts: [
      {
        id: 'attempt_1',
        paymentId: 'pay_1',
        attemptNumber: 1,
        routeId: 'route_1',
        status: 'CREATED',
        outcome: 'NOT_STARTED',
        preparedEffectHash: null,
        signedPayloadHash: null,
        expectedExternalId: null,
        validityExpiresAt: null,
        validitySlot: null,
        rowVersion: 1,
      },
    ],
  }
}

describe('V2 outgoing worker', () => {
  it('terminalizes a provably pre-effect payment when account disable wins', async () => {
    let claims = 0
    let aborted = false
    let completed = false
    const repository = {
      claimWorkItem: async () => {
        if (claims++ > 0) return null
        return {
          id: 'work_1',
          kind: 'OUTGOING_PAYMENT',
          resourceType: 'PAYMENT',
          resourceId: 'pay_1',
          attemptCount: 1,
          payloadJson: '{}',
          accountId: 'acct_1',
        }
      },
      findPaymentView: async () => view(),
      abortPreEffectPayment: async () => {
        aborted = true
        return view()
      },
      completeWorkItem: async () => {
        completed = true
      },
    }
    let prepared = false
    const worker = new V2OutgoingWorker({
      repository: repository as never,
      accountStatusProvider: { getStatus: async () => 'DISABLED' },
      executor: {
        prepare: async () => {
          prepared = true
          throw new Error('must not prepare')
        },
        sign: async () => {
          throw new Error('must not sign')
        },
        submit: async () => ({ status: 'UNKNOWN' as const }),
      },
      owner: 'worker-1',
    })

    await worker.runOnce()

    expect(prepared).toBe(false)
    expect(aborted).toBe(true)
    expect(completed).toBe(true)
  })

  it('claims replacement work and confirms it through the constrained signing boundary', async () => {
    let claimIndex = 0
    let signCount = 0
    let completed = false
    let finalized = false
    let finalizedInput: Record<string, unknown> | undefined
    const baseView = view()
    const signingRequest: V2SigningRequestRecord = {
      id: 'signing_attempt_1',
      paymentId: 'pay_1',
      attemptId: 'attempt_1',
      effectHash: 'a'.repeat(64),
      routeId: 'route_1',
      network: 'localnet',
      assetReference: 'asset_1',
      destination: 'destination_1',
      amountAtomic: 100n,
      feePayerIdentity: 'fee-payer-1',
      keyVersion: 1,
      status: 'PENDING',
      serviceIdentity: 'worker-1',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      completedAt: null,
    }
    const repository = {
      claimWorkItem: async () => {
        const claim =
          claimIndex++ === 0
            ? {
                id: 'work_replacement',
                kind: 'OUTGOING_PAYMENT_ATTEMPT',
                resourceType: 'PAYMENT_ATTEMPT',
                resourceId: 'attempt_1',
                attemptCount: 1,
                payloadJson: JSON.stringify({
                  payment_id: 'pay_1',
                  attempt_id: 'attempt_1',
                }),
                accountId: 'acct_1',
              }
            : null
        return claim
      },
      findPaymentView: async () => baseView,
      updateAttemptOutcome: async () => baseView.attempts[0],
      updatePaymentExecution: async () => baseView.payment,
      finalizeV2Payment: async (input: Record<string, unknown>) => {
        finalized = true
        finalizedInput = input
        return baseView
      },
      completeWorkItem: async () => {
        completed = true
      },
    }
    const cipher = new WalletSecretCipher(
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    )
    const worker = new V2OutgoingWorker({
      repository: repository as never,
      accountStatusProvider: { getStatus: async () => 'ACTIVE' },
      custody: {
        findActiveCustodyKeyVersion: async () => ({
          id: 'key_1',
          accountId: 'acct_1',
          keyVersion: 1,
          backendIdentity: 'test',
          keyReference: 'key-ref-1',
          rootKeyFingerprint: 'b'.repeat(64),
          status: 'ACTIVE',
        }),
        findSigningRequest: async () => null,
        createSigningRequest: async () => signingRequest,
        completeSigningRequest: async () => ({ ...signingRequest, status: 'SIGNED' }),
      },
      signedPayloadCipher: cipher,
      executor: {
        prepare: async () => ({
          accountId: 'acct_1',
          paymentId: 'pay_1',
          attemptId: 'attempt_1',
          effectHash: 'a'.repeat(64),
          routeId: 'route_1',
          network: 'localnet',
          assetReference: 'asset_1',
          destination: 'destination_1',
          amountAtomic: 100n,
          feePayerIdentity: 'fee-payer-1',
          keyVersion: 1,
          payloadHash: 'a'.repeat(64),
          preparedPayload: '{}',
        }),
        sign: async () => {
          signCount += 1
          return {
            effectHash: 'a'.repeat(64),
            keyVersion: 1,
            signedPayload: new Uint8Array([1, 2, 3]),
            externalId: 'external-1',
          }
        },
        submit: async () => ({
          status: 'CONFIRMED' as const,
          externalId: 'external-1',
        }),
      },
      owner: 'worker-1',
    })

    await worker.runOnce()

    expect(signCount).toBe(1)
    expect(finalized).toBe(true)
    expect(finalizedInput?.expectedExternalId).toBe('external-1')
    expect(finalizedInput?.payloadHash).toBe('a'.repeat(64))
    expect(finalizedInput?.metadataJson).toContain('prepared_payload_hash')
    expect(completed).toBe(true)
  })

  it('keeps reconciliation work on the dedicated reconciliation role', async () => {
    const claimedKinds: string[] = []
    let retryInput: { nextKind?: string } | undefined
    let claimCount = 0
    const repository = {
      claimWorkItem: async ({ kind }: { kind: string }) => {
        claimedKinds.push(kind)
        if (claimCount++ > 0) return null
        return {
          id: 'reconcile_work_1',
          kind,
          resourceType: 'PAYMENT_ATTEMPT',
          resourceId: 'attempt_1',
          attemptCount: 1,
          payloadJson: JSON.stringify({ payment_id: 'pay_1', attempt_id: 'attempt_1' }),
          accountId: 'acct_1',
        }
      },
      findPaymentView: async () => view(),
      retryWorkItem: async (input: { nextKind?: string }) => {
        retryInput = input
      },
    }
    const worker = new V2OutgoingWorker({
      repository: repository as never,
      accountStatusProvider: { getStatus: async () => 'ACTIVE' },
      executor: {
        prepare: async () => {
          throw new Error('reconcile role must not prepare')
        },
        sign: async () => {
          throw new Error('reconcile role must not sign')
        },
        submit: async () => ({ status: 'UNKNOWN' as const }),
      },
      mode: 'reconcile',
      owner: 'reconcile-1',
    })

    await worker.runOnce()

    expect(claimedKinds).toEqual([
      'RECONCILE_PAYMENT_ATTEMPT',
      'RECONCILE_PAYMENT_ATTEMPT',
    ])
    expect(retryInput?.nextKind).toBe('OUTGOING_PAYMENT_ATTEMPT')
  })
})
