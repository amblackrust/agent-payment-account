import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import type { AccountCustodyRecord } from '@agent-payment/db'
import { deriveManagedWalletPublicKey } from '@agent-payment/solana-rail'
import { CustodyUnavailableError, ValidationError } from '@agent-payment/core'

const AES_GCM_ALGORITHM = 'aes-256-gcm'
const NONCE_BYTES = 12
const AUTH_TAG_BYTES = 16

export interface EncryptedWalletSecret {
  readonly ciphertext: string
  readonly nonce: string
  readonly authTag: string
}

export interface ConstrainedEffectSigningRequest {
  readonly accountId: string
  readonly paymentId: string
  readonly attemptId: string
  readonly correlationId?: string
  readonly effectHash: string
  readonly network: string
  readonly assetReference: string
  readonly destination: string
  readonly amountAtomic: bigint
  readonly feePayerIdentity: string
  readonly keyVersion: number
  /**
   * Provider-specific, unsigned effect material. It is included in the
   * constrained request so a custody backend can sign the exact prepared
   * effect after a worker restart without receiving an arbitrary message API.
   */
  readonly preparedPayload?: string
}

export interface ConstrainedSignedEffect {
  readonly effectHash: string
  readonly keyVersion: number
  readonly signedPayload: Uint8Array
  readonly externalId: string
}

/** A provider-facing interface with no generic arbitrary-message signing method. */
export interface ConstrainedCustodyBackend {
  readonly identity: string
  readonly mode: 'EXTERNAL' | 'LOCAL_TEST'
  signPaymentEffect(
    request: ConstrainedEffectSigningRequest,
  ): Promise<ConstrainedSignedEffect>
}

export class ConstrainedCustodyBoundary {
  public constructor(
    private readonly backend: ConstrainedCustodyBackend,
    private readonly environment: 'development' | 'test' | 'production',
  ) {
    if (environment === 'production' && backend.mode !== 'EXTERNAL') {
      throw new CustodyUnavailableError(
        'Production custody requires an explicitly configured external backend',
      )
    }
  }

  public async signPaymentEffect(
    request: ConstrainedEffectSigningRequest,
  ): Promise<ConstrainedSignedEffect> {
    validateEffectSigningRequest(request)
    const signed = await this.backend.signPaymentEffect(request)
    try {
      if (
        signed === null ||
        typeof signed !== 'object' ||
        typeof signed.effectHash !== 'string' ||
        typeof signed.keyVersion !== 'number' ||
        !(signed.signedPayload instanceof Uint8Array) ||
        typeof signed.externalId !== 'string' ||
        signed.signedPayload.byteLength === 0 ||
        signed.externalId.length === 0
      ) {
        throw new CustodyUnavailableError(
          'Custody returned an incomplete signed effect',
        )
      }
      if (signed.effectHash !== request.effectHash) {
        throw new CustodyUnavailableError('Custody returned a mismatched effect hash')
      }
      if (signed.keyVersion !== request.keyVersion) {
        throw new CustodyUnavailableError('Custody returned a mismatched key version')
      }
      return signed
    } catch (error) {
      if (
        signed !== null &&
        typeof signed === 'object' &&
        'signedPayload' in signed &&
        signed.signedPayload instanceof Uint8Array
      ) {
        signed.signedPayload.fill(0)
      }
      throw error
    }
  }
}

function validateEffectSigningRequest(request: ConstrainedEffectSigningRequest): void {
  if (
    request.accountId.length === 0 ||
    request.paymentId.length === 0 ||
    request.attemptId.length === 0
  ) {
    throw new ValidationError('Custody signing identity is incomplete')
  }
  if (!/^[0-9a-f]{64}$/u.test(request.effectHash)) {
    throw new ValidationError('Custody effect hash must be SHA-256')
  }
  if (
    request.amountAtomic <= 0n ||
    !Number.isInteger(request.keyVersion) ||
    request.keyVersion <= 0
  ) {
    throw new ValidationError('Custody signing amount or key version is invalid')
  }
  if (
    request.network.length === 0 ||
    request.assetReference.length === 0 ||
    request.destination.length === 0 ||
    request.feePayerIdentity.length === 0
  ) {
    throw new ValidationError('Custody signing effect is incomplete')
  }
  if (
    request.correlationId !== undefined &&
    (request.correlationId.length === 0 || request.correlationId.length > 128)
  ) {
    throw new ValidationError('Custody correlation ID is invalid')
  }
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

/**
 * Recovery envelopes use a separately configured key so API credential
 * recovery is not coupled to wallet custody key rotation.
 */
export class RecoveryEnvelopeCipher extends WalletSecretCipher {}

export function fingerprintWalletMasterKey(masterKey: string): string {
  const key = decodeMasterKey(masterKey)
  try {
    return createHash('sha256').update(key).digest('hex').slice(0, 32)
  } finally {
    key.fill(0)
  }
}

export async function validateLegacyWalletCustody(
  cipher: WalletSecretCipher,
  custody: AccountCustodyRecord,
): Promise<void> {
  let secret: Uint8Array | undefined
  try {
    secret = cipher.decrypt({
      ciphertext: custody.encryptedSolanaSecret,
      nonce: custody.encryptionNonce,
      authTag: custody.encryptionAuthTag,
    })
    const publicKey = await deriveManagedWalletPublicKey(secret)
    if (publicKey !== custody.solanaPublicKey) throw new Error('public key mismatch')
  } catch {
    throw new WalletEncryptionError(
      'Legacy account custody validation failed; runtime identity was not initialized',
    )
  } finally {
    secret?.fill(0)
  }
}
