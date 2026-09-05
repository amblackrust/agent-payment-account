import { address, type Address } from '@solana/kit'
import { ExternalRailError, type Money } from '@agent-payment/core'
import type { SolanaRpc, SolanaRail, SolanaRailOptions } from './read.js'

export interface IncomingTransfer {
  readonly signature: string
  readonly amount: Money
  readonly sourceAddress: string | undefined
  readonly reference: string | undefined
  readonly tokenAccount: string
  readonly settlementMint: string
  readonly confirmedAt: Date
}

export interface SolanaIncomingReader {
  scan(
    owner: string,
    cursorSignature?: string | null,
  ): Promise<readonly IncomingTransfer[]>
  readonly scanWithCursor?: (
    owner: string,
    cursorSignature?: string | null,
  ) => Promise<{
    readonly transfers: readonly IncomingTransfer[]
    readonly nextCursor: string | null
  }>
}

interface SignatureInfo {
  readonly signature: string
  readonly err: unknown
  readonly blockTime: number | bigint | null
}

interface TokenBalance {
  readonly accountIndex: number
  readonly mint: string
  readonly owner?: string
  readonly uiTokenAmount: { readonly amount: string }
}

interface ParsedInstruction {
  readonly program?: string
  readonly programId?: string
  readonly parsed?: unknown
}

interface TransactionResponse {
  readonly blockTime: number | bigint | null
  readonly meta: {
    readonly err: unknown
    readonly preTokenBalances?: readonly TokenBalance[]
    readonly postTokenBalances?: readonly TokenBalance[]
  } | null
  readonly transaction: {
    readonly message: {
      readonly accountKeys?: readonly (string | { readonly pubkey: string })[]
      readonly instructions?: readonly ParsedInstruction[]
    }
  }
}

interface IndexingRpc {
  getSignaturesForAddress(
    account: Address,
    config: { readonly limit: number; readonly before?: string },
  ): {
    send(options?: {
      readonly abortSignal?: AbortSignal
    }): Promise<readonly SignatureInfo[]>
  }
  getTransaction(
    transactionSignature: string,
    config: Readonly<Record<string, unknown>>,
  ): {
    send(options?: {
      readonly abortSignal?: AbortSignal
    }): Promise<TransactionResponse | null>
  }
}

const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'

export interface SolanaIncomingReaderOptions extends SolanaRailOptions {
  readonly rpc: SolanaRpc
  readonly readRail: SolanaRail
}

export function createSolanaIncomingReader(
  options: SolanaIncomingReaderOptions,
): SolanaIncomingReader {
  const rpc = options.rpc as unknown as IndexingRpc
  const settlementMint = options.settlementMint
  const timeoutMs = options.rpcTimeoutMs ?? 5_000

  async function withRpcTimeout<T>(
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController()
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(
          new ExternalRailError(
            'Incoming Solana RPC request timed out',
            undefined,
            'RETRYABLE',
          ),
        )
      }, timeoutMs)
    })
    try {
      return await Promise.race([operation(controller.signal), timeout])
    } catch (error) {
      if (controller.signal.aborted) {
        throw new ExternalRailError(
          'Incoming Solana RPC request timed out',
          undefined,
          'RETRYABLE',
        )
      }
      throw new ExternalRailError(
        'Incoming Solana reconciliation is unavailable',
        error,
        'RETRYABLE',
      )
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  return {
    async scan(owner, cursorSignature = null) {
      return (await this.scanWithCursor!(owner, cursorSignature)).transfers
    },
    async scanWithCursor(owner, cursorSignature = null) {
      const destination = await options.readRail.getReceiveDestination(owner)
      const tokenDecimals = (await options.readRail.getSettlementBalance(owner))
        .tokenDecimals
      const history = await collectHistory(
        rpc,
        address(destination.tokenAccount),
        cursorSignature,
        withRpcTimeout,
      )
      const transfers: IncomingTransfer[] = []
      for (const item of [...history.signatures].reverse()) {
        if (item.err !== null) {
          continue
        }
        const transaction = await fetchTransaction(rpc, item.signature, withRpcTimeout)
        if (
          transaction === null ||
          transaction.meta === null ||
          transaction.meta.err !== null
        ) {
          continue
        }
        const transfer = getExternalIncomingTransfer(
          transaction,
          owner,
          destination.tokenAccount,
          settlementMint,
        )
        if (transfer === undefined || transfer.amount <= 0n) {
          continue
        }
        const amount = tokenAmountToUsd(transfer.amount, tokenDecimals)
        if (amount.atomicUnits <= 0n) {
          continue
        }
        transfers.push({
          signature: item.signature,
          amount,
          sourceAddress: transfer.sourceAddress,
          reference: getMemo(transaction),
          tokenAccount: destination.tokenAccount,
          settlementMint,
          confirmedAt:
            transaction.blockTime === null
              ? new Date()
              : new Date(Number(transaction.blockTime) * 1000),
        })
      }
      return { transfers, nextCursor: history.nextCursor }
    },
  }
}

