import { address, getAddressEncoder } from '@solana/kit'
import {
  getMintEncoder,
  getTokenEncoder,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token'
import { formatMoney } from '@agent-payment/core'
import { describe, expect, it } from 'vitest'

import {
  createSolanaRailWithRpc,
  SolanaRailConfigurationError,
  tokenToUsdMoney,
} from './read.js'

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

function createMockRpc(
  accounts: Map<string, MockRpcAccount>,
  genesisHash = 'localnet-genesis',
): never {
  return {
    getGenesisHash() {
      return { send: async () => genesisHash }
    },
    getAccountInfo(accountAddress: string) {
      return {
        send: async () => ({ value: accounts.get(accountAddress) ?? null }),
      }
    },
  } as never
}

function mintData(decimals: number, isInitialized = true): Uint8Array {
  return new Uint8Array(
    getMintEncoder().encode({
      mintAuthority: null,
      supply: 0n,
      decimals,
      isInitialized,
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
  it('converts raw SPL units to canonical USD cents without floating point arithmetic', () => {
    expect(formatMoney(tokenToUsdMoney(0n, 6))).toBe('0.00')
    expect(formatMoney(tokenToUsdMoney(12_500_000n, 6))).toBe('12.50')
    expect(formatMoney(tokenToUsdMoney(12_500_001n, 6))).toBe('12.50')
    expect(formatMoney(tokenToUsdMoney(1250n, 2))).toBe('12.50')
    expect(formatMoney(tokenToUsdMoney(12n, 1))).toBe('1.20')
    expect(formatMoney(tokenToUsdMoney(12n, 0))).toBe('12.00')
    expect(formatMoney(tokenToUsdMoney(120n, 1))).toBe('12.00')
    expect(formatMoney(tokenToUsdMoney(18446744073709551615n, 6))).toBe(
      '18446744073709.55',
    )
  })

  it('treats a missing associated token account as zero balance', async () => {
    const rail = createSolanaRailWithRpc({
      rpc: createMockRpc(
        new Map([[mint, encodeAccount(TOKEN_PROGRAM_ADDRESS, mintData(6))]]),
      ) as never,
      expectedCluster: 'localnet',
      allowMainnet: false,
      settlementMint: mint,
    })
    const result = await rail.getSettlementBalance(owner)

    expect(formatMoney(result.settled)).toBe('0.00')
    expect(result.tokenAtomicUnits).toBe(0n)
    expect(result.tokenDecimals).toBe(6)
    expect(result.ataStatus).toBe('MISSING')
  })

  it('reads present balances and preserves unusual decimals and bigint precision', async () => {
    const destinationRail = createSolanaRailWithRpc({
      rpc: createMockRpc(
        new Map([[mint, encodeAccount(TOKEN_PROGRAM_ADDRESS, mintData(3))]]),
      ),
      expectedCluster: 'localnet',
      allowMainnet: false,
      settlementMint: mint,
    })
    const destination = await destinationRail.getReceiveDestination(owner)
    const amount = 18446744073709551615n
    const accounts = new Map<string, MockRpcAccount>([
      [mint, encodeAccount(TOKEN_PROGRAM_ADDRESS, mintData(3))],
      [
        destination.tokenAccount,
        encodeAccount(TOKEN_PROGRAM_ADDRESS, tokenData(amount)),
      ],
    ])
    const rail = createSolanaRailWithRpc({
      rpc: createMockRpc(accounts) as never,
      expectedCluster: 'localnet',
      allowMainnet: false,
      settlementMint: mint,
    })

    const result = await rail.getSettlementBalance(owner)

    expect(result.tokenAtomicUnits).toBe(amount)
    expect(result.tokenDecimals).toBe(3)
    expect(formatMoney(result.settled)).toBe('18446744073709551.61')
    expect(result.ataStatus).toBe('PRESENT')
    expect(getAddressEncoder().encode(address(result.ata))).toHaveLength(32)
  })

  it('validates a configured mint before returning receive instructions', async () => {
    const missingMint = createSolanaRailWithRpc({
      rpc: createMockRpc(new Map()),
      expectedCluster: 'localnet',
      allowMainnet: false,
      settlementMint: mint,
    })
    await expect(missingMint.getReceiveDestination(owner)).rejects.toMatchObject({
      code: 'EXTERNAL_RAIL_FAILURE',
      message: 'Configured settlement mint is unavailable',
    })

    const wrongProgram = createSolanaRailWithRpc({
      rpc: createMockRpc(
        new Map([
          [mint, encodeAccount('11111111111111111111111111111111', mintData(6))],
        ]),
      ),
      expectedCluster: 'localnet',
      allowMainnet: false,
      settlementMint: mint,
    })
    await expect(wrongProgram.getReceiveDestination(owner)).rejects.toMatchObject({
      code: 'EXTERNAL_RAIL_FAILURE',
      message: 'Configured settlement mint uses an unsupported token program',
    })

    const uninitialized = createSolanaRailWithRpc({
      rpc: createMockRpc(
        new Map([[mint, encodeAccount(TOKEN_PROGRAM_ADDRESS, mintData(6, false))]]),
      ),
      expectedCluster: 'localnet',
      allowMainnet: false,
      settlementMint: mint,
    })
    await expect(uninitialized.getReceiveDestination(owner)).rejects.toMatchObject({
      code: 'EXTERNAL_RAIL_FAILURE',
      message: 'Configured settlement mint is not initialized',
    })

    const valid = createSolanaRailWithRpc({
      rpc: createMockRpc(
        new Map([[mint, encodeAccount(TOKEN_PROGRAM_ADDRESS, mintData(6))]]),
      ),
      expectedCluster: 'localnet',
      allowMainnet: false,
      settlementMint: mint,
    })
    await expect(valid.getReceiveDestination(owner)).resolves.toMatchObject({
      settlementMint: mint,
    })
  })

  it('rejects RPC network identity mismatches and mainnet without explicit enablement', async () => {
    const mismatch = createSolanaRailWithRpc({
      rpc: createMockRpc(new Map(), 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'),
      expectedCluster: 'testnet',
      allowMainnet: false,
      settlementMint: mint,
    })
    await expect(mismatch.getReceiveDestination(owner)).rejects.toBeInstanceOf(
      SolanaRailConfigurationError,
    )

    const mainnetRpc = createSolanaRailWithRpc({
      rpc: createMockRpc(
        new Map([[mint, encodeAccount(TOKEN_PROGRAM_ADDRESS, mintData(6))]]),
        '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
      ),
      expectedCluster: 'localnet',
      allowMainnet: false,
      settlementMint: mint,
    })
    await expect(mainnetRpc.getReceiveDestination(owner)).rejects.toThrow(
      'ALLOW_MAINNET',
    )
    expect(() =>
      createSolanaRailWithRpc({
        rpc: createMockRpc(new Map()),
        expectedCluster: 'mainnet-beta',
        allowMainnet: false,
        settlementMint: mint,
      }),
    ).toThrow('ALLOW_MAINNET')

    const explicitlyEnabled = createSolanaRailWithRpc({
      rpc: createMockRpc(
        new Map([[mint, encodeAccount(TOKEN_PROGRAM_ADDRESS, mintData(6))]]),
        '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
      ),
      expectedCluster: 'mainnet-beta',
      allowMainnet: true,
      settlementMint: mint,
    })
    await expect(explicitlyEnabled.getReceiveDestination(owner)).resolves.toBeDefined()
  })

  it('normalizes RPC failures as external rail errors', async () => {
    const rail = createSolanaRailWithRpc({
      rpc: {
        getGenesisHash: () => ({ send: async () => 'localnet-genesis' }),
        getAccountInfo: () => ({
          send: async () => {
            throw new Error('rpc secret should not escape')
          },
        }),
      } as never,
      expectedCluster: 'localnet',
      allowMainnet: false,
      settlementMint: mint,
    })

    await expect(rail.getSettlementBalance(owner)).rejects.toMatchObject({
      code: 'EXTERNAL_RAIL_FAILURE',
      message: 'Solana settlement rail is unavailable',
    })
  })

  it('performs fresh RPC and mint validation for every readiness check', async () => {
    let rpcAvailable = true
    const accounts: Map<string, MockRpcAccount> = new Map([
      [mint, encodeAccount(TOKEN_PROGRAM_ADDRESS, mintData(6))],
    ])
    const rail = createSolanaRailWithRpc({
      rpc: {
        getGenesisHash: () => ({
          send: async () => {
            if (!rpcAvailable) throw new Error('offline provider detail')
            return 'localnet-genesis'
          },
        }),
        getAccountInfo: (accountAddress: string) => ({
          send: async () => ({ value: accounts.get(accountAddress) ?? null }),
        }),
      } as never,
      expectedCluster: 'localnet',
      allowMainnet: false,
      settlementMint: mint,
    })

    await expect(rail.getReceiveDestination(owner)).resolves.toBeDefined()
    rpcAvailable = false
    await expect(rail.checkReadiness?.()).rejects.toMatchObject({
      code: 'EXTERNAL_RAIL_FAILURE',
    })
  })

  it('returns a typed external failure when RPC exceeds the configured timeout', async () => {
    const rail = createSolanaRailWithRpc({
      rpc: {
        getGenesisHash: () => ({
          send: () => new Promise<string>(() => undefined),
        }),
      } as never,
      expectedCluster: 'localnet',
      allowMainnet: false,
      settlementMint: mint,
      rpcTimeoutMs: 5,
    })

    await expect(rail.getReceiveDestination(owner)).rejects.toMatchObject({
      code: 'EXTERNAL_RAIL_FAILURE',
      message: 'Solana RPC request timed out',
      kind: 'RETRYABLE',
    })
  })

  it('rejects an invalid configured mint before RPC access', () => {
    expect(() =>
      createSolanaRailWithRpc({
        rpc: createMockRpc(new Map()) as never,
        expectedCluster: 'localnet',
        allowMainnet: false,
        settlementMint: 'bad-mint',
      }),
    ).toThrow('Invalid Solana settlement mint')
  })
})
