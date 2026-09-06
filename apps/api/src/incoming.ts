import { randomBytes } from 'node:crypto'
import type { IncomingPaymentRepository, ReceiveRepository } from '@agent-payment/db'
import type { SolanaIncomingReader } from '@agent-payment/solana-rail'

interface IndexedAccount {
  readonly accountId: string
  readonly solanaPublicKey: string
}

type IncomingStore = IncomingPaymentRepository & ReceiveRepository

export class IncomingReconciliationService {
  private stopped = false
  private currentRun: Promise<void> | undefined

  public constructor(
    private readonly repository: IncomingStore,
    private readonly reader: SolanaIncomingReader,
    private readonly logger: { error(data: object, message: string): void },
  ) {}

  public runOnce(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    if (this.currentRun !== undefined) return this.currentRun
    const run = this.reconcileAllAccounts()
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

  private async reconcileAllAccounts(): Promise<void> {
    const accounts: readonly IndexedAccount[] =
      await this.repository.listActiveAccountSettlements()
    for (const account of accounts) {
      await this.reconcileAccount(account)
    }
  }

  private async reconcileAccount(account: IndexedAccount): Promise<void> {
    const cursor = await this.repository.getIncomingCursor(
      account.accountId,
      'SOLANA_SPL',
      account.solanaPublicKey,
    )
    try {
      const scan =
        this.reader.scanWithCursor === undefined
          ? {
              transfers: await this.reader.scan(
                account.solanaPublicKey,
                cursor?.cursorSignature,
              ),
              nextCursor: null,
            }
          : await this.reader.scanWithCursor(
              account.solanaPublicKey,
              cursor?.cursorSignature,
            )
      for (const transfer of scan.transfers) {
        await this.repository.createIncomingPayment({
          id: `in_${randomBytes(16).toString('hex')}`,
          accountId: account.accountId,
          signature: transfer.signature,
          amountAtomic: transfer.amount.atomicUnits,
          tokenAtomicUnits: transfer.tokenAtomicUnits,
          tokenDecimals: transfer.tokenDecimals,
          currency: transfer.amount.currency,
          ...(transfer.sourceAddress === undefined
            ? {}
            : { sourceAddress: transfer.sourceAddress }),
          ...(transfer.reference === undefined
            ? {}
            : { reference: transfer.reference }),
          tokenAccount: transfer.tokenAccount,
          settlementMint: transfer.settlementMint,
          confirmedAt: transfer.confirmedAt,
        })
      }
      for (const issue of scan.unresolved ?? []) {
        if (this.repository.recordIncomingReconciliationIssue === undefined) {
          throw new Error('Incoming reconciliation issue repository is unavailable')
        }
        await this.repository.recordIncomingReconciliationIssue({
          id: `issue_${randomBytes(16).toString('hex')}`,
          accountId: account.accountId,
          signature: issue.signature,
          reason: issue.reason,
        })
      }
      await this.repository.expireOpenReceiveRequests(account.accountId, new Date())
      if (scan.nextCursor !== null && scan.nextCursor !== cursor?.cursorSignature) {
        await this.repository.saveIncomingCursor({
          accountId: account.accountId,
          rail: 'SOLANA_SPL',
          address: account.solanaPublicKey,
          cursorSignature: scan.nextCursor,
        })
      }
    } catch (error) {
      this.logger.error(
        {
          accountId: account.accountId,
          errorCode: error instanceof Error ? error.name : 'UNKNOWN',
        },
        'Incoming reconciliation failed',
      )
    }
  }
}
