import { randomBytes } from 'node:crypto'
import {
  ConflictError,
  createDenomination,
  evaluateSpendPolicy,
  exactMoneyFromAtomicUnits,
  IdempotencyConflictError,
  InsufficientFundsError,
  InvalidStateError,
  NotFoundError,
  assertAttemptProgression,
  projectPaymentStatus,
  type AttemptOutcome,
  type PaymentPolicyDecision,
  type SpendPolicy,
  type SettlementRoute,
} from '@agent-payment/core'
import type { Prisma, PrismaClient } from './generated/client/client.js'
import { enqueueWebhookEvent } from './webhook-events.js'

export interface V2DenominationRecord {
  readonly id: string
  readonly symbol: string
  readonly maxScale: number
  readonly status: string
  readonly version: number
}

export interface V2SettlementAssetRecord {
  readonly id: string
  readonly rail: string
  readonly network: string
  readonly assetReference: string
  readonly decimals: number
  readonly status: string
  readonly version: number
}

export interface V2EconomicMappingRecord {
  readonly id: string
  readonly denominationId: string
  readonly settlementAssetId: string
  readonly numerator: bigint
  readonly denominator: bigint
  readonly status: string
  readonly version: number
}

export interface V2SpendPolicyRecord {
  readonly id: string
  readonly accountId: string
  readonly version: number
  readonly status: string
  readonly denominationId: string
  readonly maxPerPaymentAtomic: bigint | null
  readonly rollingBudgetAtomic: bigint | null
  readonly rollingWindowSeconds: number | null
  readonly transactionCountCap: number | null
  readonly approvalThresholdAtomic: bigint | null
  readonly rollingBudgetEscalatable: boolean
  readonly transactionCountEscalatable: boolean
}

export interface V2SpendContext {
  readonly confirmedSpendAtomic: bigint
  readonly heldReservationAtomic: bigint
  readonly unresolvedSpendAtomic: bigint
  readonly transactionCount: number
}

export interface V2ApprovedDestinationRecord {
  readonly id: string
  readonly accountId: string
  readonly fingerprint: string
  readonly rail: string
  readonly network: string
  readonly assetReference: string
  readonly destination: string
}

export interface V2PaymentSnapshot {
  readonly id: string
  readonly payerAccountId: string
  readonly correlationId?: string | null
  readonly recipientId: string | null
  readonly recipientManagedAccountId: string | null
  readonly kind: string
  readonly description: string | null
  readonly externalReference: string | null
  readonly metadataJson?: string
  readonly amountAtomic: bigint
  readonly amountScale: number | null
  readonly denominationId: string | null
  readonly currency: string
  readonly status: string
  readonly routeId: string | null
  readonly routeSelectionReason: string | null
  readonly settlementAssetId: string | null
  readonly economicMappingId?: string | null
  readonly destinationSnapshotJson: string | null
  readonly policyDecisionId: string | null
  readonly approvalId: string | null
  readonly executionState: string
  readonly settlementState: string
  readonly outcomeState: string
  readonly rowVersion: number
  readonly originalPaymentId: string | null
  readonly confirmedAt: Date | null
  readonly failedAt: Date | null
  readonly failureCode: string | null
  readonly failureMessageSafe: string | null
  readonly createdAt: Date
  readonly updatedAt: Date
}

export interface V2PaymentAttemptSnapshot {
  readonly id: string
  readonly paymentId: string
  readonly attemptNumber: number
  readonly routeId: string | null
  readonly status: string
  readonly outcome: string
  readonly preparedEffectHash: string | null
  readonly preparedEffectJson?: string | null
  readonly signedPayloadHash: string | null
  readonly signedPayloadEncrypted?: string | null
  readonly expectedExternalId: string | null
  readonly validityExpiresAt: Date | null
  readonly validitySlot: bigint | null
  readonly rowVersion: number
}

export interface V2PaymentView {
  readonly payment: V2PaymentSnapshot
  readonly policyDecision: PaymentPolicyDecision
  readonly reasonCodes: readonly string[]
  readonly approvalState:
    'NOT_REQUIRED' | 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED'
  readonly reservationStatus: 'NONE' | 'HELD' | 'RELEASED' | 'CONSUMED'
  readonly attempts: readonly V2PaymentAttemptSnapshot[]
}

export interface V2PolicyDecisionInput {
  readonly id: string
  readonly paymentId: string
  readonly accountId: string
  readonly policyId: string
  readonly policyVersion: number
  readonly decision: PaymentPolicyDecision
  readonly reasonCodes: readonly string[]
  readonly contextJson: string
  readonly fingerprint: string
}

export interface V2PaymentCreateInput {
  readonly paymentId: string
  readonly reservationId: string
  readonly attemptId: string
  readonly workItemId: string
  readonly idempotencyId: string
  readonly timelineEventId: string
  readonly accountId: string
  readonly operation: 'PAY' | 'SEND' | 'REFUND'
  readonly idempotencyKey: string
  readonly requestHash: string
  readonly requestId?: string
  readonly correlationId?: string
  readonly fingerprint: string
  readonly payerPublicKey: string
  readonly recipientId: string | null
  readonly recipientManagedAccountId?: string | null
  readonly amountAtomic: bigint
  readonly amountScale: number
  readonly denominationId: string
  readonly currency: string
  readonly description?: string
  readonly externalReference?: string
  readonly metadataJson?: string
  readonly originalPaymentId?: string
  readonly route: SettlementRoute | null
  readonly routeSelectionReason: string | null
  readonly destinationSnapshotJson: string
  readonly settlementAssetId: string | null
  readonly economicMappingId: string | null
  readonly destinationFingerprint: string
  readonly policyDecision: V2PolicyDecisionInput
  readonly intentFingerprint?: string
  readonly approval?: {
    readonly id: string
    readonly expiresAt: Date
  }
  readonly settledAtomic: bigint
}

export interface V2PaymentCreateResult {
  readonly payment: V2PaymentSnapshot
  readonly created: boolean
}

export interface V2IdempotencyRecord {
  readonly requestHash: string
  readonly fingerprint: string | null
  readonly resourceId: string
}

export interface V2WorkItemClaim {
  readonly id: string
  readonly kind: string
  readonly resourceType: string
  readonly resourceId: string
  readonly attemptCount: number
  readonly payloadJson: string
  readonly accountId?: string
}

