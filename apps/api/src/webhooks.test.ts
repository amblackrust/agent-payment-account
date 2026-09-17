import { createHmac } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { V2OperationsRepository, V2WebhookDeliveryClaim } from '@agent-payment/db'
import { verifyWebhookSignature, WebhookDeliveryWorker } from './webhooks.js'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

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
    ...overrides,
  } as V2OperationsRepository
}

describe('webhook delivery worker', () => {
  it('signs the exact durable body and acknowledges a successful delivery', async () => {
    const delivered: { id: string; owner: string; status: number }[] = []
    const key = new TextEncoder().encode('webhook-secret')
    const currentClaim = claim()
    const now = new Date('2026-09-18T00:00:00.000Z')
    const timestamp = Math.floor(now.getTime() / 1_000)
    const expectedSignature = createHmac('sha256', key)
      .update(`${timestamp}.${currentClaim.rawBody}`, 'utf8')
      .digest('hex')
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.body).toBe(currentClaim.rawBody)
      expect(new Headers(init?.headers).get('x-mux-signature')).toBe(
        `sha256=${expectedSignature}`,
      )
      expect(new Headers(init?.headers).get('x-mux-timestamp')).toBe(String(timestamp))
      expect(new Headers(init?.headers).get('x-mux-event-id')).toBe(
        currentClaim.eventId,
      )
      return new Response(null, { status: 204 })
    })
    globalThis.fetch = fetchMock as typeof globalThis.fetch
    const worker = new WebhookDeliveryWorker({
      repository: repository(currentClaim, {
        markWebhookDelivered: async (id, owner, status) => {
          delivered.push({ id, owner, status })
        },
      }),
      signingKeys: { getKey: async () => key },
      owner: 'webhook-worker-1',
      now: () => now,
    })

    await worker.runOnce()

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(delivered).toEqual([
      { id: 'delivery_1', owner: 'webhook-worker-1', status: 204 },
    ])
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
    globalThis.fetch = vi.fn(
      async () => new Response(null, { status: 503 }),
    ) as typeof globalThis.fetch
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
