import { address, createSolanaRpc, type Address, type ClusterUrl } from '@solana/kit'
import {
  fetchMaybeMint,
  fetchMaybeToken,
  findAssociatedTokenPda,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token'
import { ExternalRailError, ValidationError } from '@agent-payment/core'

type SolanaRpc = Parameters<typeof fetchMaybeMint>[0]

export interface SettlementBalance {
  readonly currency: 'USD'
  readonly atomicUnits: bigint
  readonly settled: string
  readonly decimals: number
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
  readonly settlementMint: string
}

interface SolanaRailWithRpcOptions {
  readonly rpc: SolanaRpc
  readonly settlementMint: string
}

function parseAddress(value: string, fieldName: string): Address {
  try {
    return address(value)
  } catch {
    throw new ValidationError(`Invalid Solana ${fieldName}`)
  }
}

function formatTokenAmount(amount: bigint, decimals: number): string {
  if (amount < 0n || !Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new ExternalRailError('Settlement token returned an invalid balance')
  }

  const scale = 10n ** BigInt(decimals)
  const whole = amount / scale
  if (decimals === 0) {
    return `${whole}.00`
  }

  const fraction = (amount % scale)
    .toString()
    .padStart(decimals, '0')
    .replace(/0+$/, '')
  if (fraction.length === 0) {
    return `${whole}.00`
  }
  return `${whole}.${fraction}`
}

function toExternalRailError(error: unknown): ExternalRailError {
  if (error instanceof ExternalRailError) {
    return error
  }
  return new ExternalRailError('Solana settlement rail is unavailable')
}

export function createSolanaRail(options: SolanaRailOptions): SolanaRail {
  return createSolanaRailWithRpc({
    rpc: createSolanaRpc(options.rpcUrl as ClusterUrl),
    settlementMint: options.settlementMint,
  })
}

export function createSolanaRailWithRpc(options: SolanaRailWithRpcOptions): SolanaRail {
  const settlementMint = parseAddress(options.settlementMint, 'settlement mint')

  async function deriveDestination(ownerValue: string): Promise<ReceiveDestination> {
    const owner = parseAddress(ownerValue, 'account public key')
    try {
      const [tokenAccount] = await findAssociatedTokenPda({
        owner,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
        mint: settlementMint,
      })
      return {
        owner,
        tokenAccount,
        settlementMint,
      }
    } catch (error) {
      throw toExternalRailError(error)
    }
  }

  return {
    async getReceiveDestination(owner): Promise<ReceiveDestination> {
      return deriveDestination(owner)
    },

    async getSettlementBalance(owner): Promise<SettlementBalance> {
      const destination = await deriveDestination(owner)
      try {
        const mintAccount = await fetchMaybeMint(options.rpc, settlementMint)
        if (
          !mintAccount.exists ||
          mintAccount.programAddress !== TOKEN_PROGRAM_ADDRESS
        ) {
          throw new ExternalRailError('Configured settlement mint is unavailable')
        }

        const tokenAccount = await fetchMaybeToken(
          options.rpc,
          destination.tokenAccount as Address,
        )
        if (!tokenAccount.exists) {
          return {
            currency: 'USD',
            atomicUnits: 0n,
            settled: '0.00',
            decimals: mintAccount.data.decimals,
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

        const atomicUnits = tokenAccount.data.amount
        return {
          currency: 'USD',
          atomicUnits,
          settled: formatTokenAmount(atomicUnits, mintAccount.data.decimals),
          decimals: mintAccount.data.decimals,
          ata: destination.tokenAccount,
          ataStatus: 'PRESENT',
        }
      } catch (error) {
        throw toExternalRailError(error)
      }
    },
  }
}

export { formatTokenAmount }
