import { createHmac, timingSafeEqual } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { request as httpsRequest } from 'node:https'
import { computeRetryAt } from '@agent-payment/core'
import {
  assertSafeWebhookAddress,
  assertSafeWebhookEndpoint,
  type V2OperationsRepository,
  type V2WebhookDeliveryClaim,
} from '@agent-payment/db'
import type { CapacityResult } from './capacity.js'
import { retryAtAfter } from './capacity.js'

const DEFAULT_BATCH_SIZE = 50
const DEFAULT_LEASE_SECONDS = 30
const DEFAULT_MAX_ATTEMPTS = 12
const DEFAULT_TIMEOUT_MS = 5_000
export const DEFAULT_WEBHOOK_REPLAY_WINDOW_SECONDS = 300

export const WEBHOOK_SIGNATURE_HEADER = 'x-mux-signature'
export const WEBHOOK_SIGNATURE_VERSION_HEADER = 'x-mux-signature-version'
export const WEBHOOK_TIMESTAMP_HEADER = 'x-mux-timestamp'

const DEFAULT_HTTPS_PORT = 443

export interface WebhookResolvedAddress {
  readonly address: string
  readonly family: 4 | 6
}

export type WebhookHostnameResolver = (
  hostname: string,
) => Promise<readonly WebhookResolvedAddress[]>

export interface WebhookDeliveryRequest {
  readonly endpoint: URL
  readonly address: WebhookResolvedAddress
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
  readonly signal: AbortSignal
}

export interface WebhookDeliveryResponse {
  readonly ok: boolean
  readonly status: number
}

export type WebhookSender = (
  request: WebhookDeliveryRequest,
) => Promise<WebhookDeliveryResponse>

export interface WebhookSigningKeyProvider {
  getKey(reference: string, version: number): Promise<Uint8Array>
}

export interface WebhookSignatureVerificationInput {
  readonly rawBody: string
  readonly timestamp: string
  readonly signature: string
  readonly key: Uint8Array
  readonly now?: Date
  readonly replayWindowSeconds?: number
}

/**
 * Verifies the exact body delivered by the worker and rejects stale headers.
 * The timestamp is part of the MAC input so a captured delivery cannot be
 * replayed outside the bounded acceptance window.
 */
export function verifyWebhookSignature(
  input: WebhookSignatureVerificationInput,
): boolean {
  if (!/^\d+$/u.test(input.timestamp)) return false
  const timestampSeconds = Number(input.timestamp)
  const replayWindowSeconds =
    input.replayWindowSeconds ?? DEFAULT_WEBHOOK_REPLAY_WINDOW_SECONDS
  if (
    !Number.isSafeInteger(timestampSeconds) ||
    timestampSeconds <= 0 ||
    !Number.isInteger(replayWindowSeconds) ||
    replayWindowSeconds <= 0 ||
    input.key.byteLength === 0
  ) {
    return false
  }
  const ageSeconds = Math.abs(
    (input.now ?? new Date()).getTime() / 1_000 - timestampSeconds,
  )
  if (ageSeconds > replayWindowSeconds) return false

  const expected = createWebhookSignature(input.rawBody, timestampSeconds, input.key)
  const provided = input.signature.startsWith('sha256=')
    ? input.signature.slice('sha256='.length)
    : input.signature
  if (!/^[0-9a-f]{64}$/iu.test(provided)) return false
  const expectedBytes = Buffer.from(expected, 'hex')
  const providedBytes = Buffer.from(provided, 'hex')
  return (
    providedBytes.byteLength === expectedBytes.byteLength &&
    timingSafeEqual(providedBytes, expectedBytes)
  )
}

export interface WebhookDeliveryWorkerOptions {
  readonly repository: V2OperationsRepository
  readonly signingKeys: WebhookSigningKeyProvider
  readonly owner: string
  readonly batchSize?: number
  readonly leaseSeconds?: number
  readonly maxAttempts?: number
  readonly timeoutMs?: number
  readonly resolveHostname?: WebhookHostnameResolver
  readonly send?: WebhookSender
  readonly capacity?: {
    acquire(dependency: 'webhook', now?: Date): Promise<CapacityResult>
  }
  readonly now?: () => Date
  readonly logger?: {
    info(data: Readonly<Record<string, unknown>>, message: string): void
    error(data: Readonly<Record<string, unknown>>, message: string): void
  }
}

