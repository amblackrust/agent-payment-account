import { address, type Address } from '@solana/kit'
import { ExternalRailError, type Money } from '@agent-payment/core'
import type { SolanaRpc, SolanaRail, SolanaRailOptions } from './read.js'

export interface IncomingTransfer {
  readonly signature: string
  readonly amount: Money
  readonly tokenAtomicUnits: bigint
  readonly tokenDecimals: number
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
    readonly unresolved?: readonly UnresolvedIncomingSignature[]
  }>
}

export interface UnresolvedIncomingSignature {
  readonly signature: string
  readonly reason: 'UNCLASSIFIED_TRANSFER'
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
    readonly innerInstructions?:
      | readonly {
          readonly index: number
          readonly instructions: readonly ParsedInstruction[]
        }[]
      | null
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
      const unresolved: UnresolvedIncomingSignature[] = []
      let blockedByUnclassifiedSignature = false
      for (const item of [...history.signatures].reverse()) {
        if (item.err !== null) {
          continue
        }
        const transaction = await fetchTransaction(rpc, item.signature, withRpcTimeout)
        if (transaction === null || transaction.meta === null) {
          blockedByUnclassifiedSignature = true
          break
        }
        if (transaction.meta.err !== null) {
          continue
        }
        const transfer = getExternalIncomingTransfer(
          transaction,
          owner,
          destination.tokenAccount,
          settlementMint,
        )
        if (transfer.kind === 'IRRELEVANT') {
          continue
        }
        if (transfer.kind === 'UNCLASSIFIED') {
          unresolved.push({
            signature: item.signature,
            reason: 'UNCLASSIFIED_TRANSFER',
          })
          continue
        }
        if (transaction.blockTime === null) {
          blockedByUnclassifiedSignature = true
          break
        }
        const confirmedAt = new Date(Number(transaction.blockTime) * 1000)
        if (Number.isNaN(confirmedAt.getTime())) {
          blockedByUnclassifiedSignature = true
          break
        }
        const amount = tokenAmountToUsd(transfer.amount, tokenDecimals)
        transfers.push({
          signature: item.signature,
          amount,
          tokenAtomicUnits: transfer.amount,
          tokenDecimals,
          sourceAddress: transfer.sourceAddress,
          reference: getMemo(transaction),
          tokenAccount: destination.tokenAccount,
          settlementMint,
          confirmedAt,
        })
      }
      return {
        transfers,
        unresolved,
        nextCursor: blockedByUnclassifiedSignature
          ? cursorSignature
          : history.nextCursor,
      }
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
):
  | {
      readonly kind: 'INCOMING'
      readonly amount: bigint
      readonly sourceAddress: string | undefined
    }
  | { readonly kind: 'IRRELEVANT' }
  | { readonly kind: 'UNCLASSIFIED' } {
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
  if (destinationDelta <= 0n) return { kind: 'IRRELEVANT' }
  const instructions = [
    ...(transaction.transaction.message.instructions ?? []),
    ...(transaction.meta?.innerInstructions?.flatMap((group) => group.instructions) ??
      []),
  ]
  const externalTransfers: {
    readonly amount: bigint
    readonly sourceAddress: string
  }[] = []
  let unknownSourceAmount = 0n
  let selfTransferAmount = 0n
  let targetTransferAmount = 0n
  let hasUnclassifiedTransfer = false
  let hasKnownNonTransferMutation = false
  for (const instruction of instructions) {
    const parsed = getParsedTransfer(instruction)
    if (parsed === undefined) {
      hasKnownNonTransferMutation ||= isKnownNonTransferMutation(instruction)
      continue
    }
    if (parsed.destination !== tokenAccount) continue
    if (parsed.mint !== undefined && parsed.mint !== mint) continue
    if (parsed.amount === undefined || parsed.amount <= 0n) {
      hasUnclassifiedTransfer = true
      continue
    }
    targetTransferAmount += parsed.amount
    const sourceIndex = findAccountIndex(transaction, parsed.source)
    if (sourceIndex === undefined) {
      unknownSourceAmount += parsed.amount
      continue
    }
    const sourceBalance = preBalances.get(sourceIndex)
    if (sourceBalance?.owner === undefined) {
      unknownSourceAmount += parsed.amount
      continue
    }
    if (sourceBalance.owner === owner) {
      selfTransferAmount += parsed.amount
      continue
    }
    externalTransfers.push({
      amount: parsed.amount,
      sourceAddress: sourceBalance.owner,
    })
  }
  if (hasKnownNonTransferMutation && targetTransferAmount === 0n) {
    return { kind: 'IRRELEVANT' }
  }
  if (hasUnclassifiedTransfer || targetTransferAmount !== destinationDelta) {
    return { kind: 'UNCLASSIFIED' }
  }
  const externalAmount = externalTransfers.reduce(
    (total, transfer) => total + transfer.amount,
    0n,
  )
  const provenExternalAmount = externalAmount + unknownSourceAmount
  const sourceOwners = new Set(
    externalTransfers.map((transfer) => transfer.sourceAddress),
  )
  if (provenExternalAmount > 0n) {
    return {
      kind: 'INCOMING',
      amount: provenExternalAmount,
      sourceAddress:
        unknownSourceAmount === 0n && sourceOwners.size === 1
          ? externalTransfers[0]!.sourceAddress
          : undefined,
    }
  }
  return selfTransferAmount === destinationDelta
    ? { kind: 'IRRELEVANT' }
    : { kind: 'UNCLASSIFIED' }
}

function isKnownNonTransferMutation(instruction: ParsedInstruction): boolean {
  if (
    instruction.program !== 'spl-token' ||
    instruction.parsed === null ||
    typeof instruction.parsed !== 'object'
  ) {
    return false
  }
  const parsed = instruction.parsed as { readonly type?: unknown }
  return parsed.type === 'mintTo' || parsed.type === 'mintToChecked'
}

function getParsedTransfer(instruction: ParsedInstruction):
  | {
      readonly source: string
      readonly destination: string
      readonly amount: bigint | undefined
      readonly mint: string | undefined
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
    readonly mint?: unknown
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
    ? {
        source: info.source,
        destination: info.destination,
        amount,
        mint: typeof info.mint === 'string' ? info.mint : undefined,
      }
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
