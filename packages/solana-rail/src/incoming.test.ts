import { describe, expect, it } from 'vitest'
import { moneyFromAtomicUnits } from '@agent-payment/core'
import type { SolanaRpc, SolanaRail } from './read.js'
import { createSolanaIncomingReader } from './incoming.js'

const owner = '11111111111111111111111111111111'
const tokenAccount = 'So11111111111111111111111111111111111111112'
const sourceToken = 'SysvarRent111111111111111111111111111111111'
const mint = '11111111111111111111111111111111'

function createReader(transaction: unknown) {
  const rpc = {
    getSignaturesForAddress: () => ({ send: async () => [{ signature: 'sig-1', err: null, blockTime: 1_700_000_000 }] }),
    getTransaction: () => ({ send: async () => transaction }),
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
          { accountIndex: 2, mint, owner: sourceToken, uiTokenAmount: { amount: '5000000' } },
          { accountIndex: 1, mint, owner, uiTokenAmount: { amount: '0' } },
        ],
        postTokenBalances: [
          { accountIndex: 2, mint, owner: sourceToken, uiTokenAmount: { amount: '3000000' } },
          { accountIndex: 1, mint, owner, uiTokenAmount: { amount: '2000000' } },
        ],
      },
      transaction: {
        message: {
          accountKeys: ['11111111111111111111111111111111', tokenAccount, sourceToken],
          instructions: [{ program: 'spl-memo', parsed: 'recv_reference' }],
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

  it('ignores wrong mint, failed and non-incoming transactions', async () => {
    const reader = createReader({
      blockTime: null,
      meta: {
        err: null,
        preTokenBalances: [{ accountIndex: 1, mint: 'So11111111111111111111111111111111111111112', owner, uiTokenAmount: { amount: '0' } }],
        postTokenBalances: [{ accountIndex: 1, mint: 'So11111111111111111111111111111111111111112', owner, uiTokenAmount: { amount: '1000000' } }],
      },
      transaction: { message: { accountKeys: [tokenAccount] } },
    })
    await expect(reader.scan(owner)).resolves.toEqual([])
  })
})
