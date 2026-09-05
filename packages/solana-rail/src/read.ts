import { address, createSolanaRpc, type Address, type ClusterUrl } from '@solana/kit'
import {
  fetchMaybeMint,
  fetchMaybeToken,
  findAssociatedTokenPda,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token'
import {
  ExternalRailError,
  moneyFromAtomicUnits,
  USD_DECIMAL_PLACES,
  type Money,
} from '@agent-payment/core'

export type SolanaRpc = ReturnType<typeof createSolanaRpc>

export const DEFAULT_RPC_TIMEOUT_MS = 5_000

export type SolanaCluster = 'localnet' | 'devnet' | 'testnet' | 'mainnet-beta'

const GENESIS_HASHES: Readonly<Record<Exclude<SolanaCluster, 'localnet'>, string>> = {
  'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  testnet: '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY',
}

export interface SettlementBalance {
  readonly currency: 'USD'
  readonly settled: Money
  readonly tokenAtomicUnits: bigint
  readonly tokenDecimals: number
  readonly ata: string
  readonly ataStatus: 'PRESENT' | 'MISSING'
}

export interface ReceiveDestination {
  readonly owner: string
  readonly tokenAccount: string
  readonly settlementMint: string
}

export interface SolanaRail {
  getSettlementBalance(owner: string): Promise<SettlementBalance>
  getReceiveDestination(owner: string): Promise<ReceiveDestination>
}

export interface SolanaRailOptions {
  readonly rpcUrl: string
  readonly expectedCluster: SolanaCluster
  readonly allowMainnet: boolean
  readonly settlementMint: string
  readonly rpcTimeoutMs?: number | undefined
}

export interface SolanaRailWithRpcOptions {
  readonly rpc: SolanaRpc
  readonly expectedCluster: SolanaCluster
  readonly allowMainnet: boolean
  readonly settlementMint: string
  readonly rpcTimeoutMs?: number | undefined
}

interface SettlementMetadata {
  readonly decimals: number
}

export class SolanaRailConfigurationError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = 'SolanaRailConfigurationError'
  }
}

function parseAddress(value: string, fieldName: string): Address {
  try {
    return address(value)
  } catch {
    throw new SolanaRailConfigurationError(`Invalid Solana ${fieldName}`)
  }
}

function validateTimeout(timeoutMs: number): number {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new SolanaRailConfigurationError(
      'Solana RPC timeout must be a positive integer',
    )
  }
  return timeoutMs
}

function tokenToUsdMoney(tokenAtomicUnits: bigint, tokenDecimals: number): Money {
  if (
    tokenAtomicUnits < 0n ||
    !Number.isInteger(tokenDecimals) ||
    tokenDecimals < 0 ||
    tokenDecimals > 255
  ) {
    throw new ExternalRailError('Settlement token returned invalid balance metadata')
  }

  if (tokenDecimals >= USD_DECIMAL_PLACES) {
    // Sub-cent token atoms remain in the rail result; spendable USD is truncated.
    const divisor = 10n ** BigInt(tokenDecimals - USD_DECIMAL_PLACES)
    return moneyFromAtomicUnits(tokenAtomicUnits / divisor)
  }

  const multiplier = 10n ** BigInt(USD_DECIMAL_PLACES - tokenDecimals)
  return moneyFromAtomicUnits(tokenAtomicUnits * multiplier)
}

function toExternalRailError(error: unknown): ExternalRailError {
  if (error instanceof ExternalRailError) {
    return error
  }
  return new ExternalRailError(
    'Solana settlement rail is unavailable',
    undefined,
    'RETRYABLE',
  )
}

function identifyCluster(genesisHash: string): SolanaCluster | undefined {
  for (const [cluster, knownGenesisHash] of Object.entries(GENESIS_HASHES)) {
    if (genesisHash === knownGenesisHash) {
      return cluster as SolanaCluster
    }
  }
  return undefined
}

function assertExpectedCluster(
  expectedCluster: SolanaCluster,
  allowMainnet: boolean,
  genesisHash: string,
): void {
  const actualCluster = identifyCluster(genesisHash)
  if (actualCluster === 'mainnet-beta' && !allowMainnet) {
    throw new SolanaRailConfigurationError(
      'Mainnet RPC detected but ALLOW_MAINNET is not enabled',
    )
  }
  if (actualCluster !== undefined && actualCluster !== expectedCluster) {
    throw new SolanaRailConfigurationError(
      `Solana RPC cluster mismatch: expected ${expectedCluster}, detected ${actualCluster}`,
    )
  }
  if (expectedCluster !== 'localnet' && actualCluster !== expectedCluster) {
    throw new SolanaRailConfigurationError(
      `Solana RPC cluster mismatch: expected ${expectedCluster}`,
    )
  }
  if (expectedCluster === 'mainnet-beta' && !allowMainnet) {
    throw new SolanaRailConfigurationError(
      'Mainnet requires ALLOW_MAINNET=true as an explicit safety flag',
    )
  }
}