export interface V2DatabaseRepository {
  createDenomination(input: {
    readonly id: string
    readonly symbol: string
    readonly maxScale: number
    readonly version?: number
  }): Promise<V2DenominationRecord>
  findDenomination(id: string): Promise<V2DenominationRecord | null>
  findDenominationBySymbol(symbol: string): Promise<V2DenominationRecord | null>
  findSettlementAsset(id: string): Promise<V2SettlementAssetRecord | null>
  findEconomicMapping(id: string): Promise<V2EconomicMappingRecord | null>
  findSettlementRoute(id: string): Promise<SettlementRoute | null>
  findActiveSpendPolicy(
    accountId: string,
    denominationId: string,
  ): Promise<V2SpendPolicyRecord | null>
  getSpendContext(
    accountId: string,
    denominationId: string,
    now: Date,
    rollingWindowSeconds?: number | null,
  ): Promise<V2SpendContext>
  findApprovedDestination(
    accountId: string,
    fingerprint: string,
  ): Promise<V2ApprovedDestinationRecord | null>
  findAccountPublicKey(accountId: string): Promise<string | null>
  getRefundedAtomic(originalPaymentId: string): Promise<bigint>
  createSettlementAsset(input: {
    readonly id: string
    readonly rail: string
    readonly network: string
    readonly assetReference: string
    readonly decimals: number
    readonly version?: number
  }): Promise<V2SettlementAssetRecord>
  createEconomicMapping(input: {
    readonly id: string
    readonly denominationId: string
    readonly settlementAssetId: string
    readonly numerator: bigint
    readonly denominator: bigint
    readonly version?: number
  }): Promise<void>
  createSettlementRoute(input: SettlementRoute): Promise<void>
  listActiveSettlementRoutes(): Promise<readonly SettlementRoute[]>
  transitionAccount(input: {
    readonly accountId: string
    readonly currentStatus:
      'PROVISIONING' | 'ACTIVE' | 'DISABLED' | 'PROVISIONING_FAILED'
    readonly nextStatus: 'PROVISIONING' | 'ACTIVE' | 'DISABLED' | 'PROVISIONING_FAILED'
    readonly rowVersion: number
    readonly reason?: string
  }): Promise<void>
  createScopedCredential(input: {
    readonly id: string
    readonly accountId: string
    readonly keyHash: string
    readonly keyPrefix: string
    readonly scopes: readonly string[]
    readonly expiresAt?: Date
    readonly rotatedFromId?: string
  }): Promise<void>
  revokeScopedCredential(accountId: string, credentialId: string): Promise<void>
  archiveRecipient(input: {
    readonly ownerAccountId: string
    readonly recipientId: string
    readonly rowVersion: number
  }): Promise<void>
  createApprovedDestination(input: {
    readonly id: string
    readonly accountId: string
    readonly fingerprint: string
    readonly rail: string
    readonly network: string
    readonly assetReference: string
    readonly destination: string
    readonly actorId: string
    readonly reason?: string
  }): Promise<void>
  revokeApprovedDestination(input: {
    readonly accountId: string
    readonly id: string
    readonly actorId: string
    readonly reason: string
  }): Promise<void>
  findV2Idempotency(
    accountId: string,
    idempotencyKey: string,
  ): Promise<V2IdempotencyRecord | null>
  createV2Payment(input: V2PaymentCreateInput): Promise<V2PaymentCreateResult>
  findPayment(accountId: string, paymentId: string): Promise<V2PaymentSnapshot | null>
  findPaymentView(accountId: string, paymentId: string): Promise<V2PaymentView | null>
  listPaymentViews(input: {
    readonly accountId: string
    readonly limit: number
    readonly cursor?: { readonly createdAt: Date; readonly id: string }
    readonly status?: string
    readonly outcomeState?: string
    readonly recipientId?: string
    readonly denominationId?: string
  }): Promise<readonly V2PaymentView[]>
  listPayments(input: {
    readonly accountId: string
    readonly limit: number
    readonly cursor?: { readonly createdAt: Date; readonly id: string }
    readonly status?: string
    readonly recipientId?: string
  }): Promise<readonly V2PaymentSnapshot[]>
  listAttempts(paymentId: string): Promise<readonly V2PaymentAttemptSnapshot[]>
  updateAttemptOutcome(input: {
    readonly attemptId: string
    readonly currentOutcome: string
    readonly nextOutcome: string
    readonly currentRowVersion: number
    readonly status?: string
    readonly externalId?: string
    readonly expectedExternalId?: string
    readonly evidenceId?: string
    readonly preparedEffectHash?: string
    readonly preparedEffectJson?: string | null
    readonly signedPayloadHash?: string
    readonly signedPayloadEncrypted?: string
    readonly validityExpiresAt?: Date
    readonly validitySlot?: bigint
  }): Promise<V2PaymentAttemptSnapshot>
  updatePaymentExecution(input: {
    readonly paymentId: string
    readonly currentRowVersion: number
    readonly status?: string
    readonly executionState?: string
    readonly settlementState?: string
    readonly outcomeState?: string
    readonly confirmedAt?: Date | null
    readonly failedAt?: Date | null
    readonly failureCode?: string | null
    readonly failureMessageSafe?: string | null
  }): Promise<V2PaymentSnapshot>
  abortPreEffectPayment(input: {
    readonly paymentId: string
    readonly attemptId: string
    readonly paymentRowVersion: number
    readonly attemptRowVersion: number
    readonly reason: string
  }): Promise<V2PaymentView>
  createReplacementAttempt(input: {
    readonly paymentId: string
    readonly paymentRowVersion: number
    readonly attemptId: string
    readonly workItemId: string
    readonly route: SettlementRoute
  }): Promise<V2PaymentAttemptSnapshot>
  finalizeV2Payment(input: {
    readonly paymentId: string
    readonly attemptId: string
    readonly paymentRowVersion: number
    readonly attemptRowVersion: number
    readonly currentOutcome: string
    readonly nextOutcome: string
    readonly attemptStatus: string
    readonly paymentStatus: string
    readonly settlementState: string
    readonly outcomeState: string
    readonly externalId?: string
    readonly expectedExternalId?: string
    readonly payloadHash?: string
    readonly metadataJson?: string
    readonly confirmedAt?: Date
    readonly failedAt?: Date
    readonly failureCode?: string
    readonly failureMessageSafe?: string
    readonly reservation: 'CONSUME' | 'RELEASE' | 'NONE'
    readonly evidenceOutcome: string
    readonly source: string
    readonly replacement?: {
      readonly attemptId: string
      readonly workItemId: string
      readonly route: SettlementRoute
      readonly economicMappingId: string
      readonly destinationSnapshotJson: string
    }
  }): Promise<V2PaymentView>
  claimWorkItem(input: {
    readonly kind: string
    readonly owner: string
    readonly leaseSeconds: number
    readonly now?: Date
  }): Promise<V2WorkItemClaim | null>
  completeWorkItem(id: string, owner: string): Promise<void>
  renewWorkItemLease(input: {
    readonly id: string
    readonly owner: string
    readonly leaseSeconds: number
    readonly now?: Date
  }): Promise<Date>
  retryWorkItem(input: {
    readonly id: string
    readonly owner: string
    readonly retryAt: Date
    readonly errorCode: string
    readonly errorSafe: string
    readonly nextKind?: string
  }): Promise<void>
  failWorkItem(input: {
    readonly id: string
    readonly owner: string
    readonly errorCode: string
    readonly errorSafe: string
  }): Promise<void>
  appendTimelineEvent(input: {
    readonly id: string
    readonly accountId?: string
    readonly resourceType: string
    readonly resourceId: string
    readonly eventType: string
    readonly actorType: string
    readonly actorId?: string
    readonly requestId?: string
    readonly correlationId?: string
    readonly oldStateJson?: string
    readonly newStateJson?: string
    readonly source: string
    readonly occurredAt?: Date
    readonly metadataJson?: string
  }): Promise<void>
  recordEvidence(input: {
    readonly id: string
    readonly paymentId: string
    readonly attemptId?: string
    readonly authority: string
    readonly source: string
    readonly outcome: string
    readonly observedAt: Date
    readonly externalId?: string
    readonly expectedExternalId?: string
    readonly payloadHash?: string
    readonly providerCorrelation?: string
    readonly metadataJson?: string
  }): Promise<void>
  openOperationalException(input: {
    readonly id: string
    readonly accountId?: string
    readonly resourceType: string
    readonly resourceId: string
    readonly dedupeKey: string
    readonly reasonCode: string
    readonly severity?: string
    readonly detailsJson?: string
  }): Promise<void>
}

