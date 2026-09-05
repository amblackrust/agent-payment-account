import { describe, expect, it } from 'vitest'
import type { Address } from '@solana/kit'
import { moneyFromAtomicUnits } from '@agent-payment/core'
import type { SolanaRpc, SolanaRail } from './read.js'
import { createSolanaIncomingReader } from './incoming.js'

const owner = '11111111111111111111111111111111'
const tokenAccount = 'So11111111111111111111111111111111111111112'
const sourceToken = 'SysvarRent111111111111111111111111111111111'
const mint = '11111111111111111111111111111111'

function createReader(transaction: unknown | (() => unknown)) {
  const rpc = {
    getSignaturesForAddress: () => ({
      send: async () => [{ signature: 'sig-1', err: null, blockTime: 1_700_000_000 }],
    }),
    getTransaction: () => ({
      send: async () =>
        typeof transaction === 'function' ? transaction() : transaction,
    }),
  } as unknown as SolanaRpc
  const rail: SolanaRail = {
    getReceiveDestination: async () => ({ owner, tokenAccount, settlementMint: mint }),
    getSettlementBalance: async () => ({
      currency: 'USD',
      settled: moneyFromAtomicUnits(0n),
      tokenAtomicUnits: 0n,
      tokenDecimals: 6,
      ata: tokenAccount,
      ataStatus: 'PRESENT',
    }),
  }
  return createSolanaIncomingReader({
    rpc,
    readRail: rail,
    rpcUrl: 'http://localhost:8899',
    expectedCluster: 'localnet',
    allowMainnet: false,
    settlementMint: mint,
  })
}

