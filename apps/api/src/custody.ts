import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const AES_GCM_ALGORITHM = 'aes-256-gcm'
const NONCE_BYTES = 12
const AUTH_TAG_BYTES = 16

export interface EncryptedWalletSecret {
  readonly ciphertext: string
  readonly nonce: string
  readonly authTag: string
}

export class WalletEncryptionError extends Error {
  public constructor(message = 'Wallet secret encryption failed') {
    super(message)
    this.name = 'WalletEncryptionError'
  }
}

function decodeMasterKey(masterKey: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(masterKey)) {
    throw new WalletEncryptionError(
      'WALLET_MASTER_KEY must be 32 bytes encoded as 64 hexadecimal characters',
    )
  }
  return Buffer.from(masterKey, 'hex')
}

function decodeBase64(value: string, fieldName: string): Buffer {
  const decoded = Buffer.from(value, 'base64')
  if (decoded.length === 0 || decoded.toString('base64') !== value) {
    throw new WalletEncryptionError(`Invalid encrypted wallet ${fieldName}`)
  }
  return decoded
}

export class WalletSecretCipher {
  private readonly masterKey: Buffer

  public constructor(masterKey: string) {
    this.masterKey = decodeMasterKey(masterKey)
  }

  public encrypt(secret: Uint8Array): EncryptedWalletSecret {
    const nonce = randomBytes(NONCE_BYTES)
    const cipher = createCipheriv(AES_GCM_ALGORITHM, this.masterKey, nonce)
    const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()])
    const authTag = cipher.getAuthTag()

    return {
      ciphertext: ciphertext.toString('base64'),
      nonce: nonce.toString('base64'),
      authTag: authTag.toString('base64'),
    }
  }

  public decrypt(encrypted: EncryptedWalletSecret): Uint8Array {
    try {
      const nonce = decodeBase64(encrypted.nonce, 'nonce')
      const authTag = decodeBase64(encrypted.authTag, 'auth tag')
      const ciphertext = decodeBase64(encrypted.ciphertext, 'ciphertext')
      if (nonce.length !== NONCE_BYTES || authTag.length !== AUTH_TAG_BYTES) {
        throw new WalletEncryptionError('Invalid encrypted wallet metadata')
      }

      const decipher = createDecipheriv(AES_GCM_ALGORITHM, this.masterKey, nonce)
      decipher.setAuthTag(authTag)
      return new Uint8Array(
        Buffer.concat([decipher.update(ciphertext), decipher.final()]),
      )
    } catch (error) {
      if (error instanceof WalletEncryptionError) {
        throw error
      }
      throw new WalletEncryptionError('Unable to decrypt wallet secret')
    }
  }
}
