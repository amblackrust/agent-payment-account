import { describe, expect, it, vi } from 'vitest'
import { V2PaymentService } from './payments-v2.js'
import type {
  AuthenticatedAccount,
  V2DatabaseRepository,
  V2PaymentCreateInput,
  V2PaymentView,
} from '@agent-payment/db'

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

function createHarness(destinationApproved: boolean) {
  let captured: V2PaymentCreateInput | undefined
  let latestView: V2PaymentView | undefined
  const getSettledAtomic = vi.fn(async () => 1_000n)
  const repository = {
    findDenomination: async () => ({
      id: 'denom_usd',
      symbol: 'USD',
      maxScale: 2,
      status: 'ACTIVE',
      version: 1,
    }),
    listActiveSettlementRoutes: async () => [
      {
        id: 'route_solana',
        rail: 'SOLANA_SPL',
        railVersion: '1',
        network: 'localnet',
        settlementAssetId: 'asset_usdc',
        economicMappingId: 'mapping_usd_usdc',
        status: 'ACTIVE' as const,
        priority: 1,
        configVersion: 'test',
      },
    ],
    findSettlementAsset: async () => ({
      id: 'asset_usdc',
      rail: 'SOLANA_SPL',
      network: 'localnet',
      assetReference: 'mint_usdc',
      decimals: 6,
      status: 'ACTIVE',
      version: 1,
    }),
    findEconomicMapping: async () => ({
      id: 'mapping_usd_usdc',
      denominationId: 'denom_usd',
      settlementAssetId: 'asset_usdc',
      numerator: 1n,
      denominator: 1n,
      status: 'ACTIVE',
      version: 1,
    }),
    findApprovedDestination: async () =>
      destinationApproved
        ? {
            id: 'approved_1',
            accountId: 'acct_1',
            fingerprint: 'fingerprint',
            rail: 'SOLANA_SPL',
            network: 'localnet',
            assetReference: 'mint_usdc',
            destination: 'recipient_wallet',
          }
        : null,
    getSpendContext: async () => ({
      confirmedSpendAtomic: 0n,
      heldReservationAtomic: 0n,
      unresolvedSpendAtomic: 0n,
      transactionCount: 0,
    }),
    findActiveSpendPolicy: async () => ({
      id: 'policy_1',
      accountId: 'acct_1',
      version: 1,
      status: 'ACTIVE',
      denominationId: 'denom_usd',
      maxPerPaymentAtomic: null,
      rollingBudgetAtomic: null,
      rollingWindowSeconds: null,
      transactionCountCap: null,
      approvalThresholdAtomic: null,
      rollingBudgetEscalatable: false,
      transactionCountEscalatable: false,
    }),
    createV2Payment: async (input: V2PaymentCreateInput) => {
      captured = input
      const now = new Date('2026-09-17T00:00:00.000Z')
      latestView = {
        payment: {
          id: input.paymentId,
          payerAccountId: input.accountId,
          recipientId: input.recipientId,
          recipientManagedAccountId: input.recipientManagedAccountId ?? null,
          kind: input.operation,
          description: input.description ?? null,
          externalReference: input.externalReference ?? null,
          amountAtomic: input.amountAtomic,
          amountScale: input.amountScale,
          denominationId: input.denominationId,
          currency: input.currency,
          status:
            input.policyDecision.decision === 'DENY'
              ? 'REJECTED_BY_POLICY'
              : input.policyDecision.decision === 'REQUIRE_APPROVAL'
                ? 'AWAITING_APPROVAL'
                : 'ROUTING',
          routeId: input.route?.id ?? null,
          routeSelectionReason: input.routeSelectionReason,
          settlementAssetId: input.settlementAssetId,
          destinationSnapshotJson: input.destinationSnapshotJson,
          policyDecisionId: input.policyDecision.id,
          approvalId: input.approval?.id ?? null,
          executionState:
            input.policyDecision.decision === 'ALLOW' ? 'QUEUED' : 'NOT_STARTED',
          settlementState: 'NOT_SUBMITTED',
          outcomeState:
            input.policyDecision.decision === 'DENY' ? 'PROVED_NO_EFFECT' : 'NONE',
          rowVersion: 1,
          originalPaymentId: null,
          confirmedAt: null,
          failedAt: null,
          failureCode: null,
          failureMessageSafe: null,
          createdAt: now,
          updatedAt: now,
        },
        policyDecision: input.policyDecision.decision,
        reasonCodes: input.policyDecision.reasonCodes,
        approvalState: input.approval === undefined ? 'NOT_REQUIRED' : 'PENDING',
        reservationStatus: input.policyDecision.decision === 'ALLOW' ? 'HELD' : 'NONE',
        attempts:
          input.policyDecision.decision === 'ALLOW'
            ? [
                {
                  id: input.attemptId,
                  paymentId: input.paymentId,
                  attemptNumber: 1,
                  routeId: input.route?.id ?? null,
                  status: 'CREATED',
                  outcome: 'NOT_STARTED',
                  preparedEffectHash: null,
                  signedPayloadHash: null,
                  expectedExternalId: null,
                  validityExpiresAt: null,
                  validitySlot: null,
                  rowVersion: 1,
                },
              ]
            : [],
      }
      return {
        payment: latestView.payment,
        created: true,
      }
    },
    findPaymentView: async () => latestView ?? null,
  } as unknown as V2DatabaseRepository
  const service = new V2PaymentService({
    repository,
    recipientRepository: {
      findRecipientForOwner: async () => ({
        id: 'recipient_1',
        ownerAccountId: 'acct_1',
        displayName: 'Recipient',
        type: 'EXTERNAL',
        managedAccountId: null,
        ownerStatus: 'ACTIVE',
        destinations: [
          {
            id: 'destination_1',
            rail: 'SOLANA_SPL',
            type: 'SOLANA_SPL',
            walletAddress: 'recipient_wallet',
          },
        ],
        createdAt: new Date('2026-09-16T00:00:00.000Z'),
        updatedAt: new Date('2026-09-16T00:00:00.000Z'),
        archivedAt: null,
        rowVersion: 1,
      }),
    },
    settledBalanceProvider: { getSettledAtomic },
    now: () => new Date('2026-09-17T00:00:00.000Z'),
  })
  return { service, getSettledAtomic, getCaptured: () => captured }
}

