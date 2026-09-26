import {
  createSolanaRpc,
  isSolanaError,
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
  type ClusterUrl,
} from '@solana/kit'
import { DEVNET_GENESIS_HASH } from './config.js'

const GENESIS_CHECK_MAX_RETRIES = 5
const GENESIS_CHECK_BASE_DELAY_MS = 1_000
const GENESIS_CHECK_MAX_DELAY_MS = 15_000

export interface FakeX402SignatureStatus {
  readonly err: unknown
  readonly confirmationStatus: 'processed' | 'confirmed' | 'finalized' | null
}

export interface FakeX402RpcTransaction {
  readonly meta: {
    readonly err: unknown
    readonly preTokenBalances?: readonly FakeX402TokenBalance[]
    readonly postTokenBalances?: readonly FakeX402TokenBalance[]
    readonly innerInstructions?: readonly FakeX402InnerInstructionGroup[] | null
  } | null
  readonly transaction: {
    readonly message: {
      readonly accountKeys?: readonly (string | FakeX402AccountKey)[]
      readonly instructions?: readonly FakeX402ParsedInstruction[]
    }
  }
}

export interface FakeX402TokenBalance {
  readonly accountIndex: number
  readonly mint: string
  readonly owner?: string
  readonly uiTokenAmount: { readonly amount: string }
}

export interface FakeX402AccountKey {
  readonly pubkey: string
  readonly signer?: boolean
}

export interface FakeX402ParsedInstruction {
  readonly program?: string
  readonly programId?: string
  readonly parsed?: unknown
}

export interface FakeX402InnerInstructionGroup {
  readonly index: number
  readonly instructions: readonly FakeX402ParsedInstruction[]
}

interface RpcMethod<T> {
  send(options?: { readonly abortSignal?: AbortSignal }): Promise<T>
}

export interface FakeX402Rpc {
  getGenesisHash(): RpcMethod<string>
  getSignatureStatuses(
    signatures: readonly string[],
    config: { readonly searchTransactionHistory: boolean },
  ): RpcMethod<{ readonly value: readonly (FakeX402SignatureStatus | null)[] }>
  getTransaction(
    signature: string,
    config: Readonly<Record<string, unknown>>,
  ): RpcMethod<FakeX402RpcTransaction | null>
  sendTransaction?(
    transaction: string,
    config: Readonly<Record<string, unknown>>,
  ): RpcMethod<string>
}

export function createDevnetRpc(rpcUrl: string): FakeX402Rpc {
  return createSolanaRpc(rpcUrl as ClusterUrl) as unknown as FakeX402Rpc
}

export async function assertDevnetRpc(
  rpc: Pick<FakeX402Rpc, 'getGenesisHash'>,
): Promise<void> {
  let genesisHash: string
  try {
    genesisHash = await getGenesisHashWithRateLimitRetry(rpc)
  } catch (error) {
    const rateLimitPersisted = isSolanaHttpRateLimitError(error)
    throw new Error(
      rateLimitPersisted
        ? 'The fake x402 service could not verify the Solana devnet RPC because its rate limit persisted'
        : 'The fake x402 service could not verify the Solana devnet RPC',
      { cause: error },
    )
  }
  if (genesisHash !== DEVNET_GENESIS_HASH) {
    throw new Error('The fake x402 service requires the Solana devnet genesis hash')
  }
}

async function getGenesisHashWithRateLimitRetry(
  rpc: Pick<FakeX402Rpc, 'getGenesisHash'>,
): Promise<string> {
  for (let attempt = 0; attempt <= GENESIS_CHECK_MAX_RETRIES; attempt += 1) {
    try {
      // This is a read-only cluster check; transaction submission is never retried here.
      return await rpc.getGenesisHash().send()
    } catch (error) {
      if (!isSolanaHttpRateLimitError(error) || attempt === GENESIS_CHECK_MAX_RETRIES) {
        throw error
      }
      await waitForRateLimit(error, attempt)
    }
  }
  throw new Error('Solana devnet genesis check exhausted its retry budget')
}

function isSolanaHttpRateLimitError(error: unknown): error is Error & {
  readonly context: { readonly headers: Headers; readonly statusCode: number }
} {
  return (
    isSolanaError(error, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR) &&
    error.context.statusCode === 429
  )
}

async function waitForRateLimit(
  error: Error & {
    readonly context: { readonly headers: Headers; readonly statusCode: number }
  },
  attempt: number,
): Promise<void> {
  const retryAfterMilliseconds = parseRetryAfterMilliseconds(
    error.context.headers.get('retry-after'),
  )
  const exponentialDelay = Math.min(
    GENESIS_CHECK_MAX_DELAY_MS,
    GENESIS_CHECK_BASE_DELAY_MS * 2 ** attempt,
  )
  const delayMilliseconds = Math.min(
    GENESIS_CHECK_MAX_DELAY_MS,
    Math.max(exponentialDelay, retryAfterMilliseconds ?? 0),
  )
  await new Promise<void>((resolve) => setTimeout(resolve, delayMilliseconds))
}

function parseRetryAfterMilliseconds(value: string | null): number | undefined {
  if (value === null) return undefined
  const seconds = Number(value.trim())
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000)
  const timestamp = Date.parse(value)
  if (Number.isNaN(timestamp)) return undefined
  return Math.max(0, timestamp - Date.now())
}
