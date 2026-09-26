import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  assertSafeWebhookAddress,
  assertSafeWebhookEndpoint,
  type V2OperationsRepository,
  type V2WebhookDeliveryClaim,
} from '@agent-payment/db'
import {
  verifyWebhookSignature,
  WebhookDeliveryWorker,
  type WebhookDeliveryRequest,
  type WebhookResolvedAddress,
} from './webhooks.js'

const publicAddress: WebhookResolvedAddress = {
  address: '93.184.216.34',
  family: 4,
}

const resolvePublicHostname = async (): Promise<readonly WebhookResolvedAddress[]> => [
  publicAddress,
]

function claim(
  overrides: Partial<V2WebhookDeliveryClaim> = {},
): V2WebhookDeliveryClaim {
  return {
    id: 'delivery_1',
    eventId: 'evt_1',
    subscriptionId: 'subscription_1',
    endpoint: 'https://merchant.example.test/webhook',
    signingKeyRef: 'secret/webhook/1',
    signingKeyVersion: 3,
    rawBody: '{"id":"evt_1"}',
    attemptCount: 1,
    ...overrides,
  }
}

function repository(
  currentClaim: V2WebhookDeliveryClaim,
  overrides: Partial<V2OperationsRepository> = {},
): V2OperationsRepository {
  return {
    claimWebhookDeliveries: async () => [currentClaim],
    markWebhookDelivered: async () => undefined,
    retryWebhookDelivery: async () => undefined,
    deferWebhookDelivery: async () => undefined,
    ...overrides,
  } as V2OperationsRepository
}