async function fetchTransaction(
  rpc: IndexingRpc,
  transactionSignature: string,
  withRpcTimeout: <T>(operation: (signal: AbortSignal) => Promise<T>) => Promise<T>,
): Promise<TransactionResponse | null> {
  return withRpcTimeout((abortSignal) =>
    rpc
      .getTransaction(transactionSignature, {
        encoding: 'jsonParsed',
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      })
      .send({ abortSignal }),
  )
}

async function collectHistory(
  rpc: IndexingRpc,
  account: Address,
  cursorSignature: string | null,
  withRpcTimeout: <T>(operation: (signal: AbortSignal) => Promise<T>) => Promise<T>,
): Promise<{
  readonly signatures: readonly SignatureInfo[]
  readonly nextCursor: string | null
}> {
  const signatures: SignatureInfo[] = []
  let before: string | undefined
  let firstSignature: string | undefined
  while (true) {
    const page = await withRpcTimeout((abortSignal) =>
      rpc
        .getSignaturesForAddress(account, {
          limit: 1000,
          ...(before === undefined ? {} : { before }),
        })
        .send({ abortSignal }),
    )
    if (page.length === 0) break
    firstSignature ??= page[0]?.signature
    let reachedCursor = false
    for (const item of page) {
      if (cursorSignature !== null && item.signature === cursorSignature) {
        reachedCursor = true
        break
      }
      signatures.push(item)
    }
    if (reachedCursor || page.length < 1000) break
    const last = page.at(-1)
    if (last === undefined) break
    before = last.signature
  }
  return {
    signatures,
    nextCursor: firstSignature ?? cursorSignature,
  }
}

function getExternalIncomingTransfer(
  transaction: TransactionResponse,
  owner: string,
  tokenAccount: string,
  mint: string,
): { readonly amount: bigint; readonly sourceAddress: string | undefined } | undefined {
  const before = new Map<number, bigint>()
  const preBalances = new Map<number, TokenBalance>()
  for (const balance of transaction.meta?.preTokenBalances ?? []) {
    if (balance.mint === mint) {
      before.set(balance.accountIndex, BigInt(balance.uiTokenAmount.amount))
      preBalances.set(balance.accountIndex, balance)
    }
  }
  let destinationDelta = 0n
  for (const balance of transaction.meta?.postTokenBalances ?? []) {
    if (
      balance.mint !== mint ||
      balance.owner !== owner ||
      !isDestinationAccount(transaction, balance.accountIndex, tokenAccount)
    ) {
      continue
    }
    const after = BigInt(balance.uiTokenAmount.amount)
    const change = after - (before.get(balance.accountIndex) ?? 0n)
    if (change > 0n) {
      destinationDelta += change
    }
  }
  if (destinationDelta <= 0n) return undefined
  const externalTransfers: {
    readonly amount: bigint
    readonly sourceAddress: string
  }[] = []
  for (const instruction of transaction.transaction.message.instructions ?? []) {
    const parsed = getParsedTransfer(instruction)
    if (parsed === undefined || parsed.destination !== tokenAccount) continue
    const sourceIndex = findAccountIndex(transaction, parsed.source)
    if (sourceIndex === undefined) continue
    const sourceBalance = preBalances.get(sourceIndex)
    if (sourceBalance?.owner === undefined || sourceBalance.owner === owner) continue
    const sourceAfter =
      getBalance(transaction.meta?.postTokenBalances, sourceIndex) ?? 0n
    const sourceBefore = BigInt(sourceBalance.uiTokenAmount.amount)
    if (sourceBefore <= sourceAfter || parsed.amount === undefined) continue
    if (sourceBefore - sourceAfter !== parsed.amount) continue
    externalTransfers.push({
      amount: parsed.amount,
      sourceAddress: sourceBalance.owner,
    })
  }
  const transferredAmount = externalTransfers.reduce(
    (total, transfer) => total + transfer.amount,
    0n,
  )
  const firstTransfer = externalTransfers[0]
  return firstTransfer === undefined || transferredAmount !== destinationDelta
    ? undefined
    : { amount: transferredAmount, sourceAddress: firstTransfer.sourceAddress }
}

