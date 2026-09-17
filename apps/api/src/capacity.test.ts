import { describe, expect, it, vi } from 'vitest'

import { DEFAULT_RUNTIME_LIMITS } from './config.js'
import { DurableCapacityController, retryAtAfter } from './capacity.js'

describe('durable runtime capacity', () => {
  it('uses one durable global bucket for every replica', async () => {
    const consumeRateLimit = vi.fn(
      async (input: {
        readonly subjectType: string
        readonly subjectId: string
        readonly bucket: string
        readonly windowSeconds: number
        readonly limit: number
      }) => ({
        allowed: true,
        count: 1,
        retryAt: new Date('2026-09-18T00:00:01.000Z'),
        input,
      }),
    )
    const controller = new DurableCapacityController(
      { consumeRateLimit },
      {
        ...DEFAULT_RUNTIME_LIMITS,
        capacityWindowSeconds: 5,
        rpcCapacityPerWindow: 7,
      },
    )

    await controller.acquire('rpc', new Date('2026-09-18T00:00:00.000Z'))

    expect(consumeRateLimit).toHaveBeenCalledWith({
      subjectType: 'RUNTIME_CAPACITY',
      subjectId: 'global',
      bucket: 'rpc',
      windowSeconds: 5,
      limit: 7,
      now: new Date('2026-09-18T00:00:00.000Z'),
    })
  })

  it('keeps the later of the durable and exponential retry times', () => {
    expect(
      retryAtAfter(
        new Date('2026-09-18T00:00:10.000Z'),
        new Date('2026-09-18T00:00:05.000Z'),
      ),
    ).toEqual(new Date('2026-09-18T00:00:10.000Z'))
    expect(
      retryAtAfter(
        new Date('2026-09-18T00:00:05.000Z'),
        new Date('2026-09-18T00:00:10.000Z'),
      ),
    ).toEqual(new Date('2026-09-18T00:00:10.000Z'))
  })
})
