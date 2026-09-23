import { describe, expect, it } from 'vitest'
import { generateManagedWallet } from '@agent-payment/solana-rail'

import {
  ConstrainedCustodyBoundary,
  type ConstrainedCustodyBackend,
  validateLegacyWalletCustody,
  WalletEncryptionError,
  WalletSecretCipher,
} from './custody.js'

const masterKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

describe('wallet secret custody', () => {
  it('requires a 32-byte hexadecimal master key', () => {
    expect(() => new WalletSecretCipher('too-short')).toThrow(WalletEncryptionError)
    expect(() => new WalletSecretCipher('z'.repeat(64))).toThrow(WalletEncryptionError)
  })

  it('encrypts and decrypts wallet material with authenticated encryption', () => {
    const cipher = new WalletSecretCipher(masterKey)
    const secret = Uint8Array.from({ length: 64 }, (_, index) => index)
    const encrypted = cipher.encrypt(secret)

    expect(JSON.stringify(encrypted)).not.toContain(
      Buffer.from(secret).toString('base64'),
    )
    expect(cipher.decrypt(encrypted)).toEqual(secret)
  })

  it('rejects tampered ciphertext', () => {
    const cipher = new WalletSecretCipher(masterKey)
    const encrypted = cipher.encrypt(Uint8Array.from([1, 2, 3]))
    const tamperedCiphertext = Buffer.from(encrypted.ciphertext, 'base64')
    tamperedCiphertext[0] = (tamperedCiphertext[0] ?? 0) ^ 1
    const tampered = {
      ...encrypted,
      ciphertext: tamperedCiphertext.toString('base64'),
    }

    expect(() => cipher.decrypt(tampered)).toThrow('Unable to decrypt wallet secret')
  })

  it('validates legacy encrypted custody against its stored public key', async () => {
    const wallet = await generateManagedWallet()
    const cipher = new WalletSecretCipher('a'.repeat(64))
    const encrypted = cipher.encrypt(wallet.secretKey)
    wallet.secretKey.fill(0)
    const custody = {
      accountId: 'acct_legacy',
      solanaPublicKey: wallet.publicKey,
      encryptedSolanaSecret: encrypted.ciphertext,
      encryptionNonce: encrypted.nonce,
      encryptionAuthTag: encrypted.authTag,
    }

    await expect(validateLegacyWalletCustody(cipher, custody)).resolves.toBeUndefined()
    await expect(
      validateLegacyWalletCustody(new WalletSecretCipher('b'.repeat(64)), custody),
    ).rejects.toThrow('runtime identity was not initialized')
    await expect(
      validateLegacyWalletCustody(cipher, {
        ...custody,
        solanaPublicKey: '11111111111111111111111111111111',
      }),
    ).rejects.toThrow('runtime identity was not initialized')
  })
})

describe('constrained custody boundary', () => {
  const request = {
    accountId: 'acct_1',
    paymentId: 'pay_1',
    attemptId: 'attempt_1',
    effectHash: 'a'.repeat(64),
    network: 'localnet',
    assetReference: 'mint',
    destination: 'destination',
    amountAtomic: 10n,
    feePayerIdentity: 'fee-payer',
    keyVersion: 1,
  }

  it('rejects local custody in production and does not expose generic signing', () => {
    const backend: ConstrainedCustodyBackend = {
      identity: 'local-test',
      mode: 'LOCAL_TEST',
      signPaymentEffect: async () => ({
        effectHash: request.effectHash,
        keyVersion: 1,
        signedPayload: Uint8Array.from([1]),
        externalId: 'sig',
      }),
    }
    expect(() => new ConstrainedCustodyBoundary(backend, 'production')).toThrow(
      'external backend',
    )
    expect('sign' in backend).toBe(false)
  })

  it('rejects provider responses that change the constrained effect', async () => {
    const boundary = new ConstrainedCustodyBoundary(
      {
        identity: 'test',
        mode: 'LOCAL_TEST',
        signPaymentEffect: async () => ({
          effectHash: 'b'.repeat(64),
          keyVersion: 1,
          signedPayload: Uint8Array.from([1]),
          externalId: 'sig',
        }),
      },
      'test',
    )
    await expect(boundary.signPaymentEffect(request)).rejects.toThrow('effect hash')
  })

  it('rejects malformed provider signing responses at the boundary', async () => {
    const boundary = new ConstrainedCustodyBoundary(
      {
        identity: 'test',
        mode: 'LOCAL_TEST',
        signPaymentEffect: async () =>
          ({
            effectHash: request.effectHash,
            keyVersion: request.keyVersion,
            signedPayload: 'not-bytes',
            externalId: 42,
          }) as never,
      },
      'test',
    )

    await expect(boundary.signPaymentEffect(request)).rejects.toThrow(
      'incomplete signed effect',
    )
  })
})
