import { createKeyPairSignerFromBytes, generateKeyPairSigner } from '@solana/kit'

const SOLANA_SECRET_KEY_BYTES = 64
const SOLANA_PRIVATE_SEED_BYTES = 32
const SOLANA_PUBLIC_KEY_BYTES = 32

export interface GeneratedManagedWallet {
  readonly publicKey: string
  readonly secretKey: Uint8Array
}

/**
 * Exports the standard Solana 64-byte secret-key representation only long
 * enough for the custody boundary to encrypt it.
 */
export async function generateManagedWallet(): Promise<GeneratedManagedWallet> {
  const signer = await generateKeyPairSigner(true)
  const [privateKeyBytes, publicKeyBytes] = await Promise.all([
    crypto.subtle.exportKey('pkcs8', signer.keyPair.privateKey),
    crypto.subtle.exportKey('raw', signer.keyPair.publicKey),
  ])
  const privateSeed = new Uint8Array(privateKeyBytes).slice(16)
  const publicKey = new Uint8Array(publicKeyBytes)

  if (
    privateSeed.length !== SOLANA_PRIVATE_SEED_BYTES ||
    publicKey.length !== SOLANA_PUBLIC_KEY_BYTES
  ) {
    throw new Error('Generated Solana keypair has an unexpected format')
  }

  const secretKey = new Uint8Array(SOLANA_SECRET_KEY_BYTES)
  secretKey.set(privateSeed)
  secretKey.set(publicKey, SOLANA_PRIVATE_SEED_BYTES)
  privateSeed.fill(0)

  return { publicKey: signer.address, secretKey }
}

export async function deriveManagedWalletPublicKey(
  secretKey: Uint8Array,
): Promise<string> {
  if (secretKey.length !== SOLANA_SECRET_KEY_BYTES) {
    throw new Error('Managed Solana secret key must contain 64 bytes')
  }
  const signer = await createKeyPairSignerFromBytes(secretKey, false)
  return signer.address
}
