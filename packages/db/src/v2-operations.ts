import { randomBytes } from 'node:crypto'
import {
  ConflictError,
  InvalidStateError,
  NotFoundError,
  ValidationError,
  assertAttemptProgression,
} from '@agent-payment/core'
import type { Prisma, PrismaClient } from './generated/client/client.js'

export interface V2TimelineRecord {
  readonly id: string
  readonly accountId: string | null
  readonly resourceType: string
  readonly resourceId: string
  readonly eventType: string
  readonly actorType: string
  readonly actorId: string | null
  readonly requestId: string | null
  readonly correlationId: string | null
  readonly oldStateJson: string | null
  readonly newStateJson: string | null
  readonly source: string
  readonly occurredAt: Date
  readonly metadataJson: string
}

export interface V2OperationalExceptionRecord {
  readonly id: string
  readonly accountId: string | null
  readonly resourceType: string
  readonly resourceId: string
  readonly dedupeKey: string
  readonly status: string
  readonly severity: string
  readonly reasonCode: string
  readonly detailsJson: string
  readonly assignedTo: string | null
  readonly rowVersion: number
  readonly createdAt: Date
  readonly updatedAt: Date
  readonly acknowledgedAt: Date | null
  readonly resolvedAt: Date | null
}

export interface V2PlatformCostRecord {
  readonly id: string
  readonly accountId: string
  readonly paymentId: string | null
  readonly attemptId: string | null
  readonly assetId: string
  readonly estimatedAmount: bigint
  readonly actualAmount: bigint | null
  readonly reconciliationStatus: string
  readonly observedAt: Date | null
  readonly createdAt: Date
  readonly updatedAt: Date
}

export interface V2WebhookSubscriptionRecord {
  readonly id: string
  readonly accountId: string
  readonly endpoint: string
  readonly eventTypes: readonly string[]
  readonly status: string
  readonly signingKeyRef: string
  readonly signingKeyVersion: number
  readonly createdAt: Date
  readonly archivedAt: Date | null
}

export interface V2WebhookDeliveryClaim {
  readonly id: string
  readonly eventId: string
  readonly subscriptionId: string
  readonly endpoint: string
  readonly signingKeyRef: string
  readonly signingKeyVersion: number
  readonly rawBody: string
  readonly attemptCount: number
}

const MAX_WEBHOOK_BATCH_SIZE = 1_000

export interface V2DomainHealthRecord {
  readonly reviewRequiredPayments: number
  readonly exhaustedIncomingIssues: number
  readonly pendingWebhookDeliveries: number
}

export interface V2BackupRestoreVerificationRecord {
  readonly id: string
  readonly backupReference: string
  readonly environment: string
  readonly status: string
  readonly schemaVersion: string
  readonly invariantSummaryJson: string
  readonly custodyIdentity: string | null
  readonly verifiedAt: Date | null
  readonly failureSafe: string | null
  readonly createdAt: Date
}

