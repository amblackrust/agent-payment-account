import { describe, expect, it, vi } from 'vitest'

import { createV2OperationsRepository } from './v2-operations.js'

describe('V2 webhook delivery claims', () => {
  it('adds the durable maximum-attempt bound to webhook claims', async () => {
    const queryRaw = vi.fn(async (..._args: unknown[]) => [])
    const transaction = {
      $queryRaw: queryRaw,
      webhookDelivery: { update: vi.fn() },
    }
    const prisma = {
      $transaction: vi.fn(async (callback: (value: typeof transaction) => unknown) =>
        callback(transaction),
      ),
    }
    const now = new Date('2026-09-18T00:00:00.000Z')

    const claims = await createV2OperationsRepository(
      prisma as never,
    ).claimWebhookDeliveries({
      limit: 1,
      owner: 'webhook-worker-1',
      leaseSeconds: 30,
      maxAttempts: 3,
      now,
    })

    expect(claims).toEqual([])
    const call = queryRaw.mock.calls.find(([template]) =>
      (template as readonly string[]).join('').includes('delivery.attempt_count <'),
    )
    if (call === undefined) throw new Error('Expected the claim query to be executed')
    const [template, ...values] = call
    expect((template as readonly string[]).join('')).toContain(
      'delivery.attempt_count <',
    )
    expect(values).toContain(3)
  })
})