export class WebhookDeliveryWorker {
  private stopped = false
  private currentRun: Promise<void> | undefined
  private readonly now: () => Date

  public constructor(private readonly options: WebhookDeliveryWorkerOptions) {
    this.now = options.now ?? (() => new Date())
  }

  public runOnce(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    if (this.currentRun !== undefined) return this.currentRun
    const run = this.processBatch()
    let tracked: Promise<void>
    tracked = run.finally(() => {
      if (this.currentRun === tracked) this.currentRun = undefined
    })
    this.currentRun = tracked
    return tracked
  }

  public stop(): void {
    this.stopped = true
  }

  public async drain(): Promise<void> {
    await this.currentRun
  }

  private async processBatch(): Promise<void> {
    const claims = await this.options.repository.claimWebhookDeliveries({
      limit: this.options.batchSize ?? DEFAULT_BATCH_SIZE,
      owner: this.options.owner,
      leaseSeconds: this.options.leaseSeconds ?? DEFAULT_LEASE_SECONDS,
      now: this.now(),
    })
    await Promise.all(claims.map((claim) => this.deliver(claim)))
  }

  private async deliver(claim: V2WebhookDeliveryClaim): Promise<void> {
    const heartbeat = this.startLeaseHeartbeat(claim)
    try {
      await this.deliverWithLease(claim)
    } finally {
      heartbeat.stop()
    }
  }

  private async deliverWithLease(claim: V2WebhookDeliveryClaim): Promise<void> {
    try {
      const key = await this.options.signingKeys.getKey(
        claim.signingKeyRef,
        claim.signingKeyVersion,
      )
      if (key.byteLength === 0) throw new Error('Webhook signing key is empty')
      const target = await resolveWebhookTarget(
        claim.endpoint,
        this.options.resolveHostname ?? resolveWebhookHostname,
      )
      const timestampSeconds = Math.floor(this.now().getTime() / 1_000)
      const signature = createWebhookSignature(claim.rawBody, timestampSeconds, key)
      if (!(await this.acquireCapacity(claim))) return
      const controller = new AbortController()
      const timeout = setTimeout(
        () => controller.abort(),
        this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      )
      let response: WebhookDeliveryResponse
      try {
        response = await (this.options.send ?? sendWebhookRequest)({
          endpoint: target.endpoint,
          address: target.address,
          headers: {
            'content-type': 'application/json',
            'x-mux-event-id': claim.eventId,
            [WEBHOOK_SIGNATURE_HEADER]: `sha256=${signature}`,
            [WEBHOOK_SIGNATURE_VERSION_HEADER]: String(claim.signingKeyVersion),
            [WEBHOOK_TIMESTAMP_HEADER]: String(timestampSeconds),
          },
          body: claim.rawBody,
          signal: controller.signal,
        })
      } finally {
        clearTimeout(timeout)
      }
      if (!response.ok) {
        await this.retry(claim, `Webhook endpoint returned HTTP ${response.status}`)
        return
      }
      await this.options.repository.markWebhookDelivered(
        claim.id,
        this.options.owner,
        response.status,
      )
      this.options.logger?.info(
        { deliveryId: claim.id, eventId: claim.eventId, status: response.status },
        'Webhook delivered',
      )
    } catch (error) {
      await this.retry(
        claim,
        error instanceof Error ? 'Webhook delivery failed' : 'Webhook delivery failed',
      )
      this.options.logger?.error(
        { deliveryId: claim.id, eventId: claim.eventId },
        'Webhook delivery failed',
      )
    }
  }

  private async retry(claim: V2WebhookDeliveryClaim, errorSafe: string): Promise<void> {
    await this.options.repository.retryWebhookDelivery({
      id: claim.id,
      owner: this.options.owner,
      retryAt: computeRetryAt({ now: this.now(), attemptCount: claim.attemptCount }),
      errorSafe,
      maxAttempts: this.options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    })
  }

