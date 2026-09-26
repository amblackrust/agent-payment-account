import { randomBytes } from 'node:crypto'
import { InvalidStateError, NotFoundError, ValidationError } from '@agent-payment/core'
import type {
  V2OperationalExceptionRecord,
  V2OperationsRepository,
  V2TimelineRecord,
  V2WebhookSubscriptionRecord,
} from '@agent-payment/db'

const MAX_PAGE_SIZE = 100

export class V2OperationsService {
  private readonly maxPageSize: number

  public constructor(
    private readonly repository: V2OperationsRepository,
    options: { readonly maxPageSize?: number } = {},
  ) {
    this.maxPageSize = options.maxPageSize ?? MAX_PAGE_SIZE
    if (!Number.isInteger(this.maxPageSize) || this.maxPageSize < 1) {
      throw new InvalidStateError('Maximum page size must be a positive integer')
    }
  }

  public async listTimeline(
    accountId: string,
    input: {
      readonly limit?: number
      readonly cursor?: string
      readonly resourceType?: string
      readonly resourceId?: string
    } = {},
  ) {
    const limit = this.validateLimit(input.limit)
    const cursor = decodeCursor(input.cursor)
    const records = await this.repository.listTimeline({
      accountId,
      limit: limit + 1,
      ...(cursor === undefined ? {} : { cursor }),
      ...(input.resourceType === undefined ? {} : { resourceType: input.resourceType }),
      ...(input.resourceId === undefined ? {} : { resourceId: input.resourceId }),
    })
    const visible = records.slice(0, limit)
    return {
      items: visible.map(serializeTimeline),
      next_cursor:
        records.length > limit && visible.at(-1) !== undefined
          ? encodeCursor(visible.at(-1)!.occurredAt, visible.at(-1)!.id)
          : null,
    }
  }

  public async listExceptions(
    input: {
      readonly accountId?: string
      readonly status?: string
      readonly limit?: number
    } = {},
  ) {
    return (
      await this.repository.listExceptions({
        ...(input.accountId === undefined ? {} : { accountId: input.accountId }),
        ...(input.status === undefined ? {} : { status: input.status }),
        limit: this.validateLimit(input.limit),
      })
    ).map(serializeException)
  }

  public async getException(id: string) {
    const exception = await this.repository.findException(id)
    if (exception === null)
      throw new NotFoundError('Operational exception was not found')
    return serializeException(exception)
  }

  public async acknowledgeException(input: {
    readonly id: string
    readonly operatorId: string
    readonly rowVersion: number
  }) {
    return serializeException(await this.repository.acknowledgeException(input))
  }

  public async resolveConfirmedException(input: {
    readonly id: string
    readonly operatorId: string
    readonly rowVersion: number
    readonly evidenceId?: string
  }) {
    return serializeException(await this.repository.resolveConfirmedException(input))
  }

  public async resolveProvedNoEffectException(input: {
    readonly id: string
    readonly operatorId: string
    readonly rowVersion: number
    readonly evidenceId?: string
  }) {
    return serializeException(
      await this.repository.resolveProvedNoEffectException(input),
    )
  }

  public async closeUnresolvedException(input: {
    readonly id: string
    readonly operatorId: string
    readonly rowVersion: number
  }) {
    return serializeException(await this.repository.closeUnresolvedException(input))
  }

  public async listWebhooks(accountId: string) {
    return (await this.repository.listWebhookSubscriptions(accountId)).map(
      serializeSubscription,
    )
  }

  public async createWebhook(input: {
    readonly accountId: string
    readonly endpoint: string
    readonly eventTypes: readonly string[]
    readonly signingKeyRef: string
    readonly signingKeyVersion: number
  }) {
    return serializeSubscription(
      await this.repository.createWebhookSubscription({
        id: createId('whsub'),
        ...input,
      }),
    )
  }

  public async archiveWebhook(accountId: string, id: string): Promise<void> {
    await this.repository.archiveWebhookSubscription(accountId, id)
  }

  private validateLimit(limit: number | undefined): number {
    const value = limit ?? 50
    if (!Number.isInteger(value) || value < 1 || value > this.maxPageSize) {
      throw new ValidationError(
        `Limit must be an integer from 1 to ${this.maxPageSize}`,
      )
    }
    return value
  }
}

function serializeTimeline(event: V2TimelineRecord) {
  return {
    id: event.id,
    account_id: event.accountId,
    resource_type: event.resourceType,
    resource_id: event.resourceId,
    event_type: event.eventType,
    actor_type: event.actorType,
    actor_id: event.actorId,
    request_id: event.requestId,
    correlation_id: event.correlationId,
    old_state: parseJson(event.oldStateJson),
    new_state: parseJson(event.newStateJson),
    source: event.source,
    occurred_at: event.occurredAt.toISOString(),
    metadata: parseJson(event.metadataJson),
  }
}

function serializeException(exception: V2OperationalExceptionRecord) {
  return {
    id: exception.id,
    account_id: exception.accountId,
    resource_type: exception.resourceType,
    resource_id: exception.resourceId,
    dedupe_key: exception.dedupeKey,
    status: exception.status,
    severity: exception.severity,
    reason_code: exception.reasonCode,
    details: parseJson(exception.detailsJson),
    assigned_to: exception.assignedTo,
    row_version: exception.rowVersion,
    created_at: exception.createdAt.toISOString(),
    updated_at: exception.updatedAt.toISOString(),
    acknowledged_at: exception.acknowledgedAt?.toISOString() ?? null,
    resolved_at: exception.resolvedAt?.toISOString() ?? null,
  }
}

function serializeSubscription(subscription: V2WebhookSubscriptionRecord) {
  return {
    id: subscription.id,
    account_id: subscription.accountId,
    endpoint: subscription.endpoint,
    event_types: [...subscription.eventTypes],
    status: subscription.status,
    signing_key_ref: subscription.signingKeyRef,
    signing_key_version: subscription.signingKeyVersion,
    created_at: subscription.createdAt.toISOString(),
    archived_at: subscription.archivedAt?.toISOString() ?? null,
  }
}

function parseJson(value: string | null): unknown {
  if (value === null) return null
  try {
    return JSON.parse(value) as unknown
  } catch {
    throw new InvalidStateError('Operation metadata is corrupt')
  }
}

function encodeCursor(occurredAt: Date, id: string): string {
  return Buffer.from(
    JSON.stringify({ occurred_at: occurredAt.toISOString(), id }),
    'utf8',
  ).toString('base64url')
}

function decodeCursor(
  value: string | undefined,
): { readonly occurredAt: Date; readonly id: string } | undefined {
  if (value === undefined) return undefined
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as {
      occurred_at?: unknown
      id?: unknown
    }
    if (typeof parsed.occurred_at !== 'string' || typeof parsed.id !== 'string') {
      throw new Error('invalid cursor')
    }
    const occurredAt = new Date(parsed.occurred_at)
    if (Number.isNaN(occurredAt.getTime())) throw new Error('invalid cursor')
    return { occurredAt, id: parsed.id }
  } catch {
    throw new ValidationError('Timeline cursor is invalid')
  }
}

function createId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString('hex')}`
}
