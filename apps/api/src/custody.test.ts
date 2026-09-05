import { describe, expect, it } from 'vitest'

import { WalletEncryptionError, WalletSecretCipher } from './custody.js'

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
})