describe('Solana incoming transfer reader', () => {
  it('accepts only a positive configured-mint delta and extracts the memo reference', async () => {
    const reader = createReader({
      blockTime: 1_700_000_000,
      meta: {
        err: null,
        preTokenBalances: [
          {
            accountIndex: 2,
            mint,
            owner: sourceToken,
            uiTokenAmount: { amount: '5000000' },
          },
          { accountIndex: 1, mint, owner, uiTokenAmount: { amount: '0' } },
        ],
        postTokenBalances: [
          {
            accountIndex: 2,
            mint,
            owner: sourceToken,
            uiTokenAmount: { amount: '3000000' },
          },
          { accountIndex: 1, mint, owner, uiTokenAmount: { amount: '2000000' } },
        ],
      },
      transaction: {
        message: {
          accountKeys: ['11111111111111111111111111111111', tokenAccount, sourceToken],
          instructions: [
            {
              program: 'spl-token',
              parsed: {
                type: 'transferChecked',
                info: {
                  source: sourceToken,
                  destination: tokenAccount,
                  tokenAmount: { amount: '2000000' },
                },
              },
            },
            { program: 'spl-memo', parsed: 'recv_reference' },
          ],
        },
      },
    })

    await expect(reader.scan(owner)).resolves.toEqual([
      expect.objectContaining({
        signature: 'sig-1',
        amount: expect.objectContaining({ currency: 'USD', atomicUnits: 200n }),
        sourceAddress: sourceToken,
        reference: 'recv_reference',
      }),
    ])
  })

  it('does not advance the cursor past an unavailable transaction, then retries it after restart', async () => {
    let available = false
    const reader = createReader(() =>
      available
        ? {
            blockTime: 1_700_000_000,
            meta: {
              err: null,
              preTokenBalances: [
                {
                  accountIndex: 2,
                  mint,
                  owner: sourceToken,
                  uiTokenAmount: { amount: '5000000' },
                },
                { accountIndex: 1, mint, owner, uiTokenAmount: { amount: '0' } },
              ],
              postTokenBalances: [
                {
                  accountIndex: 2,
                  mint,
                  owner: sourceToken,
                  uiTokenAmount: { amount: '3000000' },
                },
                { accountIndex: 1, mint, owner, uiTokenAmount: { amount: '2000000' } },
              ],
            },
            transaction: {
              message: {
                accountKeys: [owner, tokenAccount, sourceToken],
                instructions: [
                  {
                    program: 'spl-token',
                    parsed: {
                      type: 'transfer',
                      info: {
                        source: sourceToken,
                        destination: tokenAccount,
                        amount: '2000000',
                      },
                    },
                  },
                ],
              },
            },
          }
        : null,
    )

    const first = await reader.scanWithCursor!(owner)
    expect(first.transfers).toEqual([])
    expect(first.nextCursor).toBeNull()

    available = true
    const second = await reader.scanWithCursor!(owner)
    expect(second.transfers).toHaveLength(1)
    expect(second.transfers[0]?.signature).toBe('sig-1')
    expect(second.nextCursor).toBe('sig-1')
  })

  it('ignores wrong mint, failed and non-incoming transactions', async () => {
    const reader = createReader({
      blockTime: 1_700_000_000,
      meta: {
        err: null,
        preTokenBalances: [
          {
            accountIndex: 1,
            mint: 'So11111111111111111111111111111111111111112',
            owner,
            uiTokenAmount: { amount: '0' },
          },
        ],
        postTokenBalances: [
          {
            accountIndex: 1,
            mint: 'So11111111111111111111111111111111111111112',
            owner,
            uiTokenAmount: { amount: '1000000' },
          },
        ],
      },
      transaction: { message: { accountKeys: [tokenAccount] } },
    })
    await expect(reader.scan(owner)).resolves.toEqual([])
  })

  it('recognizes an external SPL transfer in an inner instruction', async () => {
    const reader = createReader({
      blockTime: 1_700_000_000,
      meta: {
        err: null,
        preTokenBalances: [
          {
            accountIndex: 2,
            mint,
            owner: sourceToken,
            uiTokenAmount: { amount: '5000000' },
          },
          { accountIndex: 1, mint, owner, uiTokenAmount: { amount: '0' } },
        ],
        postTokenBalances: [
          {
            accountIndex: 2,
            mint,
            owner: sourceToken,
            uiTokenAmount: { amount: '3000000' },
          },
          { accountIndex: 1, mint, owner, uiTokenAmount: { amount: '2000000' } },
        ],
        innerInstructions: [
          {
            index: 0,
            instructions: [
              {
                program: 'spl-token',
                parsed: {
                  type: 'transferChecked',
                  info: {
                    source: sourceToken,
                    destination: tokenAccount,
                    tokenAmount: { amount: '2000000' },
                  },
                },
              },
            ],
          },
        ],
      },
      transaction: { message: { accountKeys: [owner, tokenAccount, sourceToken] } },
    })

    await expect(reader.scan(owner)).resolves.toEqual([
      expect.objectContaining({
        signature: 'sig-1',
        sourceAddress: sourceToken,
        amount: expect.objectContaining({ atomicUnits: 200n }),
      }),
    ])
  })

  it('does not attribute an aggregate from multiple source owners to one source', async () => {
    const sourceTokenTwo = 'Stake11111111111111111111111111111111111111'
    const sourceOwnerTwo = 'Vote111111111111111111111111111111111111111'
    const reader = createReader({
      blockTime: 1_700_000_000,
      meta: {
        err: null,
        preTokenBalances: [
          {
            accountIndex: 2,
            mint,
            owner: sourceToken,
            uiTokenAmount: { amount: '5000000' },
          },
          {
            accountIndex: 3,
            mint,
            owner: sourceOwnerTwo,
            uiTokenAmount: { amount: '5000000' },
          },
          { accountIndex: 1, mint, owner, uiTokenAmount: { amount: '0' } },
        ],
        postTokenBalances: [
          {
            accountIndex: 2,
            mint,
            owner: sourceToken,
            uiTokenAmount: { amount: '4000000' },
          },
          {
            accountIndex: 3,
            mint,
            owner: sourceOwnerTwo,
            uiTokenAmount: { amount: '4500000' },
          },
          { accountIndex: 1, mint, owner, uiTokenAmount: { amount: '1500000' } },
        ],
      },
      transaction: {
        message: {
          accountKeys: [owner, tokenAccount, sourceToken, sourceTokenTwo],
          instructions: [
            {
              program: 'spl-token',
              parsed: {
                type: 'transfer',
                info: {
                  source: sourceToken,
                  destination: tokenAccount,
                  amount: '1000000',
                },
              },
            },
            {
              program: 'spl-token',
              parsed: {
                type: 'transfer',
                info: {
                  source: sourceTokenTwo,
                  destination: tokenAccount,
                  amount: '500000',
                },
              },
            },
          ],
        },
      },
    })

    await expect(reader.scan(owner)).resolves.toEqual([
      expect.objectContaining({ sourceAddress: undefined }),
    ])
  })

  it('does not checkpoint a positive balance change without proven transfer semantics', async () => {
    const reader = createReader({
      blockTime: 1_700_000_000,
      meta: {
        err: null,
        preTokenBalances: [
          { accountIndex: 1, mint, owner, uiTokenAmount: { amount: '0' } },
        ],
        postTokenBalances: [
          { accountIndex: 1, mint, owner, uiTokenAmount: { amount: '2000000' } },
        ],
      },
      transaction: { message: { accountKeys: [owner, tokenAccount] } },
    })

    const result = await reader.scanWithCursor!(owner)

    expect(result.transfers).toEqual([])
    expect(result.nextCursor).toBeNull()
  })

  it('paginates beyond 1000 signatures and returns a high-water checkpoint', async () => {
    const firstPage = Array.from({ length: 1000 }, (_, index) => ({
      signature: `sig-${index}`,
      err: null,
      blockTime: null,
    }))
    const secondPage = [
      { signature: 'incoming-after-backlog', err: null, blockTime: null },
    ]
    const validTransaction = {
      blockTime: 1_700_000_000,
      meta: {
        err: null,
        preTokenBalances: [
          {
            accountIndex: 2,
            mint,
            owner: sourceToken,
            uiTokenAmount: { amount: '5000000' },
          },
          { accountIndex: 1, mint, owner, uiTokenAmount: { amount: '0' } },
        ],
        postTokenBalances: [
          {
            accountIndex: 2,
            mint,
            owner: sourceToken,
            uiTokenAmount: { amount: '3000000' },
          },
          { accountIndex: 1, mint, owner, uiTokenAmount: { amount: '2000000' } },
        ],
      },
      transaction: {
        message: {
          accountKeys: [owner, tokenAccount, sourceToken],
          instructions: [
            {
              program: 'spl-token',
              parsed: {
                type: 'transfer',
                info: {
                  source: sourceToken,
                  destination: tokenAccount,
                  amount: '2000000',
                },
              },
            },
          ],
        },
      },
    }
    const irrelevantTransaction = {
      blockTime: null,
      meta: { err: null, preTokenBalances: [], postTokenBalances: [] },
      transaction: { message: { accountKeys: [] } },
    }
    let pageCalls = 0
    const rpc = {
      getSignaturesForAddress: (_account: Address, config: { before?: string }) => ({
        send: async () => {
          pageCalls += 1
          return config.before === undefined ? firstPage : secondPage
        },
      }),
      getTransaction: (signature: string) => ({
        send: async () =>
          signature === 'incoming-after-backlog'
            ? validTransaction
            : irrelevantTransaction,
      }),
    } as unknown as SolanaRpc
    const rail: SolanaRail = {
      getReceiveDestination: async () => ({
        owner,
        tokenAccount,
        settlementMint: mint,
      }),
      getSettlementBalance: async () => ({
        currency: 'USD',
        settled: moneyFromAtomicUnits(0n),
        tokenAtomicUnits: 0n,
        tokenDecimals: 6,
        ata: tokenAccount,
        ataStatus: 'PRESENT',
      }),
    }
    const reader = createSolanaIncomingReader({
      rpc,
      readRail: rail,
      rpcUrl: 'http://localhost:8899',
      expectedCluster: 'localnet',
      allowMainnet: false,
      settlementMint: mint,
    })

    const result = await reader.scanWithCursor!(owner, 'old-checkpoint')

    expect(pageCalls).toBe(2)
    expect(result.nextCursor).toBe('sig-0')
    expect(result.transfers).toHaveLength(1)
  })

  it('stops at a checkpoint found on a later page and does not re-read irrelevant history', async () => {
    const firstPage = Array.from({ length: 1000 }, (_, index) => ({
      signature: `sig-${index}`,
      err: null,
      blockTime: null,
    }))
    const secondPage = [
      { signature: 'newest-on-page-two', err: null, blockTime: null },
      { signature: 'persisted-checkpoint', err: null, blockTime: null },
      { signature: 'older', err: null, blockTime: null },
    ]
    let pageCalls = 0
    const irrelevantTransaction = {
      blockTime: null,
      meta: { err: null, preTokenBalances: [], postTokenBalances: [] },
      transaction: { message: { accountKeys: [] } },
    }
    const rpc = {
      getSignaturesForAddress: (_account: Address, config: { before?: string }) => ({
        send: async () => {
          pageCalls += 1
          return config.before === undefined ? firstPage : secondPage
        },
      }),
      getTransaction: () => ({ send: async () => irrelevantTransaction }),
    } as unknown as SolanaRpc
    const rail: SolanaRail = {
      getReceiveDestination: async () => ({
        owner,
        tokenAccount,
        settlementMint: mint,
      }),
      getSettlementBalance: async () => ({
        currency: 'USD',
        settled: moneyFromAtomicUnits(0n),
        tokenAtomicUnits: 0n,
        tokenDecimals: 6,
        ata: tokenAccount,
        ataStatus: 'PRESENT',
      }),
    }
    const reader = createSolanaIncomingReader({
      rpc,
      readRail: rail,
      rpcUrl: 'http://localhost:8899',
      expectedCluster: 'localnet',
      allowMainnet: false,
      settlementMint: mint,
    })

    const result = await reader.scanWithCursor!(owner, 'persisted-checkpoint')

    expect(pageCalls).toBe(2)
    expect(result.nextCursor).toBe('sig-0')
    expect(result.transfers).toEqual([])
  })

  it('does not classify self-transfer or mintTo balance changes as incoming', async () => {
    const rpc = {
      getSignaturesForAddress: () => ({
        send: async () => [
          { signature: 'self', err: null, blockTime: null },
          { signature: 'mint', err: null, blockTime: null },
        ],
      }),
      getTransaction: (signature: string) => ({
        send: async () => ({
          blockTime: null,
          meta: {
            err: null,
            preTokenBalances:
              signature === 'self'
                ? [
                    {
                      accountIndex: 2,
                      mint,
                      owner,
                      uiTokenAmount: { amount: '5000000' },
                    },
                    { accountIndex: 1, mint, owner, uiTokenAmount: { amount: '0' } },
                  ]
                : [{ accountIndex: 1, mint, owner, uiTokenAmount: { amount: '0' } }],
            postTokenBalances:
              signature === 'self'
                ? [
                    {
                      accountIndex: 2,
                      mint,
                      owner,
                      uiTokenAmount: { amount: '3000000' },
                    },
                    {
                      accountIndex: 1,
                      mint,
                      owner,
                      uiTokenAmount: { amount: '2000000' },
                    },
                  ]
                : [
                    {
                      accountIndex: 1,
                      mint,
                      owner,
                      uiTokenAmount: { amount: '2000000' },
                    },
                  ],
          },
          transaction: {
            message: {
              accountKeys: [owner, tokenAccount, sourceToken],
              instructions:
                signature === 'self'
                  ? [
                      {
                        program: 'spl-token',
                        parsed: {
                          type: 'transfer',
                          info: {
                            source: sourceToken,
                            destination: tokenAccount,
                            amount: '2000000',
                          },
                        },
                      },
                    ]
                  : [
                      {
                        program: 'spl-token',
                        parsed: { type: 'mintTo', info: { account: tokenAccount } },
                      },
                    ],
            },
          },
        }),
      }),
    } as unknown as SolanaRpc
    const rail: SolanaRail = {
      getReceiveDestination: async () => ({
        owner,
        tokenAccount,
        settlementMint: mint,
      }),
      getSettlementBalance: async () => ({
        currency: 'USD',
        settled: moneyFromAtomicUnits(0n),
        tokenAtomicUnits: 0n,
        tokenDecimals: 6,
        ata: tokenAccount,
        ataStatus: 'PRESENT',
      }),
    }
    const reader = createSolanaIncomingReader({
      rpc,
      readRail: rail,
      rpcUrl: 'http://localhost:8899',
      expectedCluster: 'localnet',
      allowMainnet: false,
      settlementMint: mint,
    })

    await expect(reader.scan(owner)).resolves.toEqual([])
  })

  it('bounds signature RPC reads and returns an external rail failure on timeout', async () => {
    const rpc = {
      getSignaturesForAddress: () => ({
        send: () => new Promise<never>(() => undefined),
      }),
    } as unknown as SolanaRpc
    const rail: SolanaRail = {
      getReceiveDestination: async () => ({
        owner,
        tokenAccount,
        settlementMint: mint,
      }),
      getSettlementBalance: async () => ({
        currency: 'USD',
        settled: moneyFromAtomicUnits(0n),
        tokenAtomicUnits: 0n,
        tokenDecimals: 6,
        ata: tokenAccount,
        ataStatus: 'PRESENT',
      }),
    }
    const reader = createSolanaIncomingReader({
      rpc,
      readRail: rail,
      rpcUrl: 'http://localhost:8899',
      expectedCluster: 'localnet',
      allowMainnet: false,
      settlementMint: mint,
      rpcTimeoutMs: 5,
    })

    await expect(reader.scan(owner)).rejects.toMatchObject({
      code: 'EXTERNAL_RAIL_FAILURE',
      kind: 'RETRYABLE',
    })
  })
})