export function createSolanaRail(options: SolanaRailOptions): SolanaRail {
  return createSolanaRailWithRpc({
    rpc: createSolanaRpc(options.rpcUrl as ClusterUrl),
    expectedCluster: options.expectedCluster,
    allowMainnet: options.allowMainnet,
    settlementMint: options.settlementMint,
    rpcTimeoutMs: options.rpcTimeoutMs,
  })
}

export function createSolanaRailWithRpc(options: SolanaRailWithRpcOptions): SolanaRail {
  if (options.expectedCluster === 'mainnet-beta' && !options.allowMainnet) {
    throw new SolanaRailConfigurationError(
      'Mainnet requires ALLOW_MAINNET=true as an explicit safety flag',
    )
  }
  const settlementMint = parseAddress(options.settlementMint, 'settlement mint')
  const timeoutMs = validateTimeout(options.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS)
  let metadataPromise: Promise<SettlementMetadata> | undefined

  async function withRpcTimeout<T>(
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController()
    let timedOut = false
    let timeout: NodeJS.Timeout | undefined
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        timedOut = true
        controller.abort()
        reject(
          new ExternalRailError('Solana RPC request timed out', undefined, 'RETRYABLE'),
        )
      }, timeoutMs)
    })
    try {
      return await Promise.race([operation(controller.signal), timeoutPromise])
    } catch (error) {
      if (timedOut || controller.signal.aborted) {
        throw new ExternalRailError(
          'Solana RPC request timed out',
          undefined,
          'RETRYABLE',
        )
      }
      throw toExternalRailError(error)
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout)
      }
    }
  }

  async function validateSettlementMetadata(): Promise<SettlementMetadata> {
    const genesisHash = await withRpcTimeout((abortSignal) =>
      options.rpc.getGenesisHash().send({ abortSignal }),
    )
    assertExpectedCluster(options.expectedCluster, options.allowMainnet, genesisHash)

    const mintAccount = await withRpcTimeout((abortSignal) =>
      fetchMaybeMint(options.rpc, settlementMint, { abortSignal }),
    )
    if (!mintAccount.exists) {
      throw new ExternalRailError('Configured settlement mint is unavailable')
    }
    if (mintAccount.programAddress !== TOKEN_PROGRAM_ADDRESS) {
      throw new ExternalRailError(
        'Configured settlement mint uses an unsupported token program',
      )
    }
    if (!mintAccount.data.isInitialized) {
      throw new ExternalRailError('Configured settlement mint is not initialized')
    }
    if (
      !Number.isInteger(mintAccount.data.decimals) ||
      mintAccount.data.decimals < 0 ||
      mintAccount.data.decimals > 255
    ) {
      throw new ExternalRailError('Configured settlement mint has invalid decimals')
    }
    return { decimals: mintAccount.data.decimals }
  }

  async function getSettlementMetadata(): Promise<SettlementMetadata> {
    if (metadataPromise === undefined) {
      metadataPromise = validateSettlementMetadata().catch((error: unknown) => {
        metadataPromise = undefined
        throw error
      })
    }
    return metadataPromise
  }

  async function deriveDestinationWithoutValidation(
    ownerValue: string,
  ): Promise<ReceiveDestination> {
    const owner = parseAddress(ownerValue, 'account public key')
    try {
      const [tokenAccount] = await findAssociatedTokenPda({
        owner,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
        mint: settlementMint,
      })
      return { owner, tokenAccount, settlementMint }
    } catch (error) {
      throw toExternalRailError(error)
    }
  }

  return {
    async getReceiveDestination(owner): Promise<ReceiveDestination> {
      await getSettlementMetadata()
      return deriveDestinationWithoutValidation(owner)
    },

    async getSettlementBalance(owner): Promise<SettlementBalance> {
      const metadata = await getSettlementMetadata()
      const destination = await deriveDestinationWithoutValidation(owner)
      try {
        const tokenAccount = await withRpcTimeout((abortSignal) =>
          fetchMaybeToken(options.rpc, destination.tokenAccount as Address, {
            abortSignal,
          }),
        )
        if (!tokenAccount.exists) {
          return {
            currency: 'USD',
            settled: moneyFromAtomicUnits(0n),
            tokenAtomicUnits: 0n,
            tokenDecimals: metadata.decimals,
            ata: destination.tokenAccount,
            ataStatus: 'MISSING',
          }
        }
        if (
          tokenAccount.programAddress !== TOKEN_PROGRAM_ADDRESS ||
          tokenAccount.data.mint !== settlementMint ||
          tokenAccount.data.owner !== destination.owner
        ) {
          throw new ExternalRailError(
            'Settlement token account has unexpected ownership',
          )
        }

        const tokenAtomicUnits = tokenAccount.data.amount
        return {
          currency: 'USD',
          settled: tokenToUsdMoney(tokenAtomicUnits, metadata.decimals),
          tokenAtomicUnits,
          tokenDecimals: metadata.decimals,
          ata: destination.tokenAccount,
          ataStatus: 'PRESENT',
        }
      } catch (error) {
        throw toExternalRailError(error)
      }
    },
  }
}

export { tokenToUsdMoney }
