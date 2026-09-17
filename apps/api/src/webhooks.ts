import { createHmac } from 'node:crypto'
import { computeRetryAt } from '@agent-payment/core'
import type {
  V2OperationsRepository,
  V2WebhookDeliveryClaim,
} from '@agent-payment/db'

const DEFAULT_BATCH_SIZE = 50
const DEFAULT_LEASE_SECONDS = 30
const DEFAULT_MAX_ATTEMPTS = 12
const DEFAULT_TIMEOUT_MS = 5_000

export interface WebhookSigningKeyProvider {
  getKey(reference: string, version: number): Promise<Uint8Array>
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
      const signature = createHmac('sha256', key).update(claim.rawBody, 'utf8').digest('hex')
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
            'x-mux-signature': `sha256=${signature}`,
            'x-mux-signature-version': String(claim.signingKeyVersion),
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
