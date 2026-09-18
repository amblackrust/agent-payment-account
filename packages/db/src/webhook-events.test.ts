import { describe, expect, it, vi } from 'vitest'
import { InvalidStateError } from '@agent-payment/core'
import { enqueueWebhookEvent } from './webhook-events.js'

function createTransaction(eventExists = false, eventTypes = ['payment.updated']) {
  return {
    webhookEvent: {
      createMany: vi.fn(async (_input: { data: Record<string, unknown> }) => ({
        count: eventExists ? 0 : 1,
      })),
    },
    webhookSubscription: {
      findMany: vi.fn(async () => [
        {
          id: 'subscription_1',
          eventTypesJson: JSON.stringify(eventTypes),
          status: 'ACTIVE',
        },
        {
          id: 'subscription_2',
          eventTypesJson: JSON.stringify(['*']),
          status: 'ACTIVE',
        },
      ]),
    },
    webhookDelivery: {
      createMany: vi.fn(async ({ data }: { data: Record<string, unknown>[] }) => ({
        count: data.length,
      })),
    },
  }
}

describe('enqueueWebhookEvent', () => {
  it('persists one stable envelope and matching deliveries', async () => {
    const transaction = createTransaction()

    await enqueueWebhookEvent(transaction as never, {
      accountId: 'acct_1',
      resourceType: 'PAYMENT',
      resourceId: 'pay_1',
      resourceVersion: 2,
      eventType: 'payment.updated',
      resource: { id: 'pay_1', status: 'CONFIRMED' },
    })

    expect(transaction.webhookEvent.createMany).toHaveBeenCalledOnce()
    expect(transaction.webhookDelivery.createMany).toHaveBeenCalledOnce()
    expect(transaction.webhookEvent.createMany.mock.calls[0]?.[0].data).toMatchObject({
      eventId: 'payment:pay_1:2:payment.updated',
      resourceType: 'PAYMENT',
      resourceVersion: 2,
      eventType: 'payment.updated',
      eventVersion: 'v2',
      rawBody: JSON.stringify({
        id: 'payment:pay_1:2:payment.updated',
        type: 'payment.updated',
        version: 'v2',
        resource: { id: 'pay_1', status: 'CONFIRMED' },
      }),
    })
  })

  it('does not duplicate an existing event', async () => {
    const transaction = createTransaction(true)

    await enqueueWebhookEvent(transaction as never, {
      accountId: 'acct_1',
      resourceType: 'PAYMENT',
      resourceId: 'pay_1',
      resourceVersion: 2,
      eventType: 'payment.updated',
      resource: { id: 'pay_1' },
    })

    expect(transaction.webhookEvent.createMany).toHaveBeenCalledOnce()
    expect(transaction.webhookDelivery.createMany).not.toHaveBeenCalled()
  })

  it('fails closed when subscription event metadata is corrupt', async () => {
    const transaction = createTransaction(false, ['payment.updated'])
    transaction.webhookSubscription.findMany.mockResolvedValue([
      { id: 'subscription_1', eventTypesJson: '{bad', status: 'ACTIVE' },
    ])

    await expect(
      enqueueWebhookEvent(transaction as never, {
        accountId: 'acct_1',
        resourceType: 'PAYMENT',
        resourceId: 'pay_1',
        resourceVersion: 2,
        eventType: 'payment.updated',
        resource: { id: 'pay_1' },
      }),
    ).rejects.toBeInstanceOf(InvalidStateError)
  })
})
