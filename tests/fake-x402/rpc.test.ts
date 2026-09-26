import { describe, expect, it } from 'vitest'
import { SolanaError, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR } from '@solana/kit'
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

  it('retries a read-only genesis check after an HTTP 429 response', async () => {
    let calls = 0
    const rateLimit = new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, {
      headers: new Headers({ 'retry-after': '0' }),
      message: 'Too Many Requests',
      statusCode: 429,
    })

    await expect(
      assertDevnetRpc({
        getGenesisHash: () => ({
          send: async () => {
            calls += 1
            if (calls === 1) throw rateLimit
            return DEVNET_GENESIS_HASH
          },
        }),
      }),
    ).resolves.toBeUndefined()
    expect(calls).toBe(2)
  })
})
