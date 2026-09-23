import { createSolanaRpc, type ClusterUrl } from '@solana/kit'
import { DEVNET_GENESIS_HASH } from './config.js'

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
    genesisHash = await rpc.getGenesisHash().send()
  } catch (error) {
    throw new Error('The fake x402 service could not verify the Solana devnet RPC', {
      cause: error,
    })
  }
  if (genesisHash !== DEVNET_GENESIS_HASH) {
    throw new Error('The fake x402 service requires the Solana devnet genesis hash')
  }
}