describe('webhook delivery worker', () => {
  it('passes the retry bound to the durable claim operation', async () => {
    const claimWebhookDeliveries = vi.fn(async () => [])
    const worker = new WebhookDeliveryWorker({
      repository: repository(claim({ id: 'delivery_1' }), { claimWebhookDeliveries }),
      signingKeys: { getKey: async () => new TextEncoder().encode('webhook-secret') },
      owner: 'webhook-worker-1',
      maxAttempts: 3,
    })

    await worker.runOnce()

    expect(claimWebhookDeliveries).toHaveBeenCalledWith(
      expect.objectContaining({ maxAttempts: 3 }),
    )
  })

  it('signs the exact durable body and acknowledges a successful delivery', async () => {
    const delivered: { id: string; owner: string; status: number }[] = []
    const key = new TextEncoder().encode('webhook-secret')
    const currentClaim = claim()
    const now = new Date('2026-09-18T00:00:00.000Z')
    const timestamp = Math.floor(now.getTime() / 1_000)
    const expectedSignature = createHmac('sha256', key)
      .update(`${timestamp}.${currentClaim.rawBody}`, 'utf8')
      .digest('hex')
    const sendMock = vi.fn(async (input: WebhookDeliveryRequest) => {
      expect(input.body).toBe(currentClaim.rawBody)
      expect(input.headers['x-mux-signature']).toBe(`sha256=${expectedSignature}`)
      expect(input.headers['x-mux-timestamp']).toBe(String(timestamp))
      expect(input.headers['x-mux-event-id']).toBe(currentClaim.eventId)
      expect(input.address).toEqual(publicAddress)
      return { ok: true, status: 204 }
    })
    const worker = new WebhookDeliveryWorker({
      repository: repository(currentClaim, {
        markWebhookDelivered: async (id, owner, status) => {
          delivered.push({ id, owner, status })
        },
      }),
      signingKeys: { getKey: async () => key },
      owner: 'webhook-worker-1',
      now: () => now,
      resolveHostname: resolvePublicHostname,
      send: sendMock,
    })

    await worker.runOnce()

    expect(sendMock).toHaveBeenCalledOnce()
    expect(delivered).toEqual([
      { id: 'delivery_1', owner: 'webhook-worker-1', status: 204 },
    ])
  })

  it('rejects private, loopback, and local-only webhook endpoints', () => {
    expect(() => assertSafeWebhookEndpoint('https://127.0.0.1/webhook')).toThrow(
      'public address',
    )
    expect(() => assertSafeWebhookEndpoint('https://[::1]/webhook')).toThrow(
      'public address',
    )
    expect(() => assertSafeWebhookEndpoint('https://[ff02::1]/webhook')).toThrow(
      'public address',
    )
    expect(() => assertSafeWebhookEndpoint('https://[::ffff:7f00:1]/webhook')).toThrow(
      'public address',
    )
    expect(() => assertSafeWebhookAddress('::ffff:7f00:1')).toThrow('public address')
    expect(() => assertSafeWebhookEndpoint('https://service.internal/webhook')).toThrow(
      'public address',
    )
    expect(() =>
      assertSafeWebhookEndpoint('https://merchant.example.test/webhook'),
    ).not.toThrow()
  })

  it('rejects a public-looking hostname that resolves to a private address', async () => {
    const retries: unknown[] = []
    const sendMock = vi.fn()
    const worker = new WebhookDeliveryWorker({
      repository: repository(claim(), {
        retryWebhookDelivery: async (input) => {
          retries.push(input)
        },
      }),
      signingKeys: { getKey: async () => new TextEncoder().encode('webhook-secret') },
      owner: 'webhook-worker-1',
      resolveHostname: async () => [{ address: '127.0.0.1', family: 4 }],
      send: sendMock,
    })

    await worker.runOnce()

    expect(sendMock).not.toHaveBeenCalled()
    expect(retries).toHaveLength(1)
  })

  it('rejects IPv4-mapped loopback and multicast IPv6 resolver results', async () => {
    for (const address of ['::ffff:7f00:1', 'ff02::1']) {
      const retries: unknown[] = []
      const sendMock = vi.fn()
      const worker = new WebhookDeliveryWorker({
        repository: repository(claim(), {
          retryWebhookDelivery: async (input) => {
            retries.push(input)
          },
        }),
        signingKeys: { getKey: async () => new TextEncoder().encode('webhook-secret') },
        owner: 'webhook-worker-1',
        resolveHostname: async () => [{ address, family: 6 }],
        send: sendMock,
      })

      await worker.runOnce()

      expect(sendMock).not.toHaveBeenCalled()
      expect(retries).toHaveLength(1)
    }
  })

  it('moves a DNS resolution timeout to the durable retry path', async () => {
    const retries: unknown[] = []
    const sendMock = vi.fn()
    const worker = new WebhookDeliveryWorker({
      repository: repository(claim(), {
        retryWebhookDelivery: async (input) => {
          retries.push(input)
        },
      }),
      signingKeys: { getKey: async () => new TextEncoder().encode('webhook-secret') },
      owner: 'webhook-worker-1',
      timeoutMs: 10,
      resolveHostname: async () => await new Promise<never>(() => undefined),
      send: sendMock,
    })

    await worker.runOnce()

    expect(sendMock).not.toHaveBeenCalled()
    expect(retries).toHaveLength(1)
    expect(retries[0]).toMatchObject({
      id: 'delivery_1',
      errorSafe: 'Webhook delivery failed',
    })
  })

  it('verifies the timestamp-bound signature and rejects stale or modified deliveries', () => {
    const key = new TextEncoder().encode('webhook-secret')
    const rawBody = '{"id":"evt_1"}'
    const now = new Date('2026-09-18T00:00:00.000Z')
    const timestamp = String(Math.floor(now.getTime() / 1_000))
    const signature = createHmac('sha256', key)
      .update(`${timestamp}.${rawBody}`, 'utf8')
      .digest('hex')

    expect(
      verifyWebhookSignature({
        rawBody,
        timestamp,
        signature: `sha256=${signature}`,
        key,
        now,
      }),
    ).toBe(true)
    expect(
      verifyWebhookSignature({
        rawBody,
        timestamp: String(Number(timestamp) - 301),
        signature: `sha256=${signature}`,
        key,
        now,
      }),
    ).toBe(false)
    expect(
      verifyWebhookSignature({
        rawBody: '{"id":"tampered"}',
        timestamp,
        signature: `sha256=${signature}`,
        key,
        now,
      }),
    ).toBe(false)
  })

  it('moves failed deliveries to the durable retry path', async () => {
    const retries: unknown[] = []
    const currentClaim = claim({ attemptCount: 2 })
    const sendMock = vi.fn(async () => ({ ok: false, status: 503 }))
    const worker = new WebhookDeliveryWorker({
      repository: repository(currentClaim, {
        retryWebhookDelivery: async (input) => {
          retries.push(input)
        },
      }),
      signingKeys: { getKey: async () => new TextEncoder().encode('webhook-secret') },
      owner: 'webhook-worker-1',
      maxAttempts: 3,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
      resolveHostname: resolvePublicHostname,
      send: sendMock,
    })

    await worker.runOnce()

    expect(retries).toHaveLength(1)
    expect(retries[0]).toMatchObject({
      id: 'delivery_1',
      owner: 'webhook-worker-1',
      maxAttempts: 3,
      errorSafe: 'Webhook endpoint returned HTTP 503',
    })
  })

  it('defers delivery when the shared webhook capacity is exhausted', async () => {
    const deferrals: unknown[] = []
    const currentClaim = claim()
    const retryAt = new Date('2026-09-18T00:01:00.000Z')
    const sendMock = vi.fn()
    const worker = new WebhookDeliveryWorker({
      repository: repository(currentClaim, {
        deferWebhookDelivery: async (input) => {
          deferrals.push(input)
        },
      }),
      signingKeys: { getKey: async () => new TextEncoder().encode('webhook-secret') },
      owner: 'webhook-worker-1',
      maxAttempts: 3,
      now: () => new Date('2026-09-18T00:00:00.000Z'),
      resolveHostname: resolvePublicHostname,
      send: sendMock,
      capacity: {
        acquire: async () => ({ allowed: false, count: 51, retryAt }),
      },
    })

    await worker.runOnce()

    expect(sendMock).not.toHaveBeenCalled()
    expect(deferrals).toHaveLength(1)
    expect(deferrals[0]).toMatchObject({
      id: currentClaim.id,
      retryAt,
      errorSafe: 'Webhook delivery capacity is temporarily exhausted',
    })
  })

  it('does not overlap concurrent runs for one worker owner', async () => {
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    let claims = 0
    const currentClaim = claim()
    const repositoryInstance = repository(currentClaim, {
      claimWebhookDeliveries: async () => {
        claims += 1
        await blocked
        return []
      },
    })
    const worker = new WebhookDeliveryWorker({
      repository: repositoryInstance,
      signingKeys: { getKey: async () => new TextEncoder().encode('secret') },
      owner: 'webhook-worker-1',
    })

    const first = worker.runOnce()
    const second = worker.runOnce()
    release()
    await Promise.all([first, second])

    expect(claims).toBe(1)
  })
})
