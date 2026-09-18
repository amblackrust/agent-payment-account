import { createHash } from 'node:crypto'
import {
  address,
  createKeyPairSignerFromBytes,
  getBase64EncodedWireTransaction,
  getTransactionDecoder,
} from '@solana/kit'
import { createKeyPairFromBytes } from '@solana/keys'
import { partiallySignTransaction } from '@solana/transactions'
import { ExternalRailError } from '@agent-payment/core'

const SOLANA_SECRET_KEY_BYTES = 64

export interface SolanaX402PreparedPayload {
  readonly version: 1
  readonly protocol: 'x402-v2'
  readonly payerOwner: string
  readonly recipientOwner: string
  readonly payerAta: string
  readonly recipientAta: string
  readonly settlementMint: string
  readonly tokenAmount: string
  readonly feePayerIdentity: string
  readonly transactionBase64: string
  readonly payloadHash: string
  readonly requirementHash: string
  readonly paymentPayloadJson: string
}

export interface SolanaX402SigningRequest {
  readonly effectHash: string
  readonly keyVersion: number
  readonly network: string
  readonly assetReference: string
  readonly destination: string
  readonly amountAtomic: bigint
  readonly feePayerIdentity: string
  readonly preparedPayload: string
}

export interface SolanaX402SignedEffect {
  readonly effectHash: string
  readonly keyVersion: number
  readonly signedPayload: Uint8Array
  /** Durable effect identity; the facilitator's transaction signature is not known yet. */
  readonly externalId: string
}

export async function signSolanaX402PreparedEffect(input: {
  readonly request: SolanaX402SigningRequest
  readonly payerSecret: string | Uint8Array
}): Promise<SolanaX402SignedEffect> {
  const payload = parseSolanaX402PreparedPayload(input.request.preparedPayload)
  if (
    input.request.feePayerIdentity !== payload.feePayerIdentity ||
    input.request.destination !== payload.recipientOwner ||
    input.request.assetReference !== payload.settlementMint ||
    input.request.amountAtomic !== BigInt(payload.tokenAmount)
  ) {
    throw new ExternalRailError(
      'Prepared x402 payload does not match the constrained signing request',
      undefined,
      'DETERMINISTIC',
    )
  }
  if (
    input.request.network.length === 0 ||
    !/^[0-9a-f]{64}$/u.test(input.request.effectHash) ||
    input.request.keyVersion <= 0
  ) {
    throw new ExternalRailError(
      'Prepared x402 signing request is invalid',
      undefined,
      'DETERMINISTIC',
    )
  }

  const secretBytes = parseSecretKey(input.payerSecret)
  try {
    const payerSigner = await createKeyPairSignerFromBytes(secretBytes, false)
    if (payerSigner.address !== payload.payerOwner) {
      throw new ExternalRailError(
        'Payer custody public key does not match the prepared x402 effect',
        undefined,
        'DETERMINISTIC',
      )
    }
    const transactionBytes = Uint8Array.from(
      Buffer.from(payload.transactionBase64, 'base64'),
    )
    const transaction = getTransactionDecoder().decode(transactionBytes)
    const signatures = transaction.signatures as unknown as Readonly<
      Record<string, unknown>
    >
    const signerAddresses = Object.keys(signatures)
    if (
      !signerAddresses.includes(payload.payerOwner) ||
      !signerAddresses.includes(payload.feePayerIdentity) ||
      signatures[payload.payerOwner] !== null ||
      signatures[payload.feePayerIdentity] !== null
    ) {
      throw new ExternalRailError(
        'Prepared x402 transaction does not have the expected unsigned signer slots',
        undefined,
        'DETERMINISTIC',
      )
    }
    const messageHash = sha256(Uint8Array.from(transaction.messageBytes))
    if (messageHash !== payload.payloadHash) {
      throw new ExternalRailError(
        'Prepared x402 transaction hash does not match its durable payload',
        undefined,
        'DETERMINISTIC',
      )
    }
    const keyPair = await createKeyPairFromBytes(secretBytes, false)
    const signedTransaction = await partiallySignTransaction([keyPair], transaction)
    const signedPayload = Uint8Array.from(
      Buffer.from(getBase64EncodedWireTransaction(signedTransaction), 'base64'),
    )
    const signedSignatures = signedTransaction.signatures as unknown as Readonly<
      Record<string, unknown>
    >
    if (signedSignatures[payload.payerOwner] === null) {
      throw new ExternalRailError(
        'Custody did not add the Agent Account x402 signature',
        undefined,
        'DETERMINISTIC',
      )
    }
    return {
      effectHash: input.request.effectHash,
      keyVersion: input.request.keyVersion,
      signedPayload,
      externalId: `x402-effect:${payload.payloadHash}`,
    }
  } finally {
    secretBytes.fill(0)
  }
}

