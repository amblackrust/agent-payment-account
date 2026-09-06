import { createKeyPairSignerFromBytes } from '@solana/kit'
import { describe, expect, it } from 'vitest'

import { deriveManagedWalletPublicKey, generateManagedWallet } from './wallet.js'

describe('managed Solana wallet generation', () => {
  it('generates a valid standard 64-byte secret key with a matching address', async () => {
    const wallet = await generateManagedWallet()
    const signer = await createKeyPairSignerFromBytes(wallet.secretKey)

    expect(wallet.secretKey).toHaveLength(64)
    expect(signer.address).toBe(wallet.publicKey)
    wallet.secretKey.fill(0)
  })

  it('derives the persisted public key from a custody secret', async () => {
    const wallet = await generateManagedWallet()
    await expect(deriveManagedWalletPublicKey(wallet.secretKey)).resolves.toBe(
      wallet.publicKey,
    )
    wallet.secretKey.fill(0)
  })
})
