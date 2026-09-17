import {
  ConflictError,
  IdempotencyConflictError,
  InsufficientFundsError,
  InvalidStateError,
  NotFoundError,
  type PaymentPolicyDecision,
  type SettlementRoute,
} from '@agent-payment/core'
import type { PrismaClient } from './generated/client/client.js'

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
  readonly recipientId: string | null
  readonly recipientManagedAccountId: string | null
  readonly kind: string
  readonly amountAtomic: bigint
  readonly amountScale: number | null
  readonly denominationId: string | null
  readonly currency: string
  readonly status: string
  readonly routeId: string | null
  readonly routeSelectionReason: string | null
  readonly settlementAssetId: string | null
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
  readonly signedPayloadHash: string | null
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
  readonly originalPaymentId?: string
  readonly route: SettlementRoute | null
  readonly routeSelectionReason: string | null
  readonly destinationSnapshotJson: string
  readonly settlementAssetId: string | null
  readonly policyDecision: V2PolicyDecisionInput
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

export interface V2WorkItemClaim {
  readonly id: string
  readonly kind: string
  readonly resourceType: string
  readonly resourceId: string
  readonly attemptCount: number
  readonly payloadJson: string
}

export interface V2DatabaseRepository {
  createDenomination(input: {
    readonly id: string
    readonly symbol: string
    readonly maxScale: number
    readonly version?: number
  }): Promise<V2DenominationRecord>
  findDenomination(id: string): Promise<V2DenominationRecord | null>
  findSettlementAsset(id: string): Promise<V2SettlementAssetRecord | null>
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
  createV2Payment(input: V2PaymentCreateInput): Promise<V2PaymentCreateResult>
  findPayment(accountId: string, paymentId: string): Promise<V2PaymentSnapshot | null>
  findPaymentView(accountId: string, paymentId: string): Promise<V2PaymentView | null>
  listPaymentViews(input: {
    readonly accountId: string
    readonly limit: number
    readonly cursor?: { readonly createdAt: Date; readonly id: string }
    readonly status?: string
    readonly recipientId?: string
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
    readonly evidenceId?: string
  }): Promise<V2PaymentAttemptSnapshot>
  claimWorkItem(input: {
    readonly kind: string
    readonly owner: string
    readonly leaseSeconds: number
    readonly now?: Date
  }): Promise<V2WorkItemClaim | null>
  completeWorkItem(id: string, owner: string): Promise<void>
  retryWorkItem(input: {
    readonly id: string
    readonly owner: string
    readonly retryAt: Date
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

    async findSettlementAsset(id) {
      return prisma.settlementAsset.findUnique({ where: { id } })
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
          where: { payerAccountId: accountId, denominationId, status: 'CONFIRMED' },
          _sum: { amountAtomic: true },
        }),
        prisma.outgoingReservation.aggregate({
          where: {
            ownerAccountId: accountId,
            status: 'ACTIVE',
            lifecycleState: 'HELD',
          },
          _sum: { amountAtomic: true },
        }),
        prisma.payment.aggregate({
          where: {
            payerAccountId: accountId,
            denominationId,
            status: { in: ['REVIEW_REQUIRED', 'CLOSED_UNRESOLVED'] },
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
          status: { notIn: ['FAILED', 'REJECTED', 'REJECTED_BY_POLICY', 'EXPIRED'] },
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
      const result = await prisma.recipient.updateMany({
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
            where: { ownerAccountId: input.accountId, status: 'ACTIVE' },
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
            destinationSnapshotJson: input.destinationSnapshotJson,
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
              fingerprint: input.fingerprint,
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
              payloadJson: JSON.stringify({ payment_id: payment.id }),
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
            source: 'V2_PAYMENT_ORCHESTRATOR',
            occurredAt: payment.createdAt,
            newStateJson: JSON.stringify({ status, policy_decision: decision }),
          },
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

    async claimWorkItem(input) {
      if (input.leaseSeconds <= 0) throw new InvalidStateError('Lease must be positive')
      const now = input.now ?? new Date()
      return prisma.$transaction(async (transaction) => {
        const rows = await transaction.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM "durable_work_items"
          WHERE kind = ${input.kind}
            AND (status = 'AVAILABLE' OR (status = 'CLAIMED' AND lease_expires_at <= ${now}))
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
        return {
          id: item.id,
          kind: item.kind,
          resourceType: item.resourceType,
          resourceId: item.resourceId,
          attemptCount: item.attemptCount,
          payloadJson: item.payloadJson,
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

    async retryWorkItem(input) {
      const result = await prisma.durableWorkItem.updateMany({
        where: { id: input.id, status: 'CLAIMED', leaseOwner: input.owner },
        data: {
          status: 'RETRY_WAIT',
          retryAfter: input.retryAt,
          availableAt: input.retryAt,
          lastErrorCode: input.errorCode,
          lastErrorSafe: input.errorSafe,
          leaseOwner: null,
          leaseExpiresAt: null,
        },
      })
      if (result.count !== 1)
        throw new ConflictError('Work item lease is no longer owned')
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
  recipientId: string | null
  recipientManagedAccountId: string | null
  kind: string
  amountAtomic: bigint
  amountScale: number | null
  denominationId: string | null
  currency: string
  status: string
  routeId: string | null
  routeSelectionReason: string | null
  settlementAssetId: string | null
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

function toV2AttemptSnapshot(attempt: {
  id: string
  paymentId: string
  attemptNumber: number
  status: string
  outcome: string
  routeId: string | null
  preparedEffectHash: string | null
  signedPayloadHash: string | null
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
  if (policyDecision === null || policyDecision.accountId !== accountId) {
    throw new InvalidStateError('Payment is missing its durable policy decision')
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

function parsePolicyDecision(value: string): PaymentPolicyDecision {
  if (value === 'ALLOW' || value === 'REQUIRE_APPROVAL' || value === 'DENY') {
    return value
  }
  throw new InvalidStateError('Payment has an unknown policy decision')
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
  } catch (error) {
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