export interface V2OperationsRepository {
  readonly getDomainHealth?: () => Promise<V2DomainHealthRecord>
  listTimeline(input: {
    readonly accountId: string
    readonly limit: number
    readonly cursor?: { readonly occurredAt: Date; readonly id: string }
    readonly resourceType?: string
    readonly resourceId?: string
  }): Promise<readonly V2TimelineRecord[]>
  listExceptions(input: {
    readonly accountId?: string
    readonly status?: string
    readonly limit: number
  }): Promise<readonly V2OperationalExceptionRecord[]>
  findException(id: string): Promise<V2OperationalExceptionRecord | null>
  acknowledgeException(input: {
    readonly id: string
    readonly operatorId: string
    readonly rowVersion: number
  }): Promise<V2OperationalExceptionRecord>
  resolveConfirmedException(input: {
    readonly id: string
    readonly operatorId: string
    readonly rowVersion: number
    readonly evidenceId?: string
    readonly now?: Date
  }): Promise<V2OperationalExceptionRecord>
  resolveProvedNoEffectException(input: {
    readonly id: string
    readonly operatorId: string
    readonly rowVersion: number
    readonly evidenceId?: string
    readonly now?: Date
  }): Promise<V2OperationalExceptionRecord>
  closeUnresolvedException(input: {
    readonly id: string
    readonly operatorId: string
    readonly rowVersion: number
    readonly now?: Date
  }): Promise<V2OperationalExceptionRecord>
  createPlatformCostEstimate(input: {
    readonly id: string
    readonly accountId: string
    readonly paymentId?: string
    readonly attemptId?: string
    readonly assetId: string
    readonly estimatedAmount: bigint
  }): Promise<V2PlatformCostRecord>
  reconcilePlatformCost(input: {
    readonly id: string
    readonly actualAmount: bigint
    readonly observedAt: Date
  }): Promise<V2PlatformCostRecord>
  createWebhookSubscription(input: {
    readonly id: string
    readonly accountId: string
    readonly endpoint: string
    readonly eventTypes: readonly string[]
    readonly signingKeyRef: string
    readonly signingKeyVersion: number
  }): Promise<V2WebhookSubscriptionRecord>
  listWebhookSubscriptions(
    accountId: string,
  ): Promise<readonly V2WebhookSubscriptionRecord[]>
  archiveWebhookSubscription(accountId: string, id: string): Promise<void>
  createWebhookEvent(input: {
    readonly id: string
    readonly eventId: string
    readonly accountId: string
    readonly resourceType: string
    readonly resourceId: string
    readonly resourceVersion: number
    readonly eventType: string
    readonly eventVersion: string
    readonly rawBody: string
  }): Promise<{ readonly eventId: string; readonly created: boolean }>
  claimWebhookDeliveries(input: {
    readonly limit: number
    readonly owner: string
    readonly leaseSeconds: number
    readonly now?: Date
  }): Promise<readonly V2WebhookDeliveryClaim[]>
  renewWebhookDeliveryLease(input: {
    readonly id: string
    readonly owner: string
    readonly leaseSeconds: number
    readonly now?: Date
  }): Promise<Date>
  markWebhookDelivered(id: string, owner: string, responseStatus: number): Promise<void>
  retryWebhookDelivery(input: {
    readonly id: string
    readonly owner: string
    readonly retryAt: Date
    readonly errorSafe: string
    readonly maxAttempts: number
  }): Promise<void>
  createBackupVerification(input: {
    readonly id: string
    readonly backupReference: string
    readonly environment: string
    readonly schemaVersion: string
    readonly custodyIdentity?: string
  }): Promise<V2BackupRestoreVerificationRecord>
  finishBackupVerification(input: {
    readonly id: string
    readonly status: 'VERIFIED' | 'FAILED'
    readonly invariantSummaryJson: string
    readonly failureSafe?: string
    readonly verifiedAt?: Date
  }): Promise<V2BackupRestoreVerificationRecord>
  findLatestBackupVerification(): Promise<V2BackupRestoreVerificationRecord | null>
}

