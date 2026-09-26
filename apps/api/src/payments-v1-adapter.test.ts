import { describe, expect, it, vi } from 'vitest'
import type {
  AuthenticatedAccount,
  V2DatabaseRepository,
  V2PaymentView,
} from '@agent-payment/db'
import { PolicyDeniedError } from '@agent-payment/core'
import { V2PaymentServiceAdapter } from './payments-v1-adapter.js'
import type { V2PaymentService } from './payments-v2.js'

const account: AuthenticatedAccount = {
  account: {
    id: 'acct_1',
    name: 'Test account',
    status: 'ACTIVE',
    solanaPublicKey: 'payer_public_key',
  },
  credential: {
    id: 'cred_1',
    accountId: 'acct_1',
    keyHash: 'hash',
    keyPrefix: 'apa_test',
    status: 'ACTIVE',
    scopes: ['payments:create', 'payments:read'],
    expiresAt: null,
    revokedAt: null,
    lastUsedAt: null,
  },
}

function view(policyDecision: 'ALLOW' | 'DENY' = 'ALLOW'): V2PaymentView {
  const now = new Date('2026-09-17T00:00:00.000Z')
  return {
    payment: {
      id: 'pay_1',
      payerAccountId: 'acct_1',
      recipientId: 'recipient_1',
      recipientManagedAccountId: null,
      kind: 'PAY',
      description: 'dataset access',
      externalReference: 'order-1',
      amountAtomic: 125n,
      amountScale: 2,
      denominationId: 'denom_usd',
      currency: 'USD',
      status: policyDecision === 'DENY' ? 'REJECTED_BY_POLICY' : 'ROUTING',
      routeId: policyDecision === 'DENY' ? null : 'route_solana',
      routeSelectionReason: policyDecision === 'DENY' ? null : 'priority',
      settlementAssetId: policyDecision === 'DENY' ? null : 'asset_usdc',
      destinationSnapshotJson:
        policyDecision === 'DENY'
          ? null
          : JSON.stringify({
              rail: 'SOLANA_SPL',
              destination_type: 'WALLET',
              wallet_address: 'recipient_wallet',
            }),
      policyDecisionId: 'decision_1',
      approvalId: null,
      executionState: policyDecision === 'DENY' ? 'NOT_STARTED' : 'QUEUED',
      settlementState: 'NOT_SUBMITTED',
      outcomeState: policyDecision === 'DENY' ? 'PROVED_NO_EFFECT' : 'NONE',
      rowVersion: 1,
      originalPaymentId: null,
      confirmedAt: null,
      failedAt: null,
      failureCode: null,
      failureMessageSafe: null,
      createdAt: now,
      updatedAt: now,
    },
    policyDecision,
    reasonCodes: policyDecision === 'DENY' ? ['DESTINATION_NOT_APPROVED'] : [],
    approvalState: 'NOT_REQUIRED',
    reservationStatus: policyDecision === 'DENY' ? 'NONE' : 'HELD',
    attempts: [],
  }
}

function createAdapterHarness(policyDecision: 'ALLOW' | 'DENY' = 'ALLOW') {
  const service = {
    createPayment: vi.fn(async () => ({ view: view(policyDecision), created: true })),
    createRefund: vi.fn(async () => ({ view: view(policyDecision), created: true })),
    getPayment: vi.fn(async () => view(policyDecision)),
    listPayments: vi.fn(async () => ({
      payments: [view(policyDecision)],
      nextCursor: null,
    })),
  } as unknown as V2PaymentService
  const repository = {
    findDenominationBySymbol: vi.fn(async () => ({
      id: 'denom_usd',
      symbol: 'USD',
      maxScale: 2,
      status: 'ACTIVE',
      version: 1,
    })),
    findAccountPublicKey: vi.fn(async () => 'payer_public_key'),
  } as unknown as V2DatabaseRepository
  return {
    adapter: new V2PaymentServiceAdapter(service, repository),
    service,
    repository,
  }
}

describe('V2 payment service adapter', () => {
  it('delegates legacy creation and maps the V2 snapshot back to the legacy record', async () => {
    const harness = createAdapterHarness()

    const result = await harness.adapter.createPayment(
      account,
      'PAY',
      {
        recipientId: 'recipient_1',
        amount: '1.25',
        currency: 'USD',
        description: 'dataset access',
        externalReference: 'order-1',
      },
      'idem_1',
      'req_1',
      'corr_1',
    )

    expect(harness.repository.findDenominationBySymbol).toHaveBeenCalledWith('USD')
    expect(harness.service.createPayment).toHaveBeenCalledWith(
      account,
      {
        kind: 'PAY',
        recipientId: 'recipient_1',
        amount: '1.25',
        denominationId: 'denom_usd',
        description: 'dataset access',
        externalReference: 'order-1',
      },
      'idem_1',
      'req_1',
      'corr_1',
    )
    expect(result).toMatchObject({
      created: true,
      payment: {
        id: 'pay_1',
        amountAtomic: 125n,
        currency: 'USD',
        description: 'dataset access',
        externalReference: 'order-1',
        destinationReference: 'recipient_wallet',
      },
    })
  })

  it('preserves policy denial instead of exposing a legacy payment result', async () => {
    const harness = createAdapterHarness('DENY')

    await expect(
      harness.adapter.createPayment(
        account,
        'PAY',
        { recipientId: 'recipient_1', amount: '1.25', currency: 'USD' },
        'idem_1',
      ),
    ).rejects.toBeInstanceOf(PolicyDeniedError)
  })

  it('uses the configured page-size ceiling for the retained V1 contract', async () => {
    const harness = createAdapterHarness()
    const adapter = new V2PaymentServiceAdapter(harness.service, harness.repository, 2)

    await expect(
      adapter.listPaymentsPage(account.account.id, { limit: 3 }),
    ).rejects.toThrow('Payment limit must be an integer from 1 to 2')
  })
})
