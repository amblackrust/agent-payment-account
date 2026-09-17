import { createHmac, timingSafeEqual } from 'node:crypto'
import { computeRetryAt } from '@agent-payment/core'
import type { V2OperationsRepository, V2WebhookDeliveryClaim } from '@agent-payment/db'

const DEFAULT_BATCH_SIZE = 50
const DEFAULT_LEASE_SECONDS = 30
const DEFAULT_MAX_ATTEMPTS = 12
const DEFAULT_TIMEOUT_MS = 5_000
export const DEFAULT_WEBHOOK_REPLAY_WINDOW_SECONDS = 300

export const WEBHOOK_SIGNATURE_HEADER = 'x-mux-signature'
export const WEBHOOK_SIGNATURE_VERSION_HEADER = 'x-mux-signature-version'
export const WEBHOOK_TIMESTAMP_HEADER = 'x-mux-timestamp'

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
    try {
      const key = await this.options.signingKeys.getKey(
        claim.signingKeyRef,
        claim.signingKeyVersion,
      )
      if (key.byteLength === 0) throw new Error('Webhook signing key is empty')
      const timestampSeconds = Math.floor(this.now().getTime() / 1_000)
      const signature = createWebhookSignature(claim.rawBody, timestampSeconds, key)
      const controller = new AbortController()
      const timeout = setTimeout(
        () => controller.abort(),
        this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      )
      let response: Response
      try {
        response = await fetch(claim.endpoint, {
          method: 'POST',
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
