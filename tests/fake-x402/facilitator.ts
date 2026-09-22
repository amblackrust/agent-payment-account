import {
  createKeyPairSignerFromBytes,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  partiallySignTransaction,
} from '@solana/kit'
import { createKeyPairFromBytes } from '@solana/keys'
import type { FakeX402Config } from './config.js'
import type { FakeX402Rpc } from './rpc.js'
import type {
  FakeX402PaymentSubmitter,
  FakeX402PaymentSubmission,
} from './verification.js'

const SOLANA_SECRET_KEY_BYTES = 64

export async function createDevnetFacilitator(input: {
  readonly config: FakeX402Config
  readonly rpc: FakeX402Rpc
  readonly secret?: string
}): Promise<FakeX402PaymentSubmitter> {
  let keyPair: Awaited<ReturnType<typeof createKeyPairFromBytes>> | undefined
  if (input.secret !== undefined) {
    const secretBytes = parseSecretKey(input.secret)
    try {
      const [parsedKeyPair, signer] = await Promise.all([
        createKeyPairFromBytes(secretBytes, false),
        createKeyPairSignerFromBytes(secretBytes, false),
      ])
      if (signer.address !== input.config.facilitatorFeePayer) {
        throw new Error(
          'FAKE_X402_FACILITATOR_SECRET does not match FAKE_X402_FEE_PAYER',
        )
      }
      keyPair = parsedKeyPair
    } finally {
      secretBytes.fill(0)
    }
  }
  const sendTransaction = input.rpc.sendTransaction
  if (sendTransaction === undefined) {
    throw new Error('The configured devnet RPC cannot submit facilitator transactions')
  }

  return async (submission: FakeX402PaymentSubmission): Promise<string> => {
    const signedTransaction =
      keyPair === undefined
        ? submission.transaction
        : await partiallySignTransaction([keyPair], submission.transaction as never)
    const transactionSignature = String(
      getSignatureFromTransaction(signedTransaction as never),
    )
    const wireTransaction = getBase64EncodedWireTransaction(signedTransaction as never)
    const rpcSignature = await sendTransaction(wireTransaction, {
      encoding: 'base64',
      skipPreflight: false,
      preflightCommitment: 'confirmed',
      maxRetries: 3,
    }).send()
    if (String(rpcSignature) !== transactionSignature) {
      throw new Error('Devnet RPC returned a different transaction signature')
    }
    return transactionSignature
  }
}

function parseSecretKey(value: string): Uint8Array {
  const trimmed = value.trim()
  if (/^[0-9a-fA-F]{128}$/u.test(trimmed)) {
    return Uint8Array.from(trimmed.match(/.{2}/gu) ?? [], (byte) =>
      Number.parseInt(byte, 16),
    )
  }
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (
        Array.isArray(parsed) &&
        parsed.length === SOLANA_SECRET_KEY_BYTES &&
        parsed.every(
          (byte): byte is number =>
            typeof byte === 'number' &&
            Number.isInteger(byte) &&
            byte >= 0 &&
            byte <= 255,
        )
      ) {
        return Uint8Array.from(parsed)
      }
    } catch {
      // Keep key parsing failures free of secret material.
    }
  }
  const decoded = Buffer.from(trimmed, 'base64')
  if (
    decoded.length === SOLANA_SECRET_KEY_BYTES &&
    decoded.toString('base64') === trimmed
  ) {
    return new Uint8Array(decoded)
  }
  throw new Error('FAKE_X402_FACILITATOR_SECRET must be a 64-byte key')
}
