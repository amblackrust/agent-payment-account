import { describe, expect, it } from 'vitest'
import { loadFakeX402Config } from './config.js'

const validEnvironment = {
  FAKE_X402_TEST_USDC_MINT: 'So11111111111111111111111111111111111111112',
  FAKE_X402_DESTINATION: '11111111111111111111111111111111',
  FAKE_X402_FEE_PAYER: 'SysvarRent111111111111111111111111111111111',
  FAKE_X402_RESOURCE_URL: 'http://127.0.0.1:4542/api/crypto/price?ids=bitcoin',
}

describe('fake x402 configuration', () => {
  it('requires an HTTPS RPC URL before the runtime genesis check', () => {
    expect(() =>
      loadFakeX402Config({
        ...validEnvironment,
        FAKE_X402_RPC_URL: 'http://api.devnet.solana.com',
      }),
    ).toThrow('must use HTTPS')
  })

  it('allows an HTTPS endpoint and leaves network identity to the genesis check', () => {
    const config = loadFakeX402Config({
      ...validEnvironment,
      FAKE_X402_RPC_URL: 'https://rpc.example.test/devnet',
    })

    expect(config.rpcUrl).toBe('https://rpc.example.test/devnet')
  })

  it('parses the test-only lost-response switch explicitly', () => {
    expect(
      loadFakeX402Config({
        ...validEnvironment,
        FAKE_X402_DROP_RESPONSE_AFTER_SETTLEMENT: 'true',
      }).dropResponseAfterSettlement,
    ).toBe(true)
    expect(() =>
      loadFakeX402Config({
        ...validEnvironment,
        FAKE_X402_DROP_RESPONSE_AFTER_SETTLEMENT: 'yes',
      }),
    ).toThrow('must be true or false')
  })
})
