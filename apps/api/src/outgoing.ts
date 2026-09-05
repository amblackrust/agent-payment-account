import type { PaymentRepository } from '@agent-payment/db'
import type { PaymentService, PaymentEventSink } from './payments.js'

const DEFAULT_BATCH_SIZE = 50

export class OutgoingPaymentReconciliationService {
  private stopped = false
  private currentRun: Promise<void> | undefined

  public constructor(
    private readonly repository: PaymentRepository,
    private readonly paymentService: PaymentService,
    private readonly logger: PaymentEventSink,
    private readonly batchSize = DEFAULT_BATCH_SIZE,
  ) {}

  public runOnce(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    if (this.currentRun !== undefined) return this.currentRun
    const run = this.reconcileBatch()
    let trackedRun: Promise<void>
    trackedRun = run.finally(() => {
      if (this.currentRun === trackedRun) this.currentRun = undefined
    })
    this.currentRun = trackedRun
    return trackedRun
  }

  public stop(): void {
    this.stopped = true
  }

  public async drain(): Promise<void> {
    await this.currentRun
  }

  private async reconcileBatch(): Promise<void> {
    const payments = await this.repository.listRecoverablePayments(this.batchSize)
    for (const payment of payments) {
      try {
        await this.paymentService.recoverPersistedPayment(payment)
      } catch (error) {
        this.logger.info(
          {
            paymentId: payment.id,
            accountId: payment.payerAccountId,
            operation: payment.kind,
            rail: payment.route,
            errorCode: error instanceof Error ? error.name : 'UNKNOWN',
          },
          'Outgoing payment recovery failed; payment remains recoverable',
        )
      }
    }
  }
}
