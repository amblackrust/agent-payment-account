import { randomBytes } from 'node:crypto'
import type { IncomingPaymentRepository, ReceiveRepository } from '@agent-payment/db'
import type { IncomingTransfer, SolanaIncomingReader } from '@agent-payment/solana-rail'
import type { CapacityResult } from './capacity.js'

interface IndexedAccount {
  readonly accountId: string
  readonly solanaPublicKey: string
}

type IncomingStore = IncomingPaymentRepository & ReceiveRepository
const ISSUE_RETRY_BATCH_SIZE = 50
const MAX_ISSUE_RETRIES = 8

export interface IncomingReconciliationOptions {
  readonly accountConcurrency?: number
  readonly owner?: string
  readonly leaseSeconds?: number
  readonly capacity?: {
    acquire(dependency: 'rpc', now?: Date): Promise<CapacityResult>
  }
}

export class IncomingReconciliationService {
  private stopped = false
  private currentRun: Promise<void> | undefined

  public constructor(
    private readonly repository: IncomingStore,
    private readonly reader: SolanaIncomingReader,
    private readonly logger: { error(data: object, message: string): void },
    private readonly options: IncomingReconciliationOptions = {},
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
    await this.reconcileAccountsWithConcurrency(accounts)
    await this.reconcilePendingIssues()
    await this.repository.reconcileUnmatchedManagedIncoming?.(ISSUE_RETRY_BATCH_SIZE)
  }