export function parseSolanaX402PreparedPayload(
  serialized: string,
): SolanaX402PreparedPayload {
  let parsed: unknown
  try {
    parsed = JSON.parse(serialized) as unknown
  } catch {
    throw new ExternalRailError(
      'Prepared x402 payload is invalid JSON',
      undefined,
      'DETERMINISTIC',
    )
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as { version?: unknown }).version !== 1 ||
    (parsed as { protocol?: unknown }).protocol !== 'x402-v2'
  ) {
    throw new ExternalRailError(
      'Prepared x402 payload has an unsupported format',
      undefined,
      'DETERMINISTIC',
    )
  }
  const value = parsed as Record<string, unknown>
  const requiredStrings = [
    'payerOwner',
    'recipientOwner',
    'payerAta',
    'recipientAta',
    'settlementMint',
    'tokenAmount',
    'feePayerIdentity',
    'transactionBase64',
    'payloadHash',
    'requirementHash',
    'paymentPayloadJson',
  ] as const
  for (const field of requiredStrings) {
    if (typeof value[field] !== 'string' || value[field].length === 0) {
      throw new ExternalRailError(
        'Prepared x402 payload is incomplete',
        undefined,
        'DETERMINISTIC',
      )
    }
  }
  for (const field of [
    'payerOwner',
    'recipientOwner',
    'payerAta',
    'recipientAta',
    'settlementMint',
    'feePayerIdentity',
  ] as const) {
    try {
      address(value[field] as string)
    } catch {
      throw new ExternalRailError(
        'Prepared x402 payload contains an invalid Solana address',
        undefined,
        'DETERMINISTIC',
      )
    }
  }
  if (
    !/^\d+$/u.test(value.tokenAmount as string) ||
    !/^[0-9a-f]{64}$/u.test(value.payloadHash as string) ||
    !/^[0-9a-f]{64}$/u.test(value.requirementHash as string) ||
    Buffer.from(value.transactionBase64 as string, 'base64').length === 0
  ) {
    throw new ExternalRailError(
      'Prepared x402 payload contains invalid numeric or hash fields',
      undefined,
      'DETERMINISTIC',
    )
  }
  try {
    JSON.parse(value.paymentPayloadJson as string)
  } catch {
    throw new ExternalRailError(
      'Prepared x402 payment payload is invalid JSON',
      undefined,
      'DETERMINISTIC',
    )
  }
  return {
    version: 1,
    protocol: 'x402-v2',
    payerOwner: value.payerOwner as string,
    recipientOwner: value.recipientOwner as string,
    payerAta: value.payerAta as string,
    recipientAta: value.recipientAta as string,
    settlementMint: value.settlementMint as string,
    tokenAmount: value.tokenAmount as string,
    feePayerIdentity: value.feePayerIdentity as string,
    transactionBase64: value.transactionBase64 as string,
    payloadHash: value.payloadHash as string,
    requirementHash: value.requirementHash as string,
    paymentPayloadJson: value.paymentPayloadJson as string,
  }
}

function parseSecretKey(value: string | Uint8Array): Uint8Array {
  if (value instanceof Uint8Array) {
    if (value.length !== SOLANA_SECRET_KEY_BYTES) {
      throw new ExternalRailError(
        'Payer secret must contain a 64-byte Solana secret key',
        undefined,
        'DETERMINISTIC',
      )
    }
    return new Uint8Array(value)
  }
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
      // The stable validation error intentionally omits the secret value.
    }
  }
  const decoded = Buffer.from(trimmed, 'base64')
  if (
    decoded.length === SOLANA_SECRET_KEY_BYTES &&
    decoded.toString('base64') === trimmed
  ) {
    return new Uint8Array(decoded)
  }
  throw new ExternalRailError(
    'Payer secret must be a 64-byte JSON array, hex or base64 secret key',
    undefined,
    'DETERMINISTIC',
  )
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}