export function createV2OperationsRepository(
  prisma: PrismaClient,
): V2OperationsRepository {
  return {
    async getDomainHealth() {
      const [
        reviewRequiredPayments,
        exhaustedIncomingIssues,
        pendingWebhookDeliveries,
      ] = await Promise.all([
        prisma.payment.count({ where: { status: 'REVIEW_REQUIRED' } }),
        prisma.incomingReconciliationIssue.count({ where: { status: 'EXHAUSTED' } }),
        prisma.webhookDelivery.count({
          where: { status: { in: ['AVAILABLE', 'RETRY_WAIT', 'CLAIMED'] } },
        }),
      ])
      return {
        reviewRequiredPayments,
        exhaustedIncomingIssues,
        pendingWebhookDeliveries,
      }
    },

    async listTimeline(input) {
      const events = await prisma.operationTimelineEvent.findMany({
        where: {
          accountId: input.accountId,
          ...(input.resourceType === undefined
            ? {}
            : { resourceType: input.resourceType }),
          ...(input.resourceId === undefined ? {} : { resourceId: input.resourceId }),
          ...(input.cursor === undefined
            ? {}
            : {
                OR: [
                  { occurredAt: { lt: input.cursor.occurredAt } },
                  { occurredAt: input.cursor.occurredAt, id: { lt: input.cursor.id } },
                ],
              }),
        },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        take: input.limit,
      })
      return events.map(toTimelineRecord)
    },

    async listExceptions(input) {
      const exceptions = await prisma.operationalException.findMany({
        where: {
          ...(input.accountId === undefined ? {} : { accountId: input.accountId }),
          ...(input.status === undefined ? {} : { status: input.status }),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: input.limit,
      })
      return exceptions.map(toExceptionRecord)
    },

    async findException(id) {
      const exception = await prisma.operationalException.findUnique({ where: { id } })
      return exception === null ? null : toExceptionRecord(exception)
    },

    async acknowledgeException(input) {
      const updated = await prisma.operationalException.updateMany({
        where: {
          id: input.id,
          rowVersion: input.rowVersion,
          status: { in: ['OPEN', 'ACKNOWLEDGED'] },
        },
        data: {
          status: 'ACKNOWLEDGED',
          assignedTo: input.operatorId,
          acknowledgedAt: new Date(),
          rowVersion: { increment: 1 },
        },
      })
      if (updated.count !== 1) throw new ConflictError('Exception changed concurrently')
      return toExceptionRecord(
        await prisma.operationalException.findUniqueOrThrow({
          where: { id: input.id },
        }),
      )
    },

    async resolveConfirmedException(input) {
      return resolveExceptionWithEvidence(prisma, input, 'CONFIRMED')
    },

    async resolveProvedNoEffectException(input) {
      return resolveExceptionWithEvidence(prisma, input, 'PROVED_NO_EFFECT')
    },

    async closeUnresolvedException(input) {
      const now = input.now ?? new Date()
      return prisma.$transaction(async (transaction) => {
        const exception = await lockException(transaction, input.id, input.rowVersion)
        const payment = await findExceptionPayment(transaction, exception)
        if (payment !== null) {
          if (!['REVIEW_REQUIRED', 'RECONCILING'].includes(payment.status)) {
            throw new ConflictError('Payment is not awaiting unresolved closure')
          }
          await transaction.payment.update({
            where: { id: payment.id },
            data: {
              status: 'CLOSED_UNRESOLVED',
              executionState: 'TERMINAL',
              settlementState: 'UNKNOWN',
              outcomeState: 'UNDETERMINED',
              rowVersion: { increment: 1 },
            },
          })
          await appendOperatorTimeline(
            transaction,
            payment.accountId,
            payment.id,
            'PAYMENT_CLOSED_UNRESOLVED',
            input.operatorId,
            now,
          )
        }
        const updated = await transaction.operationalException.update({
          where: { id: exception.id },
          data: {
            status: 'CLOSED_UNRESOLVED',
            assignedTo: input.operatorId,
            resolvedAt: now,
            activeDedupeKey: null,
            rowVersion: { increment: 1 },
          },
        })
        return toExceptionRecord(updated)
      })
    },

    async createPlatformCostEstimate(input) {
      const cost = await prisma.platformCostRecord.create({
        data: {
          id: input.id,
          accountId: input.accountId,
          ...(input.paymentId === undefined ? {} : { paymentId: input.paymentId }),
          ...(input.attemptId === undefined ? {} : { attemptId: input.attemptId }),
          assetId: input.assetId,
          estimatedAmount: input.estimatedAmount,
        },
      })
      return toCostRecord(cost)
    },

    async reconcilePlatformCost(input) {
      const cost = await prisma.platformCostRecord.findUnique({
        where: { id: input.id },
      })
      if (cost === null) throw new NotFoundError('Platform cost record was not found')
      const updated = await prisma.platformCostRecord.update({
        where: { id: cost.id },
        data: {
          actualAmount: input.actualAmount,
          reconciliationStatus: 'RECONCILED',
          observedAt: input.observedAt,
        },
      })
      return toCostRecord(updated)
    },

    async createWebhookSubscription(input) {
      if (input.eventTypes.length === 0) {
        throw new InvalidStateError('Webhook subscription requires an event type')
      }
      validateWebhookEndpoint(input.endpoint)
      const eventTypes = [
        ...new Set(input.eventTypes.map((eventType) => eventType.trim())),
      ]
      if (
        eventTypes.some((eventType) => eventType.length === 0 || eventType.length > 128)
      ) {
        throw new ValidationError(
          'Webhook event types must contain 1 to 128 characters',
        )
      }
      if (!Number.isInteger(input.signingKeyVersion) || input.signingKeyVersion < 1) {
        throw new ValidationError('Webhook signing key version must be positive')
      }
      const subscription = await prisma.webhookSubscription.create({
        data: {
          id: input.id,
          accountId: input.accountId,
          endpoint: input.endpoint,
          eventTypesJson: JSON.stringify(eventTypes),
          signingKeyRef: input.signingKeyRef,
          signingKeyVersion: input.signingKeyVersion,
        },
      })
      return toSubscriptionRecord(subscription)
    },

    async listWebhookSubscriptions(accountId) {
      const subscriptions = await prisma.webhookSubscription.findMany({
        where: { accountId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      })
      return subscriptions.map(toSubscriptionRecord)
    },

    async archiveWebhookSubscription(accountId, id) {
      const result = await prisma.webhookSubscription.updateMany({
        where: { id, accountId, status: 'ACTIVE' },
        data: { status: 'ARCHIVED', archivedAt: new Date() },
      })
      if (result.count !== 1)
        throw new NotFoundError('Webhook subscription was not found')
    },

    async createWebhookEvent(input) {
      return prisma.$transaction(async (transaction) => {
        const existing = await transaction.webhookEvent.findUnique({
          where: { eventId: input.eventId },
        })
        if (existing !== null) return { eventId: existing.eventId, created: false }
        const event = await transaction.webhookEvent.create({
          data: {
            id: input.id,
            eventId: input.eventId,
            resourceType: input.resourceType,
            resourceId: input.resourceId,
            resourceVersion: input.resourceVersion,
            eventType: input.eventType,
            eventVersion: input.eventVersion,
            rawBody: input.rawBody,
          },
        })
        const subscriptions = await transaction.webhookSubscription.findMany({
          where: { accountId: input.accountId, status: 'ACTIVE' },
        })
        const matching = subscriptions.filter((subscription) => {
          const eventTypes = parseStringArray(subscription.eventTypesJson)
          return eventTypes.includes(input.eventType) || eventTypes.includes('*')
        })
        for (const subscription of matching) {
          await transaction.webhookDelivery.create({
            data: {
              id: `delivery_${randomId()}`,
              eventId: event.eventId,
              subscriptionId: subscription.id,
              deliveryNumber: 1,
            },
          })
        }
        return { eventId: event.eventId, created: true }
      })
    },

    async claimWebhookDeliveries(input) {
      const now = input.now ?? new Date()
      if (
        !Number.isInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > MAX_WEBHOOK_BATCH_SIZE
      ) {
        throw new ValidationError(
          `Webhook delivery batch size must be an integer from 1 to ${MAX_WEBHOOK_BATCH_SIZE}`,
        )
      }
      if (!Number.isInteger(input.leaseSeconds) || input.leaseSeconds <= 0) {
        throw new InvalidStateError('Webhook delivery lease must be positive')
      }
      if (input.owner.trim().length === 0) {
        throw new ValidationError('Webhook delivery owner is required')
      }
      const leaseExpiresAt = new Date(now.getTime() + input.leaseSeconds * 1000)
      return prisma.$transaction(async (transaction) => {
        const rows = await transaction.$queryRaw<
          readonly {
            id: string
            event_id: string
            subscription_id: string
            endpoint: string
            signing_key_ref: string
            signing_key_version: number
            raw_body: string
            attempt_count: number
          }[]
        >`
          SELECT delivery.id,
                 delivery.event_id,
                 delivery.subscription_id,
                 subscription.endpoint,
                 subscription.signing_key_ref,
                 subscription.signing_key_version,
                 event.raw_body,
                 delivery.attempt_count
          FROM "webhook_deliveries" delivery
          JOIN "webhook_subscriptions" subscription
            ON subscription.id = delivery.subscription_id
          JOIN "webhook_events" event
            ON event.event_id = delivery.event_id
          WHERE delivery.available_at <= ${now}
            AND (delivery.status IN ('AVAILABLE', 'RETRY_WAIT')
              OR (delivery.status = 'CLAIMED' AND delivery.lease_expires_at <= ${now}))
            AND subscription.status = 'ACTIVE'
          ORDER BY delivery.available_at ASC, delivery.id ASC
          LIMIT ${input.limit}
          FOR UPDATE OF delivery SKIP LOCKED
        `
        for (const row of rows) {
          await transaction.webhookDelivery.update({
            where: { id: row.id },
            data: {
              status: 'CLAIMED',
              leaseOwner: input.owner,
              leaseExpiresAt,
              attemptCount: { increment: 1 },
            },
          })
        }
        return rows.map((row) => ({
          id: row.id,
          eventId: row.event_id,
          subscriptionId: row.subscription_id,
          endpoint: row.endpoint,
          signingKeyRef: row.signing_key_ref,
          signingKeyVersion: row.signing_key_version,
          rawBody: row.raw_body,
          attemptCount: row.attempt_count + 1,
        }))
      })
    },

    async renewWebhookDeliveryLease(input) {
      if (!Number.isInteger(input.leaseSeconds) || input.leaseSeconds <= 0) {
        throw new InvalidStateError('Webhook delivery lease must be positive')
      }
      const now = input.now ?? new Date()
      const leaseExpiresAt = new Date(now.getTime() + input.leaseSeconds * 1000)
      const result = await prisma.webhookDelivery.updateMany({
        where: {
          id: input.id,
          status: 'CLAIMED',
          leaseOwner: input.owner,
          leaseExpiresAt: { gt: now },
        },
        data: { leaseExpiresAt },
      })
      if (result.count !== 1) {
        throw new ConflictError('Webhook delivery lease is no longer owned')
      }
      return leaseExpiresAt
    },

    async markWebhookDelivered(id, owner, responseStatus) {
      const result = await prisma.webhookDelivery.updateMany({
        where: { id, status: 'CLAIMED', leaseOwner: owner },
        data: {
          status: 'DELIVERED',
          responseStatus,
          leaseOwner: null,
          leaseExpiresAt: null,
        },
      })
      if (result.count !== 1)
        throw new ConflictError('Webhook delivery lease is no longer owned')
    },

    async retryWebhookDelivery(input) {
      await prisma.$transaction(async (transaction) => {
        const locked = await transaction.$queryRaw<readonly { id: string }[]>`
          SELECT id
          FROM "webhook_deliveries"
          WHERE id = ${input.id}
          FOR UPDATE
        `
        if (locked.length === 0)
          throw new NotFoundError('Webhook delivery was not found')
        const delivery = await transaction.webhookDelivery.findUnique({
          where: { id: input.id },
        })
        if (
          delivery === null ||
          delivery.status !== 'CLAIMED' ||
          delivery.leaseOwner !== input.owner
        ) {
          throw new ConflictError('Webhook delivery lease is no longer owned')
        }
        if (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1) {
          throw new ValidationError('Webhook maximum attempts must be positive')
        }
        const exhausted = delivery.attemptCount >= input.maxAttempts
        await transaction.webhookDelivery.update({
          where: { id: input.id },
          data: {
            status: exhausted ? 'EXHAUSTED' : 'RETRY_WAIT',
            availableAt: exhausted ? delivery.availableAt : input.retryAt,
            nextRetryAt: exhausted ? null : input.retryAt,
            errorSafe: input.errorSafe,
            leaseOwner: null,
            leaseExpiresAt: null,
          },
        })
        if (exhausted) {
          const subscription = await transaction.webhookSubscription.findUnique({
            where: { id: delivery.subscriptionId },
            select: { accountId: true },
          })
          await transaction.operationalException.upsert({
            where: { activeDedupeKey: `active:webhook:${input.id}` },
            create: {
              id: `opx_webhook_${randomId()}`,
              ...(subscription === null ? {} : { accountId: subscription.accountId }),
              resourceType: 'WEBHOOK_DELIVERY',
              resourceId: input.id,
              dedupeKey: `webhook:${input.id}`,
              activeDedupeKey: `active:webhook:${input.id}`,
              reasonCode: 'WEBHOOK_DELIVERY_EXHAUSTED',
              detailsJson: JSON.stringify({ error: input.errorSafe }),
            },
            update: {
              updatedAt: new Date(),
              detailsJson: JSON.stringify({ error: input.errorSafe }),
            },
          })
        }
      })
    },

    async createBackupVerification(input) {
      const verification = await prisma.backupRestoreVerification.create({
        data: {
          id: input.id,
          backupReference: input.backupReference,
          environment: input.environment,
          schemaVersion: input.schemaVersion,
          ...(input.custodyIdentity === undefined
            ? {}
            : { custodyIdentity: input.custodyIdentity }),
        },
      })
      return toBackupRecord(verification)
    },

    async finishBackupVerification(input) {
      const verification = await prisma.backupRestoreVerification.update({
        where: { id: input.id },
        data: {
          status: input.status,
          invariantSummaryJson: input.invariantSummaryJson,
          ...(input.failureSafe === undefined
            ? {}
            : { failureSafe: input.failureSafe }),
          ...(input.verifiedAt === undefined ? {} : { verifiedAt: input.verifiedAt }),
        },
      })
      return toBackupRecord(verification)
    },

    async findLatestBackupVerification() {
      const verification = await prisma.backupRestoreVerification.findFirst({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      })
      return verification === null ? null : toBackupRecord(verification)
    },
  }
}

async function resolveExceptionWithEvidence(
  prisma: PrismaClient,
  input: {
    readonly id: string
    readonly operatorId: string
    readonly rowVersion: number
    readonly evidenceId?: string
    readonly now?: Date
  },
  outcome: 'CONFIRMED' | 'PROVED_NO_EFFECT',
): Promise<V2OperationalExceptionRecord> {
  const now = input.now ?? new Date()
  return prisma.$transaction(async (transaction) => {
    const exception = await lockException(transaction, input.id, input.rowVersion)
    const payment = await findExceptionPayment(transaction, exception)
    if (payment === null)
      throw new InvalidStateError('Exception is not linked to a payment')
    const evidence = await transaction.evidenceRecord.findFirst({
      where: {
        paymentId: payment.id,
        ...(input.evidenceId === undefined ? {} : { id: input.evidenceId }),
        outcome,
      },
      orderBy: { observedAt: 'desc' },
    })
    if (evidence === null) {
      throw new ConflictError(`Authoritative ${outcome} evidence is required`)
    }
    const allowedAuthorities =
      outcome === 'CONFIRMED'
        ? new Set(['RAIL', 'SETTLEMENT_PROVIDER'])
        : new Set(['CUSTODY', 'LOCAL_STATE', 'RAIL', 'SETTLEMENT_PROVIDER'])
    if (!allowedAuthorities.has(evidence.authority)) {
      throw new ConflictError(`Authoritative ${outcome} evidence is required`)
    }
    const attempts = await transaction.paymentAttempt.findMany({
      where: { paymentId: payment.id },
      orderBy: { attemptNumber: 'asc' },
    })
    const currentAttempt = attempts.at(-1)
    if (currentAttempt === undefined)
      throw new InvalidStateError('Payment has no attempt')
    if (outcome === 'CONFIRMED') {
      if (
        attempts.some(
          (attempt) =>
            attempt.id !== currentAttempt.id &&
            !['CONFIRMED', 'PROVED_NO_EFFECT', 'PRE_EFFECT_ABORTED'].includes(
              attempt.outcome,
            ),
        )
      ) {
        throw new ConflictError(
          'Every earlier attempt requires authoritative resolution',
        )
      }
      if (currentAttempt.outcome === 'UNKNOWN') {
        assertAttemptProgression('UNKNOWN', 'CONFIRMED')
        await transaction.paymentAttempt.update({
          where: { id: currentAttempt.id },
          data: {
            outcome: 'CONFIRMED',
            status: 'CONFIRMED',
            rowVersion: { increment: 1 },
          },
        })
      } else if (currentAttempt.outcome !== 'CONFIRMED') {
        throw new ConflictError('Payment attempt is not awaiting confirmed resolution')
      }
      await transaction.payment.update({
        where: { id: payment.id },
        data: {
          status: 'CONFIRMED',
          executionState: 'TERMINAL',
          settlementState: 'CONFIRMED',
          outcomeState: 'CONFIRMED',
          confirmedAt: now,
          rowVersion: { increment: 1 },
        },
      })
      await transaction.outgoingReservation.updateMany({
        where: { paymentId: payment.id, status: 'ACTIVE', lifecycleState: 'HELD' },
        data: {
          lifecycleState: 'CONSUMED',
          status: 'ACTIVE',
          consumedAt: now,
          rowVersion: { increment: 1 },
        },
      })
    } else {
      if (currentAttempt.outcome === 'UNKNOWN') {
        assertAttemptProgression('UNKNOWN', 'PROVED_NO_EFFECT')
        await transaction.paymentAttempt.update({
          where: { id: currentAttempt.id },
          data: {
            outcome: 'PROVED_NO_EFFECT',
            status: 'FAILED',
            rowVersion: { increment: 1 },
          },
        })
      } else if (
        !['PROVED_NO_EFFECT', 'PRE_EFFECT_ABORTED'].includes(currentAttempt.outcome)
      ) {
        throw new ConflictError('Payment attempt is not awaiting no-effect resolution')
      }
      const allNoEffect = attempts.every((attempt) =>
        attempt.id === currentAttempt.id
          ? true
          : ['PROVED_NO_EFFECT', 'PRE_EFFECT_ABORTED'].includes(attempt.outcome),
      )
      await transaction.payment.update({
        where: { id: payment.id },
        data: allNoEffect
          ? {
              status: 'PROVED_NO_EFFECT',
              executionState: 'TERMINAL',
              settlementState: 'NOT_SUBMITTED',
              outcomeState: 'PROVED_NO_EFFECT',
              rowVersion: { increment: 1 },
            }
          : {
              status: 'REVIEW_REQUIRED',
              executionState: 'RECONCILING',
              settlementState: 'UNKNOWN',
              outcomeState: 'UNDETERMINED',
              rowVersion: { increment: 1 },
            },
      })
      if (allNoEffect) {
        await transaction.outgoingReservation.updateMany({
          where: { paymentId: payment.id, status: 'ACTIVE', lifecycleState: 'HELD' },
          data: {
            status: 'RELEASED',
            lifecycleState: 'RELEASED',
            releaseReason: 'OPERATOR_PROVED_NO_EFFECT',
            releasedAt: now,
            rowVersion: { increment: 1 },
          },
        })
      }
    }
    await appendOperatorTimeline(
      transaction,
      payment.accountId,
      payment.id,
      `PAYMENT_RESOLVED_${outcome}`,
      input.operatorId,
      now,
    )
    const updated = await transaction.operationalException.update({
      where: { id: exception.id },
      data: {
        status: 'RESOLVED',
        assignedTo: input.operatorId,
        resolvedAt: now,
        activeDedupeKey: null,
        rowVersion: { increment: 1 },
      },
    })
    return toExceptionRecord(updated)
  })
}

async function lockException(
  transaction: Prisma.TransactionClient,
  id: string,
  rowVersion: number,
) {
  const locked = await transaction.$queryRaw<readonly { id: string }[]>`
    SELECT id
    FROM "operational_exceptions"
    WHERE id = ${id}
    FOR UPDATE
  `
  if (locked.length === 0)
    throw new NotFoundError('Operational exception was not found')
  const exception = await transaction.operationalException.findUnique({ where: { id } })
  if (exception === null) throw new NotFoundError('Operational exception was not found')
  if (exception.rowVersion !== rowVersion)
    throw new ConflictError('Exception changed concurrently')
  if (!['OPEN', 'ACKNOWLEDGED'].includes(exception.status)) {
    throw new ConflictError('Operational exception is already terminal')
  }
  return exception
}

async function findExceptionPayment(
  transaction: Prisma.TransactionClient,
  exception: { readonly resourceType: string; readonly resourceId: string },
) {
  let paymentId: string | null = null
  if (exception.resourceType === 'PAYMENT') {
    paymentId = exception.resourceId
  } else if (exception.resourceType === 'PAYMENT_ATTEMPT') {
    const attempt = await transaction.paymentAttempt.findUnique({
      where: { id: exception.resourceId },
      select: { paymentId: true },
    })
    paymentId = attempt?.paymentId ?? null
  }
  if (paymentId === null) return null
  const locked = await transaction.$queryRaw<readonly { id: string }[]>`
    SELECT id
    FROM "payments"
    WHERE id = ${paymentId}
    FOR UPDATE
  `
  if (locked.length === 0) return null
  const payment = await transaction.payment.findUnique({
    where: { id: paymentId },
    select: { id: true, payerAccountId: true, status: true },
  })
  return payment === null
    ? null
    : { id: payment.id, accountId: payment.payerAccountId, status: payment.status }
}

async function appendOperatorTimeline(
  transaction: Prisma.TransactionClient,
  accountId: string,
  paymentId: string,
  eventType: string,
  operatorId: string,
  occurredAt: Date,
): Promise<void> {
  await transaction.operationTimelineEvent.create({
    data: {
      id: `timeline_${randomId()}`,
      accountId,
      resourceType: 'PAYMENT',
      resourceId: paymentId,
      eventType,
      actorType: 'OPERATOR',
      actorId: operatorId,
      source: 'V2_OPERATOR_CONTROL_PLANE',
      occurredAt,
    },
  })
}

function toTimelineRecord(event: {
  id: string
  accountId: string | null
  resourceType: string
  resourceId: string
  eventType: string
  actorType: string
  actorId: string | null
  requestId: string | null
  correlationId: string | null
  oldStateJson: string | null
  newStateJson: string | null
  source: string
  occurredAt: Date
  metadataJson: string
}): V2TimelineRecord {
  return event
}

function toExceptionRecord(exception: {
  id: string
  accountId: string | null
  resourceType: string
  resourceId: string
  dedupeKey: string
  status: string
  severity: string
  reasonCode: string
  detailsJson: string
  assignedTo: string | null
  rowVersion: number
  createdAt: Date
  updatedAt: Date
  acknowledgedAt: Date | null
  resolvedAt: Date | null
}): V2OperationalExceptionRecord {
  return exception
}

function toCostRecord(cost: {
  id: string
  accountId: string
  paymentId: string | null
  attemptId: string | null
  assetId: string
  estimatedAmount: bigint
  actualAmount: bigint | null
  reconciliationStatus: string
  observedAt: Date | null
  createdAt: Date
  updatedAt: Date
}): V2PlatformCostRecord {
  return cost
}

function toSubscriptionRecord(subscription: {
  id: string
  accountId: string
  endpoint: string
  eventTypesJson: string
  status: string
  signingKeyRef: string
  signingKeyVersion: number
  createdAt: Date
  archivedAt: Date | null
}): V2WebhookSubscriptionRecord {
  return {
    id: subscription.id,
    accountId: subscription.accountId,
    endpoint: subscription.endpoint,
    eventTypes: parseStringArray(subscription.eventTypesJson),
    status: subscription.status,
    signingKeyRef: subscription.signingKeyRef,
    signingKeyVersion: subscription.signingKeyVersion,
    createdAt: subscription.createdAt,
    archivedAt: subscription.archivedAt,
  }
}

function toBackupRecord(verification: {
  id: string
  backupReference: string
  environment: string
  status: string
  schemaVersion: string
  invariantSummaryJson: string
  custodyIdentity: string | null
  verifiedAt: Date | null
  failureSafe: string | null
  createdAt: Date
}): V2BackupRestoreVerificationRecord {
  return verification
}

function parseStringArray(value: string): readonly string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(value) as unknown
  } catch {
    throw new InvalidStateError('Webhook event type metadata is corrupt')
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw new InvalidStateError('Webhook event type metadata is corrupt')
  }
  return parsed
}

function validateWebhookEndpoint(endpoint: string): void {
  let parsed: URL
  try {
    parsed = new URL(endpoint)
  } catch {
    throw new ValidationError('Webhook endpoint must be a valid URL')
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username.length > 0 ||
    parsed.password.length > 0
  ) {
    throw new ValidationError(
      'Webhook endpoint must use HTTPS without embedded credentials',
    )
  }
}

function randomId(): string {
  return randomBytes(16).toString('hex')
}