function getParsedTransfer(instruction: ParsedInstruction):
  | {
      readonly source: string
      readonly destination: string
      readonly amount: bigint | undefined
    }
  | undefined {
  if (
    instruction.program !== 'spl-token' ||
    instruction.parsed === null ||
    typeof instruction.parsed !== 'object'
  ) {
    return undefined
  }
  const parsed = instruction.parsed as {
    readonly type?: unknown
    readonly info?: unknown
  }
  if (parsed.type !== 'transfer' && parsed.type !== 'transferChecked') return undefined
  if (parsed.info === null || typeof parsed.info !== 'object') return undefined
  const info = parsed.info as {
    readonly source?: unknown
    readonly destination?: unknown
    readonly amount?: unknown
    readonly tokenAmount?: { readonly amount?: unknown }
  }
  const rawAmount = info.amount ?? info.tokenAmount?.amount
  let amount: bigint | undefined
  try {
    amount = rawAmount === undefined ? undefined : BigInt(String(rawAmount))
  } catch {
    return undefined
  }
  return typeof info.source === 'string' && typeof info.destination === 'string'
    ? { source: info.source, destination: info.destination, amount }
    : undefined
}

function findAccountIndex(
  transaction: TransactionResponse,
  value: string,
): number | undefined {
  return transaction.transaction.message.accountKeys?.findIndex(
    (key) => (typeof key === 'string' ? key : key.pubkey) === value,
  )
}

function getBalance(
  balances: readonly TokenBalance[] | undefined,
  accountIndex: number,
): bigint | undefined {
  const balance = balances?.find((candidate) => candidate.accountIndex === accountIndex)
  return balance === undefined ? undefined : BigInt(balance.uiTokenAmount.amount)
}

function isDestinationAccount(
  transaction: TransactionResponse,
  accountIndex: number,
  tokenAccount: string,
): boolean {
  const key = transaction.transaction.message.accountKeys?.[accountIndex]
  return (typeof key === 'string' ? key : key?.pubkey) === tokenAccount
}

function getMemo(transaction: TransactionResponse): string | undefined {
  for (const instruction of transaction.transaction.message.instructions ?? []) {
    if (
      instruction.programId !== MEMO_PROGRAM_ID &&
      instruction.program !== 'spl-memo'
    ) {
      continue
    }
    if (typeof instruction.parsed === 'string' && instruction.parsed.length <= 255) {
      const marker = '|reference:'
      const markerIndex = instruction.parsed.indexOf(marker)
      return markerIndex === -1
        ? instruction.parsed
        : instruction.parsed.slice(markerIndex + marker.length)
    }
  }
  return undefined
}

function tokenAmountToUsd(tokenAtomicUnits: bigint, decimals: number): Money {
  if (decimals >= 2) {
    return {
      currency: 'USD',
      atomicUnits: (tokenAtomicUnits /
        10n ** BigInt(decimals - 2)) as Money['atomicUnits'],
    }
  }
  return {
    currency: 'USD',
    atomicUnits: (tokenAtomicUnits *
      10n ** BigInt(2 - decimals)) as Money['atomicUnits'],
  }
}
