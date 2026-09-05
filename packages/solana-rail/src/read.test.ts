import { address, getAddressEncoder } from '@solana/kit'
import {
  getMintEncoder,
  getTokenEncoder,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token'
import { describe, expect, it } from 'vitest'

import { createSolanaRailWithRpc, formatTokenAmount } from './read.js'

const owner = address('11111111111111111111111111111111')
const mint = address('So11111111111111111111111111111111111111112')

type MockRpcAccount = {
  readonly owner: string
  readonly data: readonly [string, 'base64']
  readonly executable: boolean
  readonly lamports: bigint
  readonly space: bigint
}

function encodeAccount(ownerAddress: string, data: Uint8Array): MockRpcAccount {
  return {
    owner: ownerAddress,
    data: [Buffer.from(data).toString('base64'), 'base64'],
    executable: false,
    lamports: 1n,
    space: BigInt(data.length),
  }
}

function createMockRpc(accounts: Map<string, MockRpcAccount>) {
  return {
    getAccountInfo(accountAddress: string) {
      return {
        send: async () => ({ value: accounts.get(accountAddress) ?? null }),
      }
    },
  }
}

function mintData(decimals: number): Uint8Array {
  return new Uint8Array(
    getMintEncoder().encode({
      mintAuthority: null,
      supply: 0n,
      decimals,
      isInitialized: true,
      freezeAuthority: null,
    }),
  )
}

function tokenData(amount: bigint): Uint8Array {
  return new Uint8Array(
    getTokenEncoder().encode({
      mint,
      owner,
      amount,
      delegate: null,
      state: 1,
      isNative: null,
      delegatedAmount: 0n,
      closeAuthority: null,
    }),
  )
}

describe('Solana settlement read rail', () => {
  it('formats token amounts without floating point arithmetic', () => {
    expect(formatTokenAmount(0n, 6)).toBe('0.00')
    expect(formatTokenAmount(1_250_000n, 6)).toBe('1.25')
    expect(formatTokenAmount(1n, 6)).toBe('0.000001')
    expect(formatTokenAmount(123n, 0)).toBe('123.00')
    expect(formatTokenAmount(123456789012345678901234567890n, 6)).toBe(
      '123456789012345678901234.56789',
    )
  })

  it('treats a missing associated token account as zero balance', async () => {
    const rail = createSolanaRailWithRpc({
      rpc: createMockRpc(
        new Map([[mint, encodeAccount(TOKEN_PROGRAM_ADDRESS, mintData(6))]]),
      ) as never,
      settlementMint: mint,
    })
    const result = await rail.getSettlementBalance(owner)

    expect(result.settled).toBe('0.00')
    expect(result.atomicUnits).toBe(0n)
    expect(result.ataStatus).toBe('MISSING')
  })

  it('reads present balances and preserves unusual decimals and bigint precision', async () => {
    const destinationRail = createSolanaRailWithRpc({
      rpc: createMockRpc(new Map()) as never,
      settlementMint: mint,
    })
    const destination = await destinationRail.getReceiveDestination(owner)
    const amount = 18446744073709551615n
    const accounts = new Map([
      [mint, encodeAccount(TOKEN_PROGRAM_ADDRESS, mintData(3))],
      [
        destination.tokenAccount,
        encodeAccount(TOKEN_PROGRAM_ADDRESS, tokenData(amount)),
      ],
    ])
    const rail = createSolanaRailWithRpc({
      rpc: createMockRpc(accounts) as never,
      settlementMint: mint,
    })

    const result = await rail.getSettlementBalance(owner)

    expect(result.atomicUnits).toBe(amount)
    expect(result.settled).toBe('18446744073709551.615')
    expect(result.ataStatus).toBe('PRESENT')
    expect(getAddressEncoder().encode(address(result.ata))).toHaveLength(32)
  })

  it('normalizes RPC failures as external rail errors', async () => {
    const rail = createSolanaRailWithRpc({
      rpc: {
        getAccountInfo: () => ({
          send: async () => {
            throw new Error('rpc secret should not escape')
          },
        }),
      } as never,
      settlementMint: mint,
    })

    await expect(rail.getSettlementBalance(owner)).rejects.toMatchObject({
      code: 'EXTERNAL_RAIL_FAILURE',
      message: 'Solana settlement rail is unavailable',
    })
  })

  it('rejects an invalid configured mint before RPC access', () => {
    expect(() =>
      createSolanaRailWithRpc({
        rpc: createMockRpc(new Map()) as never,
        settlementMint: 'bad-mint',
      }),
    ).toThrow('Invalid Solana settlement mint')
  })
})