export function createV2DatabaseRepository(prisma: PrismaClient): V2DatabaseRepository {
  return {
    async createDenomination(input) {
      const denomination = await prisma.denomination.create({
        data: {
          id: input.id,
          symbol: input.symbol,
          maxScale: input.maxScale,
          version: input.version ?? 1,
        },
      })
      return denomination
    },

    async findDenomination(id) {
      return prisma.denomination.findUnique({ where: { id } })
    },

    async findDenominationBySymbol(symbol) {
      return prisma.denomination.findFirst({
        where: { symbol, status: 'ACTIVE' },
        orderBy: { version: 'desc' },
      })
    },

    async findSettlementAsset(id) {
      return prisma.settlementAsset.findUnique({ where: { id } })
    },

    async findEconomicMapping(id) {
      return prisma.economicMapping.findUnique({ where: { id } })
    },

    async findSettlementRoute(id) {
      const route = await prisma.settlementRoute.findUnique({ where: { id } })
      return route === null
        ? null
        : {
            id: route.id,
            rail: route.rail,
            railVersion: route.railVersion,
            network: route.network,
            settlementAssetId: route.settlementAssetId,
            economicMappingId: route.economicMappingId,
            status: route.status as SettlementRoute['status'],
            priority: route.priority,
            configVersion: route.configVersion,
          }
    },

    async findActiveSpendPolicy(accountId, denominationId) {
      return prisma.spendPolicy.findFirst({
        where: { accountId, denominationId, status: 'ACTIVE' },
        orderBy: { version: 'desc' },
      })
    },

    async getSpendContext(accountId, denominationId, now, rollingWindowSeconds) {
      const windowStart =
        rollingWindowSeconds === null || rollingWindowSeconds === undefined
          ? new Date(0)
          : new Date(now.getTime() - rollingWindowSeconds * 1000)
      const [confirmed, held, unresolved, transactionCount] = await Promise.all([
        prisma.payment.aggregate({
          where: {
            payerAccountId: accountId,
            denominationId,
            status: 'CONFIRMED',
            createdAt: { gte: windowStart },
          },
          _sum: { amountAtomic: true },
        }),
        prisma.outgoingReservation.aggregate({
          where: {
            ownerAccountId: accountId,
            status: 'ACTIVE',
            lifecycleState: 'HELD',
            payment: { denominationId },
          },
          _sum: { amountAtomic: true },
        }),
        prisma.payment.aggregate({
          where: {
            payerAccountId: accountId,
            denominationId,
            status: { in: ['REVIEW_REQUIRED', 'CLOSED_UNRESOLVED'] },
            createdAt: { gte: windowStart },
          },
          _sum: { amountAtomic: true },
        }),
        prisma.payment.count({
          where: {
            payerAccountId: accountId,
            denominationId,
            createdAt: { gte: windowStart },
            status: { notIn: ['REJECTED_BY_POLICY', 'REJECTED', 'FAILED', 'EXPIRED'] },
          },
        }),
      ])
      return {
        confirmedSpendAtomic: confirmed._sum.amountAtomic ?? 0n,
        heldReservationAtomic: held._sum.amountAtomic ?? 0n,
        unresolvedSpendAtomic: unresolved._sum.amountAtomic ?? 0n,
        transactionCount,
      }
    },

    async findApprovedDestination(accountId, fingerprint) {
      return prisma.approvedDestination.findFirst({
        where: { accountId, fingerprint, status: 'ACTIVE' },
      })
    },

    async findAccountPublicKey(accountId) {
      const account = await prisma.agentAccount.findFirst({
        where: { id: accountId, status: 'ACTIVE' },
        select: { solanaPublicKey: true },
      })
      return account?.solanaPublicKey ?? null
    },

    async getRefundedAtomic(originalPaymentId) {
      const refunds = await prisma.payment.aggregate({
        where: {
          originalPaymentId,
          kind: 'REFUND',
          status: {
            notIn: [
              'FAILED',
              'REJECTED',
              'REJECTED_BY_POLICY',
              'EXPIRED',
              'PROVED_NO_EFFECT',
            ],
          },
        },
        _sum: { amountAtomic: true },
      })
      return refunds._sum.amountAtomic ?? 0n
    },

    async createSettlementAsset(input) {
      return prisma.settlementAsset.create({
        data: {
          id: input.id,
          rail: input.rail,
          network: input.network,
          assetReference: input.assetReference,
          decimals: input.decimals,
          version: input.version ?? 1,
        },
      })
    },

    async createEconomicMapping(input) {
      await prisma.economicMapping.create({
        data: {
          id: input.id,
          denominationId: input.denominationId,
          settlementAssetId: input.settlementAssetId,
          numerator: input.numerator,
          denominator: input.denominator,
          version: input.version ?? 1,
        },
      })
    },

    async createSettlementRoute(input) {
      await prisma.settlementRoute.create({
        data: {
          id: input.id,
          rail: input.rail,
          railVersion: input.railVersion,
          network: input.network,
          settlementAssetId: input.settlementAssetId,
          economicMappingId: input.economicMappingId,
          priority: input.priority,
          configVersion: input.configVersion,
        },
      })
    },

    async listActiveSettlementRoutes() {
      const routes = await prisma.settlementRoute.findMany({
        where: { status: 'ACTIVE' },
        orderBy: [{ priority: 'asc' }, { id: 'asc' }],
      })
      return routes.map((route) => ({
        id: route.id,
        rail: route.rail,
        railVersion: route.railVersion,
        network: route.network,
        settlementAssetId: route.settlementAssetId,
        economicMappingId: route.economicMappingId,
        status: route.status as SettlementRoute['status'],
        priority: route.priority,
        configVersion: route.configVersion,
      }))
    },

    async transitionAccount(input) {
      const result = await prisma.agentAccount.updateMany({
        where: {
          id: input.accountId,
          status: input.currentStatus,
          rowVersion: input.rowVersion,
        },
        data: {
          status: input.nextStatus,
          rowVersion: { increment: 1 },
          ...(input.nextStatus === 'DISABLED'
            ? { disabledAt: new Date(), disabledReason: input.reason ?? null }
            : {}),
          ...(input.nextStatus === 'PROVISIONING_FAILED'
            ? { provisioningFailureCode: input.reason ?? 'PROVISIONING_FAILED' }
            : {}),
        },
      })
      if (result.count !== 1) {
        throw new ConflictError('Account lifecycle changed concurrently')
      }
    },

    async createScopedCredential(input) {
      await prisma.apiCredential.create({
        data: {
          id: input.id,
          accountId: input.accountId,
          keyHash: input.keyHash,
          keyPrefix: input.keyPrefix,
          scopes: JSON.stringify([...input.scopes]),
          ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
          ...(input.rotatedFromId === undefined
            ? {}
            : { rotatedFromId: input.rotatedFromId }),
        },
      })
    },

    async revokeScopedCredential(accountId, credentialId) {
      const result = await prisma.apiCredential.updateMany({
        where: { id: credentialId, accountId, revokedAt: null },
        data: {
          status: 'REVOKED',
          revokedAt: new Date(),
          rowVersion: { increment: 1 },
        },
      })
      if (result.count !== 1)
        throw new NotFoundError('Credential was not found or already revoked')
    },

    async archiveRecipient(input) {
      await prisma.$transaction(async (transaction) => {
        const result = await transaction.recipient.updateMany({
          where: {
            id: input.recipientId,
            ownerAccountId: input.ownerAccountId,
            archivedAt: null,
            rowVersion: input.rowVersion,
          },
          data: { archivedAt: new Date(), rowVersion: { increment: 1 } },
        })
        if (result.count !== 1)
          throw new ConflictError('Recipient changed concurrently or is archived')
        const recipient = await transaction.recipient.findUniqueOrThrow({
          where: { id: input.recipientId },
        })
        await enqueueWebhookEvent(transaction, {
          accountId: recipient.ownerAccountId,
          resourceType: 'RECIPIENT',
          resourceId: recipient.id,
          resourceVersion: recipient.rowVersion,
          eventType: 'recipient.archived',
          resource: {
            id: recipient.id,
            account_id: recipient.ownerAccountId,
            archived_at: recipient.archivedAt?.toISOString() ?? null,
          },
        })
      })
    },

    async createApprovedDestination(input) {
      await prisma.approvedDestination.create({
        data: {
          id: input.id,
          accountId: input.accountId,
          fingerprint: input.fingerprint,
          rail: input.rail,
          network: input.network,
          assetReference: input.assetReference,
          destination: input.destination,
          actorId: input.actorId,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
        },
      })
    },

    async revokeApprovedDestination(input) {
      const result = await prisma.approvedDestination.updateMany({
        where: { id: input.id, accountId: input.accountId, status: 'ACTIVE' },
        data: { status: 'REVOKED', revokedAt: new Date(), reason: input.reason },
      })
      if (result.count !== 1)
        throw new NotFoundError('Approved destination was not found')
    },

    async findV2Idempotency(accountId, idempotencyKey) {
      return prisma.idempotencyRecord.findUnique({
        where: {
          ownerAccountId_operation_key: {
            ownerAccountId: accountId,
            operation: 'V2_PAYMENT',
            key: idempotencyKey,
          },
        },
        select: { requestHash: true, fingerprint: true, resourceId: true },
      })
    },

    async createV2Payment(input) {
      return prisma.$transaction(async (transaction) => {
        const accountRows = await transaction.$queryRaw<
          Array<{ id: string; status: string }>
        >`
          SELECT id, status FROM "agent_accounts" WHERE id = ${input.accountId} FOR UPDATE
        `
        const account = accountRows[0]
        if (account === undefined)
          throw new NotFoundError('Agent account was not found')
        if (account.status !== 'ACTIVE') {
          throw new InvalidStateError('Agent account is not active')
        }
        const existing = await transaction.idempotencyRecord.findUnique({
          where: {
            ownerAccountId_operation_key: {
              ownerAccountId: input.accountId,
              operation: 'V2_PAYMENT',
              key: input.idempotencyKey,
            },
          },
        })
        if (existing !== null) {
          if (
            existing.requestHash !== input.requestHash ||
            existing.fingerprint !== input.fingerprint
          ) {
            throw new IdempotencyConflictError()
          }
          return {
            payment: toV2PaymentSnapshot(
              await transaction.payment.findUniqueOrThrow({
                where: { id: existing.resourceId },
              }),
            ),
            created: false,
          }
        }

        const currentPolicy = await transaction.spendPolicy.findUnique({
          where: { id: input.policyDecision.policyId },
        })
        const currentDenomination = await transaction.denomination.findUnique({
          where: { id: input.denominationId },
        })
        if (
          currentPolicy === null ||
          currentPolicy.accountId !== input.accountId ||
          currentPolicy.denominationId !== input.denominationId ||
          currentPolicy.status !== 'ACTIVE' ||
          currentPolicy.version !== input.policyDecision.policyVersion ||
          currentDenomination === null
        ) {
          throw new ConflictError('Spend policy changed while creating the payment')
        }
        const denomination = createDenomination({
          id: currentDenomination.id,
          symbol: currentDenomination.symbol,
          maxScale: currentDenomination.maxScale,
          status: currentDenomination.status as 'ACTIVE' | 'RETIRED',
          version: currentDenomination.version,
        })
        const policy: SpendPolicy = {
          id: currentPolicy.id,
          accountId: currentPolicy.accountId,
          version: currentPolicy.version,
          status: currentPolicy.status as SpendPolicy['status'],
          maxPerPayment:
            currentPolicy.maxPerPaymentAtomic === null
              ? null
              : exactMoneyFromAtomicUnits(
                  currentPolicy.maxPerPaymentAtomic,
                  denomination,
                ),
          rollingBudget:
            currentPolicy.rollingBudgetAtomic === null
              ? null
              : exactMoneyFromAtomicUnits(
                  currentPolicy.rollingBudgetAtomic,
                  denomination,
                ),
          rollingWindowSeconds: currentPolicy.rollingWindowSeconds,
          transactionCountCap: currentPolicy.transactionCountCap,
          approvalThreshold:
            currentPolicy.approvalThresholdAtomic === null
              ? null
              : exactMoneyFromAtomicUnits(
                  currentPolicy.approvalThresholdAtomic,
                  denomination,
                ),
          rollingBudgetEscalatable: currentPolicy.rollingBudgetEscalatable,
          transactionCountEscalatable: currentPolicy.transactionCountEscalatable,
        }
        const windowStart =
          currentPolicy.rollingWindowSeconds === null
            ? new Date(0)
            : new Date(Date.now() - currentPolicy.rollingWindowSeconds * 1_000)
        const [confirmed, held, unresolved, transactionCount, approvedDestination] =
          await Promise.all([
            transaction.payment.aggregate({
              where: {
                payerAccountId: input.accountId,
                denominationId: input.denominationId,
                status: 'CONFIRMED',
                createdAt: { gte: windowStart },
              },
              _sum: { amountAtomic: true },
            }),
            transaction.outgoingReservation.aggregate({
              where: {
                ownerAccountId: input.accountId,
                status: 'ACTIVE',
                lifecycleState: 'HELD',
                payment: { denominationId: input.denominationId },
              },
              _sum: { amountAtomic: true },
            }),
            transaction.payment.aggregate({
              where: {
                payerAccountId: input.accountId,
                denominationId: input.denominationId,
                status: { in: ['REVIEW_REQUIRED', 'CLOSED_UNRESOLVED'] },
                createdAt: { gte: windowStart },
              },
              _sum: { amountAtomic: true },
            }),
            transaction.payment.count({
              where: {
                payerAccountId: input.accountId,
                denominationId: input.denominationId,
                createdAt: { gte: windowStart },
                status: {
                  notIn: ['REJECTED_BY_POLICY', 'REJECTED', 'FAILED', 'EXPIRED'],
                },
              },
            }),
            transaction.approvedDestination.findFirst({
              where: {
                accountId: input.accountId,
                fingerprint: input.destinationFingerprint,
                status: 'ACTIVE',
              },
            }),
          ])
        const currentDecision = evaluateSpendPolicy({
          policy,
          amount: exactMoneyFromAtomicUnits(input.amountAtomic, denomination),
          destinationApproved: approvedDestination !== null,
          confirmedSpend: exactMoneyFromAtomicUnits(
            confirmed._sum.amountAtomic ?? 0n,
            denomination,
          ),
          heldReservations: exactMoneyFromAtomicUnits(
            held._sum.amountAtomic ?? 0n,
            denomination,
          ),
          unresolvedSpend: exactMoneyFromAtomicUnits(
            unresolved._sum.amountAtomic ?? 0n,
            denomination,
          ),
          transactionCount,
        })
        const currentContextJson = JSON.stringify({
          confirmed_spend_atomic:
            currentDecision.context.confirmedSpend.atomicUnits.toString(),
          held_reservation_atomic:
            currentDecision.context.heldReservations.atomicUnits.toString(),
          unresolved_spend_atomic:
            currentDecision.context.unresolvedSpend.atomicUnits.toString(),
          transaction_count: currentDecision.context.transactionCount,
        })
        if (
          currentDecision.decision !== input.policyDecision.decision ||
          JSON.stringify(currentDecision.reasonCodes) !==
            JSON.stringify(input.policyDecision.reasonCodes) ||
          currentContextJson !== input.policyDecision.contextJson
        ) {
          throw new ConflictError(
            'Spend policy decision changed while creating the payment',
          )
        }

        if (input.operation === 'REFUND' && input.originalPaymentId === undefined) {
          throw new InvalidStateError(
            'Refund payment must reference an original payment',
          )
        }
        if (input.operation !== 'REFUND' && input.originalPaymentId !== undefined) {
          throw new InvalidStateError(
            'Only refund payments may reference an original payment',
          )
        }
        if (input.originalPaymentId !== undefined) {
          const originalRows = await transaction.$queryRaw<
            Array<{ amount_atomic: bigint; status: string; kind: string }>
          >`
            SELECT amount_atomic, status, kind
            FROM "payments"
            WHERE id = ${input.originalPaymentId}
            FOR UPDATE
          `
          const original = originalRows[0]
          if (
            original === undefined ||
            original.status !== 'CONFIRMED' ||
            original.kind === 'REFUND'
          ) {
            throw new InvalidStateError('Original payment is not refundable')
          }
          const refunded = await transaction.payment.aggregate({
            where: {
              originalPaymentId: input.originalPaymentId,
              kind: 'REFUND',
              status: {
                notIn: [
                  'FAILED',
                  'REJECTED',
                  'REJECTED_BY_POLICY',
                  'EXPIRED',
                  'PROVED_NO_EFFECT',
                ],
              },
            },
            _sum: { amountAtomic: true },
          })
          if (
            input.amountAtomic + (refunded._sum.amountAtomic ?? 0n) >
            original.amount_atomic
          ) {
            throw new ConflictError('Refund amount exceeds the original payment amount')
          }
        }

        const decision = input.policyDecision.decision
        if (
          decision === 'ALLOW' &&
          (input.route === null || input.settlementAssetId === null)
        ) {
          throw new InvalidStateError(
            'An allowed payment must have a selected settlement route',
          )
        }
        if (decision === 'ALLOW') {
          const reservations = await transaction.outgoingReservation.aggregate({
            where: {
              ownerAccountId: input.accountId,
              status: 'ACTIVE',
              lifecycleState: 'HELD',
              payment: { denominationId: input.denominationId },
            },
            _sum: { amountAtomic: true },
          })
          const reservedAtomic = reservations._sum.amountAtomic ?? 0n
          if (input.amountAtomic > input.settledAtomic - reservedAtomic) {
            throw new InsufficientFundsError()
          }
        }

        const status =
          decision === 'DENY'
            ? 'REJECTED_BY_POLICY'
            : input.approval === undefined
              ? 'ROUTING'
              : 'AWAITING_APPROVAL'
        const payment = await transaction.payment.create({
          data: {
            id: input.paymentId,
            payerAccountId: input.accountId,
            ...(input.correlationId === undefined
              ? {}
              : { correlationId: input.correlationId }),
            payerPublicKey: input.payerPublicKey,
            recipientId: input.recipientId,
            ...(input.recipientManagedAccountId === undefined
              ? {}
              : { recipientManagedAccountId: input.recipientManagedAccountId }),
            kind: input.operation,
            amountAtomic: input.amountAtomic,
            amountScale: input.amountScale,
            denominationId: input.denominationId,
            currency: input.currency,
            status,
            ...(input.route === null ? {} : { route: input.route.rail }),
            ...(input.route === null ? {} : { routeId: input.route.id }),
            ...(decision === 'DENY'
              ? {}
              : { routeSelectionReason: input.routeSelectionReason }),
            ...(input.settlementAssetId === null
              ? {}
              : { settlementAssetId: input.settlementAssetId }),
            ...(input.economicMappingId === null
              ? {}
              : { economicMappingId: input.economicMappingId }),
            destinationSnapshotJson: input.destinationSnapshotJson,
            ...(input.intentFingerprint === undefined
              ? {}
              : { intentFingerprint: input.intentFingerprint }),
            policyDecisionId: input.policyDecision.id,
            ...(input.approval === undefined ? {} : { approvalId: input.approval.id }),
            executionState: decision === 'ALLOW' ? 'QUEUED' : 'NOT_STARTED',
            settlementState: 'NOT_SUBMITTED',
            outcomeState: decision === 'DENY' ? 'PROVED_NO_EFFECT' : 'NONE',
            ...(input.description === undefined
              ? {}
              : { description: input.description }),
            ...(input.externalReference === undefined
              ? {}
              : { externalReference: input.externalReference }),
            metadataJson: input.metadataJson ?? '{}',
            ...(input.originalPaymentId === undefined
              ? {}
              : { originalPaymentId: input.originalPaymentId }),
          },
        })
        await transaction.policyDecision.create({
          data: {
            id: input.policyDecision.id,
            paymentId: payment.id,
            accountId: input.accountId,
            policyId: input.policyDecision.policyId,
            policyVersion: input.policyDecision.policyVersion,
            decision,
            reasonCodesJson: JSON.stringify(input.policyDecision.reasonCodes),
            contextJson: input.policyDecision.contextJson,
            fingerprint: input.policyDecision.fingerprint,
          },
        })
        if (input.approval !== undefined) {
          await transaction.approval.create({
            data: {
              id: input.approval.id,
              paymentId: payment.id,
              accountId: input.accountId,
              fingerprint: input.intentFingerprint ?? input.fingerprint,
              policyDecisionId: input.policyDecision.id,
              expiresAt: input.approval.expiresAt,
            },
          })
        }
        if (decision === 'ALLOW') {
          await transaction.outgoingReservation.create({
            data: {
              id: input.reservationId,
              paymentId: payment.id,
              ownerAccountId: input.accountId,
              amountAtomic: input.amountAtomic,
              currency: input.currency,
              lifecycleState: 'HELD',
            },
          })
          await transaction.paymentAttempt.create({
            data: {
              id: input.attemptId,
              paymentId: payment.id,
              attemptNumber: 1,
              rail: input.route?.rail ?? 'UNSELECTED',
              routeId: input.route?.id ?? null,
              status: 'CREATED',
              outcome: 'NOT_STARTED',
            },
          })
          await transaction.durableWorkItem.create({
            data: {
              id: input.workItemId,
              kind: 'OUTGOING_PAYMENT',
              resourceType: 'PAYMENT',
              resourceId: payment.id,
              payloadJson: JSON.stringify({
                payment_id: payment.id,
                ...(input.correlationId === undefined
                  ? {}
                  : { correlation_id: input.correlationId }),
              }),
            },
          })
        }
        await transaction.idempotencyRecord.create({
          data: {
            id: input.idempotencyId,
            ownerAccountId: input.accountId,
            operation: 'V2_PAYMENT',
            key: input.idempotencyKey,
            requestHash: input.requestHash,
            fingerprint: input.fingerprint,
            resourceId: payment.id,
            responseSnapshot: JSON.stringify({ payment_id: payment.id, status }),
          },
        })
        await transaction.operationTimelineEvent.create({
          data: {
            id: input.timelineEventId,
            accountId: input.accountId,
            resourceType: 'PAYMENT',
            resourceId: payment.id,
            eventType: 'PAYMENT_CREATED',
            actorType: 'AGENT_CREDENTIAL',
            actorId: input.accountId,
            ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
            ...(input.correlationId === undefined
              ? {}
              : { correlationId: input.correlationId }),
            source: 'V2_PAYMENT_ORCHESTRATOR',
            occurredAt: payment.createdAt,
            newStateJson: JSON.stringify({ status, policy_decision: decision }),
          },
        })
        await enqueuePaymentWebhookEvent(transaction, {
          accountId: input.accountId,
          paymentId: payment.id,
          resourceVersion: payment.rowVersion,
          eventType: 'payment.created',
          status,
          amountAtomic: payment.amountAtomic,
          denominationId: payment.denominationId,
          ...(payment.correlationId === null
            ? {}
            : { correlationId: payment.correlationId }),
        })
        return { payment: toV2PaymentSnapshot(payment), created: true }
      })
    },

    async findPayment(accountId, paymentId) {
      const payment = await prisma.payment.findFirst({
        where: { id: paymentId, payerAccountId: accountId },
      })
      return payment === null ? null : toV2PaymentSnapshot(payment)
    },

    async findPaymentView(accountId, paymentId) {
      const payment = await prisma.payment.findFirst({
        where: { id: paymentId, payerAccountId: accountId },
      })
      return payment === null ? null : loadPaymentView(prisma, payment, accountId)
    },

    async listPaymentViews(input) {
      const payments = await prisma.payment.findMany({
        where: {
          payerAccountId: input.accountId,
          ...(input.status === undefined ? {} : { status: input.status as never }),
          ...(input.outcomeState === undefined
            ? {}
            : { outcomeState: input.outcomeState }),
          ...(input.recipientId === undefined
            ? {}
            : { recipientId: input.recipientId }),
          ...(input.denominationId === undefined
            ? {}
            : { denominationId: input.denominationId }),
          ...(input.cursor === undefined
            ? {}
            : {
                OR: [
                  { createdAt: { lt: input.cursor.createdAt } },
                  { createdAt: input.cursor.createdAt, id: { lt: input.cursor.id } },
                ],
              }),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: input.limit,
      })
      return Promise.all(
        payments.map((payment) => loadPaymentView(prisma, payment, input.accountId)),
      )
    },

    async listPayments(input) {
      const payments = await prisma.payment.findMany({
        where: {
          payerAccountId: input.accountId,
          ...(input.status === undefined ? {} : { status: input.status as never }),
          ...(input.recipientId === undefined
            ? {}
            : { recipientId: input.recipientId }),
          ...(input.cursor === undefined
            ? {}
            : {
                OR: [
                  { createdAt: { lt: input.cursor.createdAt } },
                  { createdAt: input.cursor.createdAt, id: { lt: input.cursor.id } },
                ],
              }),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: input.limit,
      })
      return payments.map(toV2PaymentSnapshot)
    },

    async listAttempts(paymentId) {
      const attempts = await prisma.paymentAttempt.findMany({
        where: { paymentId },
        orderBy: { attemptNumber: 'asc' },
      })
      return attempts.map(toV2AttemptSnapshot)
    },

    async updateAttemptOutcome(input) {
      const result = await prisma.paymentAttempt.updateMany({
        where: {
          id: input.attemptId,
          outcome: input.currentOutcome,
          rowVersion: input.currentRowVersion,
        },
        data: {
          outcome: input.nextOutcome,
          rowVersion: { increment: 1 },
          ...(input.status === undefined ? {} : { status: input.status as never }),
          ...(input.externalId === undefined
            ? {}
            : { railTransactionId: input.externalId }),
          ...(input.expectedExternalId === undefined
            ? {}
            : { expectedExternalId: input.expectedExternalId }),
          ...(input.preparedEffectHash === undefined
            ? {}
            : { preparedEffectHash: input.preparedEffectHash }),
          ...(input.preparedEffectJson === undefined
            ? {}
            : { preparedEffectJson: input.preparedEffectJson }),
          ...(input.signedPayloadHash === undefined
            ? {}
            : { signedPayloadHash: input.signedPayloadHash }),
          ...(input.signedPayloadEncrypted === undefined
            ? {}
            : { signedPayloadEncrypted: input.signedPayloadEncrypted }),
          ...(input.validityExpiresAt === undefined
            ? {}
            : { validityExpiresAt: input.validityExpiresAt }),
          ...(input.validitySlot === undefined
            ? {}
            : { validitySlot: input.validitySlot }),
        },
      })
      if (result.count !== 1)
        throw new ConflictError('Payment attempt changed concurrently')
      return toV2AttemptSnapshot(
        await prisma.paymentAttempt.findUniqueOrThrow({
          where: { id: input.attemptId },
        }),
      )
    },

    async updatePaymentExecution(input) {
      if (
        input.executionState !== 'RECONCILING' ||
        (input.settlementState !== 'SUBMITTED' && input.settlementState !== 'UNKNOWN')
      ) {
        throw new InvalidStateError(
          'Payment execution updates must represent a submitted or unknown settlement',
        )
      }
      if (
        input.settlementState === 'UNKNOWN' &&
        input.outcomeState !== 'UNDETERMINED'
      ) {
        throw new InvalidStateError(
          'An unknown settlement must have an undetermined outcome',
        )
      }
      const payment = await prisma.payment.findUnique({
        where: { id: input.paymentId },
      })
      if (payment === null) throw new NotFoundError('Payment was not found')
      const [policyDecision, approval, attempts] = await Promise.all([
        prisma.policyDecision.findUnique({ where: { paymentId: payment.id } }),
        prisma.approval.findUnique({ where: { paymentId: payment.id } }),
        prisma.paymentAttempt.findMany({
          where: { paymentId: payment.id },
          orderBy: { attemptNumber: 'asc' },
          select: { outcome: true },
        }),
      ])
      const projectedStatus = projectPaymentStatus({
        policyDecision:
          policyDecision === null
            ? legacyPolicyDecision(payment.status)
            : parsePolicyDecision(policyDecision.decision),
        approvalState: projectApprovalState(approval),
        attemptOutcomes: attempts.map((attempt) => asAttemptOutcome(attempt.outcome)),
        planExhausted: false,
        executionStarted: true,
      })
      if (input.status !== undefined && projectedStatus !== input.status) {
        throw new InvalidStateError(
          'Payment status does not match the durable execution projection',
        )
      }
      const result = await prisma.payment.updateMany({
        where: { id: input.paymentId, rowVersion: input.currentRowVersion },
        data: {
          rowVersion: { increment: 1 },
          status: projectedStatus,
          ...(input.executionState === undefined
            ? {}
            : { executionState: input.executionState }),
          ...(input.settlementState === undefined
            ? {}
            : { settlementState: input.settlementState }),
          ...(input.outcomeState === undefined
            ? {}
            : { outcomeState: input.outcomeState }),
          ...(input.confirmedAt === undefined
            ? {}
            : { confirmedAt: input.confirmedAt }),
          ...(input.failedAt === undefined ? {} : { failedAt: input.failedAt }),
          ...(input.failureCode === undefined
            ? {}
            : { failureCode: input.failureCode }),
          ...(input.failureMessageSafe === undefined
            ? {}
            : { failureMessageSafe: input.failureMessageSafe }),
        },
      })
      if (result.count !== 1) throw new ConflictError('Payment changed concurrently')
      return toV2PaymentSnapshot(
        await prisma.payment.findUniqueOrThrow({ where: { id: input.paymentId } }),
      )
    },

    async abortPreEffectPayment(input) {
      return prisma.$transaction(async (transaction) => {
        const payment = await transaction.payment.findUnique({
          where: { id: input.paymentId },
        })
        if (payment === null) throw new NotFoundError('Payment was not found')
        const attempt = await transaction.paymentAttempt.findUnique({
          where: { id: input.attemptId },
        })
        if (attempt === null || attempt.paymentId !== payment.id) {
          throw new NotFoundError('Payment attempt was not found')
        }
        if (
          payment.rowVersion !== input.paymentRowVersion ||
          attempt.rowVersion !== input.attemptRowVersion
        ) {
          throw new ConflictError('Payment changed concurrently')
        }
        if (attempt.outcome === 'NOT_STARTED') {
          assertAttemptProgression('NOT_STARTED', 'PRE_EFFECT_ABORTED')
          await transaction.paymentAttempt.update({
            where: { id: attempt.id },
            data: {
              outcome: 'PRE_EFFECT_ABORTED',
              status: 'FAILED',
              rowVersion: { increment: 1 },
            },
          })
        } else if (attempt.outcome !== 'PRE_EFFECT_ABORTED') {
          throw new ConflictError('Payment attempt may already have an effect')
        }
        await transaction.payment.update({
          where: { id: payment.id },
          data: {
            status: 'PROVED_NO_EFFECT',
            executionState: 'TERMINAL',
            settlementState: 'NOT_SUBMITTED',
            outcomeState: 'PROVED_NO_EFFECT',
            rowVersion: { increment: 1 },
          },
        })
        await transaction.outgoingReservation.updateMany({
          where: { paymentId: payment.id, status: 'ACTIVE', lifecycleState: 'HELD' },
          data: {
            status: 'RELEASED',
            lifecycleState: 'RELEASED',
            releaseReason: input.reason,
            releasedAt: new Date(),
            rowVersion: { increment: 1 },
          },
        })
        await transaction.evidenceRecord.create({
          data: {
            id: `evidence_${randomId()}`,
            paymentId: payment.id,
            attemptId: attempt.id,
            authority: 'LOCAL_STATE',
            source: 'ACCOUNT_LIFECYCLE',
            outcome: 'PROVED_NO_EFFECT',
            observedAt: new Date(),
            metadataJson: JSON.stringify({ reason: input.reason }),
          },
        })
        await transaction.operationTimelineEvent.create({
          data: {
            id: `timeline_${randomId()}`,
            accountId: payment.payerAccountId,
            resourceType: 'PAYMENT',
            resourceId: payment.id,
            eventType: 'PAYMENT_PRE_EFFECT_ABORTED',
            actorType: 'SYSTEM',
            source: 'V2_OUTGOING_WORKER',
            occurredAt: new Date(),
            ...(payment.correlationId === null
              ? {}
              : { correlationId: payment.correlationId }),
            newStateJson: JSON.stringify({
              status: 'PROVED_NO_EFFECT',
              reason: input.reason,
            }),
          },
        })
        const updated = await transaction.payment.findUniqueOrThrow({
          where: { id: payment.id },
        })
        await enqueuePaymentWebhookEvent(transaction, {
          accountId: payment.payerAccountId,
          paymentId: payment.id,
          resourceVersion: updated.rowVersion,
          eventType: 'payment.updated',
          status: updated.status,
          amountAtomic: updated.amountAtomic,
          denominationId: updated.denominationId,
          ...(updated.correlationId === null
            ? {}
            : { correlationId: updated.correlationId }),
        })
        const decision = await transaction.policyDecision.findUniqueOrThrow({
          where: { paymentId: payment.id },
        })
        const approval = await transaction.approval.findUnique({
          where: { paymentId: payment.id },
        })
        const reservation = await transaction.outgoingReservation.findUnique({
          where: { paymentId: payment.id },
        })
        const attempts = await transaction.paymentAttempt.findMany({
          where: { paymentId: payment.id },
          orderBy: { attemptNumber: 'asc' },
        })
        return {
          payment: toV2PaymentSnapshot(updated),
          policyDecision: parsePolicyDecision(decision.decision),
          reasonCodes: parseStringArray(
            decision.reasonCodesJson,
            'policy reason codes',
          ),
          approvalState: projectApprovalState(approval),
          reservationStatus: projectReservationStatus(reservation),
          attempts: attempts.map(toV2AttemptSnapshot),
        }
      })
    },

    async createReplacementAttempt(input) {
      return prisma.$transaction(async (transaction) => {
        const payment = await transaction.payment.findUniqueOrThrow({
          where: { id: input.paymentId },
        })
        if (payment.rowVersion !== input.paymentRowVersion)
          throw new ConflictError('Payment changed concurrently')
        const attempts = await transaction.paymentAttempt.findMany({
          where: { paymentId: payment.id },
          orderBy: { attemptNumber: 'asc' },
        })
        if (
          attempts.some(
            (attempt) =>
              !['PROVED_NO_EFFECT', 'PRE_EFFECT_ABORTED'].includes(attempt.outcome),
          )
        ) {
          throw new ConflictError(
            'Replacement attempt is unsafe while an earlier attempt may have an effect',
          )
        }
        const attempt = await transaction.paymentAttempt.create({
          data: {
            id: input.attemptId,
            paymentId: payment.id,
            attemptNumber: attempts.length + 1,
            rail: input.route.rail,
            routeId: input.route.id,
            status: 'CREATED',
            outcome: 'NOT_STARTED',
          },
        })
        await transaction.payment.update({
          where: { id: payment.id },
          data: {
            status: 'ROUTING',
            executionState: 'QUEUED',
            rowVersion: { increment: 1 },
          },
        })
        await transaction.durableWorkItem.create({
          data: {
            id: input.workItemId,
            kind: 'OUTGOING_PAYMENT_ATTEMPT',
            resourceType: 'PAYMENT_ATTEMPT',
            resourceId: attempt.id,
            payloadJson: JSON.stringify({
              payment_id: payment.id,
              attempt_id: attempt.id,
              ...(payment.correlationId === null
                ? {}
                : { correlation_id: payment.correlationId }),
            }),
          },
        })
        return toV2AttemptSnapshot(attempt)
      })
    },

    async finalizeV2Payment(input) {
      return prisma.$transaction(async (transaction) => {
        const payment = await transaction.payment.findUniqueOrThrow({
          where: { id: input.paymentId },
        })
        const attempt = await transaction.paymentAttempt.findUniqueOrThrow({
          where: { id: input.attemptId },
        })
        if (attempt.paymentId !== payment.id) {
          throw new ConflictError('Payment attempt does not belong to the payment')
        }
        if (
          payment.rowVersion !== input.paymentRowVersion ||
          attempt.rowVersion !== input.attemptRowVersion ||
          attempt.outcome !== input.currentOutcome
        ) {
          throw new ConflictError('Payment terminalization changed concurrently')
        }
        if (
          input.replacement !== undefined &&
          (input.nextOutcome !== 'PROVED_NO_EFFECT' || input.reservation !== 'NONE')
        ) {
          throw new InvalidStateError(
            'A replacement attempt requires proved no-effect evidence while its reservation remains held',
          )
        }
        if (input.replacement !== undefined) {
          const route = await transaction.settlementRoute.findUnique({
            where: { id: input.replacement.route.id },
          })
          const asset = await transaction.settlementAsset.findUnique({
            where: { id: input.replacement.route.settlementAssetId },
          })
          const mapping = await transaction.economicMapping.findUnique({
            where: { id: input.replacement.economicMappingId },
          })
          if (
            route === null ||
            route.status !== 'ACTIVE' ||
            route.rail !== input.replacement.route.rail ||
            route.network !== input.replacement.route.network ||
            route.settlementAssetId !== input.replacement.route.settlementAssetId ||
            route.economicMappingId !== input.replacement.economicMappingId ||
            asset === null ||
            asset.status !== 'ACTIVE' ||
            mapping === null ||
            mapping.status !== 'ACTIVE' ||
            mapping.denominationId !== payment.denominationId ||
            mapping.settlementAssetId !== asset.id
          ) {
            throw new ConflictError('Replacement settlement route is no longer active')
          }
        }
        const derivedPaymentStatus =
          input.replacement !== undefined
            ? 'ROUTING'
            : input.nextOutcome === 'CONFIRMED'
              ? 'CONFIRMED'
              : input.nextOutcome === 'PROVED_NO_EFFECT'
                ? 'PROVED_NO_EFFECT'
                : input.nextOutcome === 'FAILED'
                  ? 'FAILED'
                  : null
        if (
          derivedPaymentStatus === null ||
          input.paymentStatus !== derivedPaymentStatus
        ) {
          throw new InvalidStateError(
            'Payment status does not match the durable attempt outcome',
          )
        }
        assertTerminalDimensionConsistency({
          nextOutcome: input.nextOutcome,
          replacement: input.replacement !== undefined,
          settlementState: input.settlementState,
          outcomeState: input.outcomeState,
        })
        assertAttemptProgression(
          input.currentOutcome as Parameters<typeof assertAttemptProgression>[0],
          input.nextOutcome as Parameters<typeof assertAttemptProgression>[1],
        )
        await transaction.paymentAttempt.update({
          where: { id: input.attemptId },
          data: {
            outcome: input.nextOutcome,
            status: input.attemptStatus as never,
            rowVersion: { increment: 1 },
            ...(input.externalId === undefined
              ? {}
              : { railTransactionId: input.externalId }),
          },
        })
        await transaction.payment.update({
          where: { id: input.paymentId },
          data:
            input.replacement === undefined
              ? {
                  status: derivedPaymentStatus as never,
                  executionState: 'TERMINAL',
                  settlementState: input.settlementState,
                  outcomeState: input.outcomeState,
                  rowVersion: { increment: 1 },
                  ...(input.externalId === undefined ? {} : { failureCode: null }),
                  ...(input.confirmedAt === undefined
                    ? {}
                    : { confirmedAt: input.confirmedAt }),
                  ...(input.failedAt === undefined ? {} : { failedAt: input.failedAt }),
                  ...(input.failureCode === undefined
                    ? {}
                    : { failureCode: input.failureCode }),
                  ...(input.failureMessageSafe === undefined
                    ? {}
                    : { failureMessageSafe: input.failureMessageSafe }),
                }
              : {
                  status: 'ROUTING',
                  executionState: 'QUEUED',
                  settlementState: 'NOT_SUBMITTED',
                  outcomeState: 'NONE',
                  route: input.replacement.route.rail,
                  routeId: input.replacement.route.id,
                  routeSelectionReason: 'FALLBACK_AFTER_PROVED_NO_EFFECT',
                  settlementAssetId: input.replacement.route.settlementAssetId,
                  economicMappingId: input.replacement.economicMappingId,
                  destinationSnapshotJson: input.replacement.destinationSnapshotJson,
                  rowVersion: { increment: 1 },
                },
        })
        if (input.reservation !== 'NONE') {
          await transaction.outgoingReservation.updateMany({
            where: {
              paymentId: input.paymentId,
              status: 'ACTIVE',
              lifecycleState: 'HELD',
            },
            data: {
              status: input.reservation === 'CONSUME' ? 'ACTIVE' : 'RELEASED',
              lifecycleState: input.reservation === 'CONSUME' ? 'CONSUMED' : 'RELEASED',
              ...(input.reservation === 'CONSUME'
                ? { consumedAt: new Date() }
                : {
                    releaseReason: input.failureCode ?? input.evidenceOutcome,
                    releasedAt: new Date(),
                  }),
              rowVersion: { increment: 1 },
            },
          })
        }
        await transaction.evidenceRecord.create({
          data: {
            id: `evidence_${randomId()}`,
            paymentId: input.paymentId,
            attemptId: input.attemptId,
            authority: 'RAIL',
            source: input.source,
            outcome: input.evidenceOutcome,
            observedAt: new Date(),
            ...(input.externalId === undefined ? {} : { externalId: input.externalId }),
            ...(input.expectedExternalId === undefined
              ? {}
              : { expectedExternalId: input.expectedExternalId }),
            ...(input.payloadHash === undefined
              ? {}
              : { payloadHash: input.payloadHash }),
            metadataJson: input.metadataJson ?? '{}',
          },
        })
        if (input.replacement !== undefined) {
          const replacementAttempt = await transaction.paymentAttempt.create({
            data: {
              id: input.replacement.attemptId,
              paymentId: input.paymentId,
              attemptNumber: attempt.attemptNumber + 1,
              rail: input.replacement.route.rail,
              routeId: input.replacement.route.id,
              status: 'CREATED',
              outcome: 'NOT_STARTED',
            },
          })
          await transaction.durableWorkItem.create({
            data: {
              id: input.replacement.workItemId,
              kind: 'OUTGOING_PAYMENT_ATTEMPT',
              resourceType: 'PAYMENT_ATTEMPT',
              resourceId: replacementAttempt.id,
              payloadJson: JSON.stringify({
                payment_id: input.paymentId,
                attempt_id: replacementAttempt.id,
                ...(payment.correlationId === null
                  ? {}
                  : { correlation_id: payment.correlationId }),
              }),
            },
          })
        }
        await transaction.operationTimelineEvent.create({
          data: {
            id: `timeline_${randomId()}`,
            accountId: payment.payerAccountId,
            resourceType: 'PAYMENT',
            resourceId: payment.id,
            eventType:
              input.replacement === undefined
                ? 'PAYMENT_TERMINALIZED'
                : 'PAYMENT_FALLBACK_PLANNED',
            actorType: 'SYSTEM',
            source: input.source,
            occurredAt: new Date(),
            ...(payment.correlationId === null
              ? {}
              : { correlationId: payment.correlationId }),
            oldStateJson: JSON.stringify({
              payment_status: payment.status,
              attempt_outcome: input.currentOutcome,
            }),
            newStateJson: JSON.stringify({
              payment_status: derivedPaymentStatus,
              attempt_outcome: input.nextOutcome,
              ...(input.replacement === undefined
                ? {}
                : { replacement_attempt_id: input.replacement.attemptId }),
            }),
          },
        })
        const updated = await transaction.payment.findUniqueOrThrow({
          where: { id: input.paymentId },
        })
        await enqueuePaymentWebhookEvent(transaction, {
          accountId: updated.payerAccountId,
          paymentId: updated.id,
          resourceVersion: updated.rowVersion,
          eventType: 'payment.updated',
          status: updated.status,
          amountAtomic: updated.amountAtomic,
          denominationId: updated.denominationId,
          ...(updated.correlationId === null
            ? {}
            : { correlationId: updated.correlationId }),
        })
        const decision = await transaction.policyDecision.findUniqueOrThrow({
          where: { paymentId: input.paymentId },
        })
        const approval = await transaction.approval.findUnique({
          where: { paymentId: input.paymentId },
        })
        const reservation = await transaction.outgoingReservation.findUnique({
          where: { paymentId: input.paymentId },
        })
        const attempts = await transaction.paymentAttempt.findMany({
          where: { paymentId: input.paymentId },
          orderBy: { attemptNumber: 'asc' },
        })
        return {
          payment: toV2PaymentSnapshot(updated),
          policyDecision: parsePolicyDecision(decision.decision),
          reasonCodes: parseStringArray(
            decision.reasonCodesJson,
            'policy reason codes',
          ),
          approvalState: projectApprovalState(approval),
          reservationStatus: projectReservationStatus(reservation),
          attempts: attempts.map(toV2AttemptSnapshot),
        }
      })
    },

    async claimWorkItem(input) {
      if (input.leaseSeconds <= 0) throw new InvalidStateError('Lease must be positive')
      const now = input.now ?? new Date()
      return prisma.$transaction(async (transaction) => {
        const rows = await transaction.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM "durable_work_items"
          WHERE kind = ${input.kind}
            AND (status = 'AVAILABLE' OR status = 'RETRY_WAIT' OR (status = 'CLAIMED' AND lease_expires_at <= ${now}))
            AND attempt_count < max_attempts
            AND available_at <= ${now}
          ORDER BY available_at ASC, id ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        `
        const row = rows[0]
        if (row === undefined) return null
        const leaseExpiresAt = new Date(now.getTime() + input.leaseSeconds * 1000)
        const item = await transaction.durableWorkItem.update({
          where: { id: row.id },
          data: {
            status: 'CLAIMED',
            leaseOwner: input.owner,
            leaseExpiresAt,
            attemptCount: { increment: 1 },
          },
        })
        const accountId = await resolveWorkAccountId(
          transaction,
          item.resourceType,
          item.resourceId,
        )
        return {
          id: item.id,
          kind: item.kind,
          resourceType: item.resourceType,
          resourceId: item.resourceId,
          attemptCount: item.attemptCount,
          payloadJson: item.payloadJson,
          ...(accountId === undefined ? {} : { accountId }),
        }
      })
    },

    async completeWorkItem(id, owner) {
      const result = await prisma.durableWorkItem.updateMany({
        where: { id, status: 'CLAIMED', leaseOwner: owner },
        data: {
          status: 'COMPLETED',
          completedAt: new Date(),
          leaseOwner: null,
          leaseExpiresAt: null,
        },
      })
      if (result.count !== 1)
        throw new ConflictError('Work item lease is no longer owned')
    },

    async renewWorkItemLease(input) {
      if (!Number.isInteger(input.leaseSeconds) || input.leaseSeconds <= 0) {
        throw new InvalidStateError('Lease must be positive')
      }
      const now = input.now ?? new Date()
      const leaseExpiresAt = new Date(now.getTime() + input.leaseSeconds * 1000)
      const result = await prisma.durableWorkItem.updateMany({
        where: {
          id: input.id,
          status: 'CLAIMED',
          leaseOwner: input.owner,
          leaseExpiresAt: { gt: now },
        },
        data: { leaseExpiresAt },
      })
      if (result.count !== 1)
        throw new ConflictError('Work item lease is no longer owned')
      return leaseExpiresAt
    },

    async retryWorkItem(input) {
      await prisma.$transaction(async (transaction) => {
        const item = await transaction.durableWorkItem.findFirst({
          where: { id: input.id, status: 'CLAIMED', leaseOwner: input.owner },
        })
        if (item === null) throw new ConflictError('Work item lease is no longer owned')
        const exhausted = item.attemptCount >= item.maxAttempts
        if (exhausted) {
          await markWorkItemExhausted(
            transaction,
            item,
            input.errorCode,
            input.errorSafe,
          )
          return
        }
        await transaction.durableWorkItem.update({
          where: { id: item.id },
          data: {
            status: 'RETRY_WAIT',
            retryAfter: input.retryAt,
            availableAt: input.retryAt,
            lastErrorCode: input.errorCode,
            lastErrorSafe: input.errorSafe,
            ...(input.nextKind === undefined ? {} : { kind: input.nextKind }),
            leaseOwner: null,
            leaseExpiresAt: null,
          },
        })
      })
    },

    async failWorkItem(input) {
      await prisma.$transaction(async (transaction) => {
        const item = await transaction.durableWorkItem.findFirst({
          where: { id: input.id, status: 'CLAIMED', leaseOwner: input.owner },
        })
        if (item === null) throw new ConflictError('Work item lease is no longer owned')
        await markWorkItemExhausted(transaction, item, input.errorCode, input.errorSafe)
      })
    },

    async appendTimelineEvent(input) {
      await prisma.operationTimelineEvent.create({
        data: {
          id: input.id,
          ...(input.accountId === undefined ? {} : { accountId: input.accountId }),
          resourceType: input.resourceType,
          resourceId: input.resourceId,
          eventType: input.eventType,
          actorType: input.actorType,
          ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
          ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
          ...(input.correlationId === undefined
            ? {}
            : { correlationId: input.correlationId }),
          ...(input.oldStateJson === undefined
            ? {}
            : { oldStateJson: input.oldStateJson }),
          ...(input.newStateJson === undefined
            ? {}
            : { newStateJson: input.newStateJson }),
          source: input.source,
          occurredAt: input.occurredAt ?? new Date(),
          metadataJson: input.metadataJson ?? '{}',
        },
      })
    },

    async recordEvidence(input) {
      await prisma.evidenceRecord.create({
        data: {
          id: input.id,
          paymentId: input.paymentId,
          ...(input.attemptId === undefined ? {} : { attemptId: input.attemptId }),
          authority: input.authority,
          source: input.source,
          outcome: input.outcome,
          observedAt: input.observedAt,
          ...(input.externalId === undefined ? {} : { externalId: input.externalId }),
          ...(input.expectedExternalId === undefined
            ? {}
            : { expectedExternalId: input.expectedExternalId }),
          ...(input.payloadHash === undefined
            ? {}
            : { payloadHash: input.payloadHash }),
          ...(input.providerCorrelation === undefined
            ? {}
            : { providerCorrelation: input.providerCorrelation }),
          metadataJson: input.metadataJson ?? '{}',
        },
      })
    },

    async openOperationalException(input) {
      await prisma.operationalException.upsert({
        where: { activeDedupeKey: `active:${input.dedupeKey}` },
        create: {
          id: input.id,
          ...(input.accountId === undefined ? {} : { accountId: input.accountId }),
          resourceType: input.resourceType,
          resourceId: input.resourceId,
          dedupeKey: input.dedupeKey,
          activeDedupeKey: `active:${input.dedupeKey}`,
          reasonCode: input.reasonCode,
          severity: input.severity ?? 'ERROR',
          detailsJson: input.detailsJson ?? '{}',
        },
        update: {
          updatedAt: new Date(),
          detailsJson: input.detailsJson ?? '{}',
        },
      })
    },
  }
}

function toV2PaymentSnapshot(payment: {
  id: string
  payerAccountId: string
  correlationId: string | null
  recipientId: string | null
  recipientManagedAccountId: string | null
  kind: string
  description: string | null
  externalReference: string | null
  metadataJson?: string
  amountAtomic: bigint
  amountScale: number | null
  denominationId: string | null
  currency: string
  status: string
  routeId: string | null
  routeSelectionReason: string | null
  settlementAssetId: string | null
  economicMappingId: string | null
  destinationSnapshotJson: string | null
  policyDecisionId: string | null
  approvalId: string | null
  executionState: string
  settlementState: string
  outcomeState: string
  rowVersion: number
  originalPaymentId: string | null
  confirmedAt: Date | null
  failedAt: Date | null
  failureCode: string | null
  failureMessageSafe: string | null
  createdAt: Date
  updatedAt: Date
}): V2PaymentSnapshot {
  return payment
}

function randomId(): string {
  return randomBytes(16).toString('hex')
}

function toV2AttemptSnapshot(attempt: {
  id: string
  paymentId: string
  attemptNumber: number
  status: string
  outcome: string
  routeId: string | null
  preparedEffectHash: string | null
  preparedEffectJson: string | null
  signedPayloadHash: string | null
  signedPayloadEncrypted: string | null
  expectedExternalId: string | null
  validityExpiresAt: Date | null
  validitySlot: bigint | null
  rowVersion: number
}): V2PaymentAttemptSnapshot {
  return {
    ...attempt,
  }
}

async function loadPaymentView(
  prisma: PrismaClient,
  payment: Parameters<typeof toV2PaymentSnapshot>[0],
  accountId: string,
): Promise<V2PaymentView> {
  const [policyDecision, approval, reservation, attempts] = await Promise.all([
    prisma.policyDecision.findUnique({ where: { paymentId: payment.id } }),
    prisma.approval.findUnique({ where: { paymentId: payment.id } }),
    prisma.outgoingReservation.findUnique({ where: { paymentId: payment.id } }),
    prisma.paymentAttempt.findMany({
      where: { paymentId: payment.id },
      orderBy: { attemptNumber: 'asc' },
    }),
  ])
  if (policyDecision === null) {
    return {
      payment: toV2PaymentSnapshot(payment),
      policyDecision: legacyPolicyDecision(payment.status),
      reasonCodes: [],
      approvalState: projectApprovalState(approval),
      reservationStatus: projectReservationStatus(reservation),
      attempts: attempts.map(toV2AttemptSnapshot),
    }
  }
  if (policyDecision.accountId !== accountId) {
    throw new InvalidStateError('Payment policy decision belongs to another account')
  }
  const decision = parsePolicyDecision(policyDecision.decision)
  const approvalState = projectApprovalState(approval)
  return {
    payment: toV2PaymentSnapshot(payment),
    policyDecision: decision,
    reasonCodes: parseStringArray(
      policyDecision.reasonCodesJson,
      'policy reason codes',
    ),
    approvalState,
    reservationStatus: projectReservationStatus(reservation),
    attempts: attempts.map(toV2AttemptSnapshot),
  }
}

async function resolveWorkAccountId(
  transaction: Prisma.TransactionClient,
  resourceType: string,
  resourceId: string,
): Promise<string | undefined> {
  if (resourceType === 'PAYMENT') {
    const payment = await transaction.payment.findUnique({
      where: { id: resourceId },
      select: { payerAccountId: true },
    })
    return payment?.payerAccountId
  }
  if (resourceType === 'PAYMENT_ATTEMPT') {
    const attempt = await transaction.paymentAttempt.findUnique({
      where: { id: resourceId },
      select: { payment: { select: { payerAccountId: true } } },
    })
    return attempt?.payment.payerAccountId
  }
  return undefined
}

function parsePolicyDecision(value: string): PaymentPolicyDecision {
  if (value === 'ALLOW' || value === 'REQUIRE_APPROVAL' || value === 'DENY') {
    return value
  }
  throw new InvalidStateError('Payment has an unknown policy decision')
}

function legacyPolicyDecision(status: string): PaymentPolicyDecision {
  if (status === 'REJECTED_BY_POLICY') return 'DENY'
  if (status === 'AWAITING_APPROVAL') return 'REQUIRE_APPROVAL'
  return 'ALLOW'
}

function asAttemptOutcome(value: string): AttemptOutcome {
  if (
    value === 'NOT_STARTED' ||
    value === 'PRE_EFFECT_ABORTED' ||
    value === 'PROVED_NO_EFFECT' ||
    value === 'SUBMITTED' ||
    value === 'CONFIRMED' ||
    value === 'UNKNOWN' ||
    value === 'FAILED'
  ) {
    return value
  }
  throw new InvalidStateError('Payment has an unknown attempt outcome')
}

function assertTerminalDimensionConsistency(input: {
  readonly nextOutcome: string
  readonly replacement: boolean
  readonly settlementState: string
  readonly outcomeState: string
}): void {
  const expected = input.replacement
    ? { settlementState: 'NOT_SUBMITTED', outcomeState: 'NONE' }
    : input.nextOutcome === 'CONFIRMED'
      ? { settlementState: 'CONFIRMED', outcomeState: 'CONFIRMED' }
      : input.nextOutcome === 'PROVED_NO_EFFECT' || input.nextOutcome === 'FAILED'
        ? { settlementState: 'NOT_SUBMITTED', outcomeState: 'PROVED_NO_EFFECT' }
        : undefined
  if (
    expected === undefined ||
    input.settlementState !== expected.settlementState ||
    input.outcomeState !== expected.outcomeState
  ) {
    throw new InvalidStateError(
      'Payment settlement and outcome dimensions do not match the durable attempt outcome',
    )
  }
}

function projectApprovalState(
  approval: { readonly status: string; readonly expiresAt: Date } | null,
): V2PaymentView['approvalState'] {
  if (approval === null) return 'NOT_REQUIRED'
  if (approval.status === 'PENDING' && approval.expiresAt <= new Date())
    return 'EXPIRED'
  if (
    approval.status === 'PENDING' ||
    approval.status === 'APPROVED' ||
    approval.status === 'REJECTED' ||
    approval.status === 'EXPIRED'
  ) {
    return approval.status
  }
  throw new InvalidStateError('Payment has an unknown approval state')
}

function projectReservationStatus(
  reservation: { readonly status: string; readonly lifecycleState: string } | null,
): V2PaymentView['reservationStatus'] {
  if (reservation === null) return 'NONE'
  if (reservation.status === 'RELEASED' || reservation.lifecycleState === 'RELEASED') {
    return 'RELEASED'
  }
  if (reservation.lifecycleState === 'HELD') return 'HELD'
  if (reservation.lifecycleState === 'CONSUMED') return 'CONSUMED'
  throw new InvalidStateError('Payment has an unknown reservation state')
}

function parseStringArray(value: string, fieldName: string): readonly string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(value) as unknown
  } catch {
    throw new InvalidStateError(`${fieldName} are not valid JSON`)
  }
  if (
    !Array.isArray(parsed) ||
    parsed.some((item): item is unknown => typeof item !== 'string')
  ) {
    throw new InvalidStateError(`${fieldName} are not a string array`)
  }
  return parsed
}

async function markWorkItemExhausted(
  transaction: Prisma.TransactionClient,
  item: {
    readonly id: string
    readonly resourceType: string
    readonly resourceId: string
    readonly attemptCount: number
  },
  errorCode: string,
  errorSafe: string,
): Promise<void> {
  await transaction.durableWorkItem.update({
    where: { id: item.id },
    data: {
      status: 'EXHAUSTED',
      retryAfter: null,
      lastErrorCode: errorCode,
      lastErrorSafe: errorSafe,
      leaseOwner: null,
      leaseExpiresAt: null,
    },
  })

  const payment = await findWorkPayment(transaction, item.resourceType, item.resourceId)
  if (payment !== null) {
    const terminalStatuses = new Set([
      'CONFIRMED',
      'PROVED_NO_EFFECT',
      'FAILED',
      'REJECTED',
      'REJECTED_BY_POLICY',
      'EXPIRED',
      'CLOSED_UNRESOLVED',
    ])
    if (!terminalStatuses.has(payment.status)) {
      await transaction.payment.update({
        where: { id: payment.id },
        data: {
          status: 'REVIEW_REQUIRED',
          executionState: 'RECONCILING',
          settlementState: 'UNKNOWN',
          outcomeState: 'UNDETERMINED',
          rowVersion: { increment: 1 },
        },
      })
      const updatedPayment = await transaction.payment.findUniqueOrThrow({
        where: { id: payment.id },
      })
      await enqueuePaymentWebhookEvent(transaction, {
        accountId: updatedPayment.payerAccountId,
        paymentId: updatedPayment.id,
        resourceVersion: updatedPayment.rowVersion,
        eventType: 'payment.updated',
        status: updatedPayment.status,
        amountAtomic: updatedPayment.amountAtomic,
        denominationId: updatedPayment.denominationId,
        ...(updatedPayment.correlationId === null
          ? {}
          : { correlationId: updatedPayment.correlationId }),
      })
      await transaction.operationTimelineEvent.create({
        data: {
          id: `timeline_${randomId()}`,
          accountId: payment.accountId,
          resourceType: 'PAYMENT',
          resourceId: payment.id,
          eventType: 'PAYMENT_REVIEW_REQUIRED',
          actorType: 'SYSTEM',
          source: 'V2_WORK_ITEM',
          occurredAt: new Date(),
          ...(payment.correlationId === null
            ? {}
            : { correlationId: payment.correlationId }),
          newStateJson: JSON.stringify({ reason: errorCode }),
        },
      })
    }
    await transaction.operationalException.upsert({
      where: { activeDedupeKey: `active:payment:${payment.id}:work-exhausted` },
      create: {
        id: `opx_${randomId()}`,
        accountId: payment.accountId,
        resourceType: 'PAYMENT',
        resourceId: payment.id,
        dedupeKey: `payment:${payment.id}:work-exhausted`,
        activeDedupeKey: `active:payment:${payment.id}:work-exhausted`,
        reasonCode: 'WORK_ITEM_EXHAUSTED',
        detailsJson: JSON.stringify({ error_code: errorCode, error_safe: errorSafe }),
      },
      update: {
        updatedAt: new Date(),
        detailsJson: JSON.stringify({ error_code: errorCode, error_safe: errorSafe }),
      },
    })
    return
  }

  await transaction.operationalException.upsert({
    where: { activeDedupeKey: `active:work:${item.id}` },
    create: {
      id: `opx_${randomId()}`,
      resourceType: item.resourceType,
      resourceId: item.resourceId,
      dedupeKey: `work:${item.id}`,
      activeDedupeKey: `active:work:${item.id}`,
      reasonCode: 'WORK_ITEM_EXHAUSTED',
      detailsJson: JSON.stringify({ error_code: errorCode, error_safe: errorSafe }),
    },
    update: {
      updatedAt: new Date(),
      detailsJson: JSON.stringify({ error_code: errorCode, error_safe: errorSafe }),
    },
  })
}

async function findWorkPayment(
  transaction: Prisma.TransactionClient,
  resourceType: string,
  resourceId: string,
): Promise<{
  readonly id: string
  readonly accountId: string
  readonly status: string
  readonly correlationId: string | null
} | null> {
  if (resourceType === 'PAYMENT') {
    const payment = await transaction.payment.findUnique({
      where: { id: resourceId },
      select: { id: true, payerAccountId: true, status: true, correlationId: true },
    })
    return payment === null
      ? null
      : {
          id: payment.id,
          accountId: payment.payerAccountId,
          status: payment.status,
          correlationId: payment.correlationId,
        }
  }
  if (resourceType === 'PAYMENT_ATTEMPT') {
    const attempt = await transaction.paymentAttempt.findUnique({
      where: { id: resourceId },
      select: {
        payment: {
          select: { id: true, payerAccountId: true, status: true, correlationId: true },
        },
      },
    })
    return attempt === null
      ? null
      : {
          id: attempt.payment.id,
          accountId: attempt.payment.payerAccountId,
          status: attempt.payment.status,
          correlationId: attempt.payment.correlationId,
        }
  }
  return null
}

async function enqueuePaymentWebhookEvent(
  transaction: Prisma.TransactionClient,
  input: {
    readonly accountId: string
    readonly paymentId: string
    readonly resourceVersion: number
    readonly eventType: string
    readonly status: string
    readonly amountAtomic: bigint
    readonly denominationId: string | null
    readonly correlationId?: string
  },
): Promise<void> {
  await enqueueWebhookEvent(transaction, {
    accountId: input.accountId,
    resourceType: 'PAYMENT',
    resourceId: input.paymentId,
    resourceVersion: input.resourceVersion,
    eventType: input.eventType,
    resource: {
      id: input.paymentId,
      status: input.status,
      amount_atomic: input.amountAtomic.toString(),
      denomination_id: input.denominationId,
      ...(input.correlationId === undefined
        ? {}
        : { correlation_id: input.correlationId }),
    },
    ...(input.correlationId === undefined
      ? {}
      : { correlationId: input.correlationId }),
  })
}