describe('V2 payment service', () => {
  it('creates an allowed payment with an atomic reservation plan', async () => {
    const harness = createHarness(true)
    const result = await harness.service.createPayment(
      account,
      {
        kind: 'PAY',
        recipientId: 'recipient_1',
        amount: '001.25',
        denominationId: 'denom_usd',
      },
      'idem_1',
      'req_1',
    )

    expect(result.view.payment.status).toBe('ROUTING')
    expect(result.view.reservationStatus).toBe('HELD')
    expect(result.view.attempts).toHaveLength(1)
    expect(harness.getCaptured()?.route?.id).toBe('route_solana')
    expect(harness.getCaptured()?.amountAtomic).toBe(125n)
    expect(harness.getSettledAtomic).toHaveBeenCalledOnce()
  })

  it('persists policy denial without selecting a durable route or calling balance', async () => {
    const harness = createHarness(false)
    const result = await harness.service.createPayment(
      account,
      {
        kind: 'PAY',
        recipientId: 'recipient_1',
        amount: '1.25',
        denominationId: 'denom_usd',
      },
      'idem_2',
      'req_2',
    )

    expect(result.view.policyDecision).toBe('DENY')
    expect(result.view.payment.status).toBe('REJECTED_BY_POLICY')
    expect(result.view.reservationStatus).toBe('NONE')
    expect(result.view.attempts).toHaveLength(0)
    expect(harness.getCaptured()?.route).toBeNull()
    expect(harness.getCaptured()?.settlementAssetId).toBeNull()
    expect(harness.getSettledAtomic).not.toHaveBeenCalled()
  })
})
