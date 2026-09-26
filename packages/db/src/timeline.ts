import type { Prisma } from './generated/client/client.js'

export interface TimelineEventInput {
  readonly id: string
  readonly accountId?: string | undefined
  readonly resourceType: string
  readonly resourceId: string
  readonly eventType: string
  readonly actorType: string
  readonly actorId?: string | undefined
  readonly requestId?: string | undefined
  readonly correlationId?: string | undefined
  readonly oldStateJson?: string | undefined
  readonly newStateJson?: string | undefined
  readonly source: string
  readonly occurredAt?: Date | undefined
  readonly metadataJson?: string | undefined
}

export async function createTimelineEvent(
  transaction: Prisma.TransactionClient,
  input: TimelineEventInput,
): Promise<void> {
  await transaction.operationTimelineEvent.create({
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
      ...(input.oldStateJson === undefined ? {} : { oldStateJson: input.oldStateJson }),
      ...(input.newStateJson === undefined ? {} : { newStateJson: input.newStateJson }),
      source: input.source,
      occurredAt: input.occurredAt ?? new Date(),
      metadataJson: input.metadataJson ?? '{}',
    },
  })
}