  private async acquireCapacity(claim: V2WebhookDeliveryClaim): Promise<boolean> {
    if (this.options.capacity === undefined) return true
    const result = await this.options.capacity.acquire('webhook', this.now())
    if (result.allowed) return true
    await this.options.repository.retryWebhookDelivery({
      id: claim.id,
      owner: this.options.owner,
      retryAt: retryAtAfter(
        result.retryAt,
        computeRetryAt({ now: this.now(), attemptCount: claim.attemptCount }),
      ),
      errorSafe: 'Webhook delivery capacity is temporarily exhausted',
      maxAttempts: this.options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    })
    return false
  }

  private startLeaseHeartbeat(claim: V2WebhookDeliveryClaim): { stop(): void } {
    const repository = this.options.repository as V2OperationsRepository & {
      readonly renewWebhookDeliveryLease?: V2OperationsRepository['renewWebhookDeliveryLease']
    }
    if (typeof repository.renewWebhookDeliveryLease !== 'function') {
      return { stop: () => undefined }
    }
    const intervalMs = Math.max(
      1_000,
      Math.floor(((this.options.leaseSeconds ?? DEFAULT_LEASE_SECONDS) * 1_000) / 3),
    )
    const timer = setInterval(() => {
      void repository
        .renewWebhookDeliveryLease({
          id: claim.id,
          owner: this.options.owner,
          leaseSeconds: this.options.leaseSeconds ?? DEFAULT_LEASE_SECONDS,
          now: this.now(),
        })
        .catch((error: unknown) => {
          this.options.logger?.error(
            {
              deliveryId: claim.id,
              errorCode: error instanceof Error ? error.name : 'UNKNOWN',
            },
            'Webhook delivery lease renewal failed',
          )
        })
    }, intervalMs)
    return { stop: () => clearInterval(timer) }
  }
}

async function resolveWebhookHostname(
  hostname: string,
): Promise<readonly WebhookResolvedAddress[]> {
  const addresses = await lookup(hostname, { all: true, verbatim: true })
  return addresses.map((candidate) => {
    if (candidate.family !== 4 && candidate.family !== 6) {
      throw new Error('Webhook endpoint returned an unsupported address family')
    }
    return { address: candidate.address, family: candidate.family }
  })
}

async function resolveWebhookTarget(
  endpoint: string,
  resolveHostname: WebhookHostnameResolver,
): Promise<{ endpoint: URL; address: WebhookResolvedAddress }> {
  assertSafeWebhookEndpoint(endpoint)
  const parsed = new URL(endpoint)
  const hostname = parsed.hostname.replace(/^\[|\]$/gu, '').toLowerCase()
  const version = isIP(hostname)
  const addresses =
    version === 4 || version === 6
      ? [{ address: hostname, family: version as 4 | 6 }]
      : await resolveHostname(hostname)
  if (addresses.length === 0) {
    throw new Error('Webhook endpoint did not resolve to a public address')
  }
  for (const address of addresses) assertSafeWebhookAddress(address.address)
  const address = addresses[0]
  if (address === undefined) {
    throw new Error('Webhook endpoint did not resolve to a public address')
  }
  return { endpoint: parsed, address }
}

async function sendWebhookRequest(
  input: WebhookDeliveryRequest,
): Promise<WebhookDeliveryResponse> {
  const body = Buffer.from(input.body, 'utf8')
  return await new Promise<WebhookDeliveryResponse>((resolve, reject) => {
    const request = httpsRequest(
      {
        protocol: input.endpoint.protocol,
        hostname: input.address.address,
        port:
          input.endpoint.port === '' ? DEFAULT_HTTPS_PORT : Number(input.endpoint.port),
        path: `${input.endpoint.pathname}${input.endpoint.search}`,
        method: 'POST',
        headers: {
          ...input.headers,
          host: input.endpoint.host,
          'content-length': String(body.byteLength),
        },
        servername: input.endpoint.hostname.replace(/^\[|\]$/gu, ''),
        lookup: (_hostname, _options, callback) => {
          callback(null, input.address.address, input.address.family)
        },
        signal: input.signal,
      },
      (response) => {
        const status = response.statusCode ?? 0
        response.resume()
        resolve({ ok: status >= 200 && status < 300, status })
      },
    )
    request.once('error', reject)
    request.end(body)
  })
}

function createWebhookSignature(
  rawBody: string,
  timestampSeconds: number,
  key: Uint8Array,
): string {
  return createHmac('sha256', key)
    .update(`${timestampSeconds}.${rawBody}`, 'utf8')
    .digest('hex')
}
