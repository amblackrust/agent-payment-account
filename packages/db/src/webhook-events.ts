import { randomBytes } from 'node:crypto'
import { InvalidStateError } from '@agent-payment/core'
import type { Prisma } from './generated/client/client.js'

const WEBHOOK_EVENT_VERSION = 'v2'

export async function enqueueWebhookEvent(
  transaction: Prisma.TransactionClient,
  input: {
    readonly accountId: string
    readonly resourceType: string
    readonly resourceId: string
    readonly resourceVersion: number
    readonly eventType: string
    readonly resource: Readonly<Record<string, unknown>>
    readonly correlationId?: string
    readonly eventId?: string
  },
): Promise<void> {
  const eventId =
    input.eventId ??
    `${input.resourceType.toLowerCase()}:${input.resourceId}:${input.resourceVersion}:${input.eventType}`
  const inserted = await transaction.webhookEvent.createMany({
    data: {
      id: `webhook_${randomBytes(16).toString('hex')}`,
      eventId,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      resourceVersion: input.resourceVersion,
      eventType: input.eventType,
      eventVersion: WEBHOOK_EVENT_VERSION,
      ...(input.correlationId === undefined
        ? {}
        : { correlationId: input.correlationId }),
      rawBody: JSON.stringify({
        id: eventId,
        type: input.eventType,
        version: WEBHOOK_EVENT_VERSION,
        ...(input.correlationId === undefined
          ? {}
          : { correlation_id: input.correlationId }),
        resource: input.resource,
      }),
    },
    skipDuplicates: true,
  })
  if (inserted.count === 0) return

  const subscriptions = await transaction.webhookSubscription.findMany({
    where: { accountId: input.accountId, status: 'ACTIVE' },
  })
  const matchingSubscriptions = subscriptions.filter((subscription) => {
    const eventTypes = parseEventTypes(subscription.eventTypesJson)
    return eventTypes.includes(input.eventType) || eventTypes.includes('*')
  })
  if (matchingSubscriptions.length === 0) return
  await transaction.webhookDelivery.createMany({
    data: matchingSubscriptions.map((subscription) => ({
      id: `delivery_${randomBytes(16).toString('hex')}`,
      eventId,
      subscriptionId: subscription.id,
      deliveryNumber: 1,
    })),
    skipDuplicates: true,
  })
}

function parseEventTypes(value: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(value)
    if (
      !Array.isArray(parsed) ||
      parsed.some((eventType) => typeof eventType !== 'string')
    ) {
      throw new Error('invalid event types')
    }
    return parsed
  } catch {
    throw new InvalidStateError('Webhook event type metadata is corrupt')
  }
}
