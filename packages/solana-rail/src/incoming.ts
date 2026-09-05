import { address, type Address } from '@solana/kit'
import {
  ExternalRailError,
  type Money,
} from '@agent-payment/core'
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
  scan(owner: string, cursorSignature?: string | null): Promise<readonly IncomingTransfer[]>
}

interface SignatureInfo {
  readonly signature: string
  readonly err: unknown
  readonly blockTime: number | null
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
  readonly blockTime: number | null
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
    config: { readonly limit: number },
  ): { send(options?: { readonly abortSignal?: AbortSignal }): Promise<readonly SignatureInfo[]> }
  getTransaction(
    transactionSignature: string,
    config: Readonly<Record<string, unknown>>,
  ): { send(options?: { readonly abortSignal?: AbortSignal }): Promise<TransactionResponse | null> }
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

  return {
    async scan(owner, cursorSignature = null) {
      const destination = await options.readRail.getReceiveDestination(owner)
      const tokenDecimals = (await options.readRail.getSettlementBalance(owner)).tokenDecimals
      let signatures: readonly SignatureInfo[]
      try {
        signatures = await rpc
          .getSignaturesForAddress(address(destination.tokenAccount), { limit: 1000 })
          .send()
      } catch (error) {
        throw new ExternalRailError('Incoming Solana reconciliation is unavailable', error, 'RETRYABLE')
      }
      const transfers: IncomingTransfer[] = []
      for (const item of signatures) {
        if (item.err !== null || item.signature === cursorSignature) {
          continue
        }
        const transaction = await fetchTransaction(rpc, item.signature)
        if (transaction === null || transaction.meta === null || transaction.meta.err !== null) {
          continue
        }
        const delta = getIncomingDelta(transaction, owner, destination.tokenAccount, settlementMint)
        if (delta <= 0n) {
          continue
        }
        const amount = tokenAmountToUsd(delta, tokenDecimals)
        if (amount.atomicUnits <= 0n) {
          continue
        }
        transfers.push({
          signature: item.signature,
          amount,
          sourceAddress: getSourceAddress(transaction, owner, destination.tokenAccount, settlementMint),
          reference: getMemo(transaction),
          tokenAccount: destination.tokenAccount,
          settlementMint,
          confirmedAt: transaction.blockTime === null
            ? new Date()
            : new Date(transaction.blockTime * 1000),
        })
      }
      return transfers
    },
  }
}

async function fetchTransaction(rpc: IndexingRpc, signature: string): Promise<TransactionResponse | null> {
  try {
    return await rpc.getTransaction(signature, {
      encoding: 'jsonParsed',
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    }).send()
  } catch (error) {
    throw new ExternalRailError('Incoming Solana reconciliation is unavailable', error, 'RETRYABLE')
  }
}

function getIncomingDelta(
  transaction: TransactionResponse,
  owner: string,
  tokenAccount: string,
  mint: string,
): bigint {
  const before = new Map<number, bigint>()
  for (const balance of transaction.meta?.preTokenBalances ?? []) {
    if (balance.mint === mint && balance.owner === owner) {
      before.set(balance.accountIndex, BigInt(balance.uiTokenAmount.amount))
    }
  }
  let delta = 0n
  for (const balance of transaction.meta?.postTokenBalances ?? []) {
    if (balance.mint !== mint || balance.owner !== owner) {
      continue
    }
    const after = BigInt(balance.uiTokenAmount.amount)
    const change = after - (before.get(balance.accountIndex) ?? 0n)
    if (change > 0n && isDestinationAccount(transaction, balance.accountIndex, tokenAccount)) {
      delta += change
    }
  }
  return delta
}

function getSourceAddress(
  transaction: TransactionResponse,
  owner: string,
  tokenAccount: string,
  mint: string,
): string | undefined {
  const pre = new Map<number, TokenBalance>()
  for (const balance of transaction.meta?.preTokenBalances ?? []) {
    if (balance.mint === mint && balance.owner !== owner) {
      pre.set(balance.accountIndex, balance)
    }
  }
  for (const balance of transaction.meta?.postTokenBalances ?? []) {
    const previous = pre.get(balance.accountIndex)
    if (previous === undefined || balance.mint !== mint) {
      continue
    }
    if (BigInt(previous.uiTokenAmount.amount) > BigInt(balance.uiTokenAmount.amount)) {
      return previous.owner
    }
  }
  return undefined
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
    if (instruction.programId !== MEMO_PROGRAM_ID && instruction.program !== 'spl-memo') {
      continue
    }
    if (typeof instruction.parsed === 'string' && instruction.parsed.length <= 255) {
      return instruction.parsed
    }
  }
  return undefined
}

function tokenAmountToUsd(tokenAtomicUnits: bigint, decimals: number): Money {
  if (decimals >= 2) {
    return { currency: 'USD', atomicUnits: (tokenAtomicUnits / 10n ** BigInt(decimals - 2)) as Money['atomicUnits'] }
  }
  return { currency: 'USD', atomicUnits: (tokenAtomicUnits * 10n ** BigInt(2 - decimals)) as Money['atomicUnits'] }
}
