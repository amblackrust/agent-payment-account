import { describe, expect, it } from 'vitest'
import { DEVNET_GENESIS_HASH } from './config.js'
import { assertDevnetRpc } from './rpc.js'

describe('fake x402 RPC guard', () => {
  it('accepts the Solana devnet genesis hash', async () => {
    await expect(
      assertDevnetRpc({
        getGenesisHash: () => ({ send: async () => DEVNET_GENESIS_HASH }),
      }),
    ).resolves.toBeUndefined()
  })

  it('rejects an RPC for another Solana cluster', async () => {
    await expect(
      assertDevnetRpc({
        getGenesisHash: () => ({ send: async () => 'mainnet-genesis' }),
      }),
    ).rejects.toThrow('requires the Solana devnet genesis hash')
  })

  it('does not expose an RPC failure as provider response data', async () => {
    await expect(
      assertDevnetRpc({
        getGenesisHash: () => ({
          send: async () => {
            throw new Error('upstream details')
          },
        }),
      }),
    ).rejects.toThrow('could not verify the Solana devnet RPC')
  })
})