  private async reconcileAccountsWithConcurrency(
    accounts: readonly IndexedAccount[],
  ): Promise<void> {
    const requestedConcurrency = this.options.accountConcurrency ?? accounts.length
    const concurrency = Math.max(
      1,
      Math.min(requestedConcurrency, Math.max(accounts.length, 1)),
    )
    let nextIndex = 0
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (nextIndex < accounts.length) {
          const account = accounts[nextIndex]
          nextIndex += 1
          if (account !== undefined) await this.reconcileAccount(account)
        }
      }),
    )
  }

  private async reconcileAccount(account: IndexedAccount): Promise<void> {
    const owner = this.options.owner ?? `incoming-${process.pid}`
    const leaseSeconds = this.options.leaseSeconds ?? 60
    const partition = await this.repository.claimIncomingPartition?.({
      accountId: account.accountId,
      rail: 'SOLANA_SPL',
      address: account.solanaPublicKey,
      owner,
      leaseSeconds,
      now: new Date(),
    })
    if (this.repository.claimIncomingPartition !== undefined && partition === null) {
      return
    }
    const cursor =
      partition ??
      (await this.repository.getIncomingCursor(
        account.accountId,
        'SOLANA_SPL',
        account.solanaPublicKey,
      ))
    const heartbeat = this.startPartitionLeaseHeartbeat(account, owner, leaseSeconds)
    try {
      if (!(await this.hasRpcCapacity(account.accountId))) return
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
        await this.persistTransfer(account.accountId, transfer)
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
          ...(this.repository.claimIncomingPartition === undefined
            ? {}
            : { leaseOwner: owner }),
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
    } finally {
      heartbeat.stop()
      await this.repository.releaseIncomingPartition?.({
        accountId: account.accountId,
        rail: 'SOLANA_SPL',
        address: account.solanaPublicKey,
        owner,
      })
    }
  }

  private startPartitionLeaseHeartbeat(
    account: IndexedAccount,
    owner: string,
    leaseSeconds: number,
  ): { stop(): void } {
    const renew = this.repository.renewIncomingPartition
    if (renew === undefined || this.repository.claimIncomingPartition === undefined) {
      return { stop: () => undefined }
    }
    const timer = setInterval(
      () => {
        void renew({
          accountId: account.accountId,
          rail: 'SOLANA_SPL',
          address: account.solanaPublicKey,
          owner,
          leaseSeconds,
          now: new Date(),
        }).catch((error: unknown) => {
          this.logger.error(
            {
              accountId: account.accountId,
              errorCode: error instanceof Error ? error.name : 'UNKNOWN',
            },
            'Incoming partition lease renewal failed',
          )
        })
      },
      Math.max(1_000, Math.floor((leaseSeconds * 1_000) / 3)),
    )
    return { stop: () => clearInterval(timer) }
  }

  private async hasRpcCapacity(accountId: string): Promise<boolean> {
    if (this.options.capacity === undefined) return true
    const result = await this.options.capacity.acquire('rpc', new Date())
    if (result.allowed) return true
    this.logger.error(
      { accountId, errorCode: 'CAPACITY_BACKPRESSURE' },
      'Incoming RPC capacity is temporarily exhausted',
    )
    return false
  }

  private async reconcilePendingIssues(): Promise<void> {
    const claimIssues = this.repository.claimIncomingReconciliationIssues
    const resolveIssue = this.repository.resolveIncomingReconciliationIssue
    const updateReason = this.repository.updateIncomingReconciliationIssueReason
    const inspectSignature = this.reader.inspectSignature
    if (
      claimIssues === undefined ||
      resolveIssue === undefined ||
      updateReason === undefined ||
      inspectSignature === undefined
    ) {
      return
    }
    const issues = await claimIssues(ISSUE_RETRY_BATCH_SIZE)
    for (const issue of issues) {
      try {
        if (issue.retryCount > MAX_ISSUE_RETRIES) {
          await this.repository.exhaustIncomingReconciliationIssue(
            issue.id,
            'INCOMING_ISSUE_RETRY_EXHAUSTED',
          )
          continue
        }
        if (!(await this.hasRpcCapacity(issue.accountId))) continue
        const inspection = await inspectSignature(
          issue.accountPublicKey,
          issue.signature,
        )
        if (inspection.kind === 'UNRESOLVED') {
          if (issue.retryCount >= MAX_ISSUE_RETRIES) {
            await this.repository.exhaustIncomingReconciliationIssue(
              issue.id,
              'INCOMING_ISSUE_RETRY_EXHAUSTED',
            )
            continue
          }
          await updateReason(issue.id, inspection.reason)
          continue
        }
        if (inspection.kind === 'INCOMING') {
          await this.persistTransfer(issue.accountId, inspection.transfer)
        }
        await resolveIssue(issue.id)
      } catch (error) {
        if (issue.retryCount >= MAX_ISSUE_RETRIES) {
          try {
            await this.repository.exhaustIncomingReconciliationIssue(
              issue.id,
              'INCOMING_ISSUE_RETRY_EXHAUSTED',
            )
          } catch (exhaustionError) {
            this.logger.error(
              {
                accountId: issue.accountId,
                signature: issue.signature,
                errorCode:
                  exhaustionError instanceof Error ? exhaustionError.name : 'UNKNOWN',
              },
              'Incoming reconciliation issue exhaustion failed',
            )
          }
        }
        this.logger.error(
          {
            accountId: issue.accountId,
            signature: issue.signature,
            errorCode: error instanceof Error ? error.name : 'UNKNOWN',
          },
          'Incoming reconciliation issue retry failed',
        )
      }
    }
  }

  private async persistTransfer(
    accountId: string,
    transfer: IncomingTransfer,
  ): Promise<void> {
    await this.repository.createIncomingPayment({
      id: `in_${randomBytes(16).toString('hex')}`,
      accountId,
      signature: transfer.signature,
      amountAtomic: transfer.amount.atomicUnits,
      tokenAtomicUnits: transfer.tokenAtomicUnits,
      tokenDecimals: transfer.tokenDecimals,
      currency: transfer.amount.currency,
      ...(transfer.sourceAddress === undefined
        ? {}
        : { sourceAddress: transfer.sourceAddress }),
      ...(transfer.reference === undefined ? {} : { reference: transfer.reference }),
      tokenAccount: transfer.tokenAccount,
      settlementMint: transfer.settlementMint,
      confirmedAt: transfer.confirmedAt,
    })
  }
}
