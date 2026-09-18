import { createHash } from 'node:crypto'
import { address } from '@solana/kit'
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from '@x402/core/http'
import type { PaymentPayload, PaymentRequired, SettleResponse } from '@x402/core/types'
import { ValidationError } from '@agent-payment/core'

export const X402_SOLANA_MAINNET_NETWORK = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'
export const X402_SOLANA_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
export const X402_ABSOLUTE_MAX_PAYMENT_ATOMIC = 100_000n
export const X402_PROTOCOL = 'x402-v2'
export const X402_PAYMENT_REQUIRED_HEADER = 'PAYMENT-REQUIRED'
export const X402_PAYMENT_SIGNATURE_HEADER = 'PAYMENT-SIGNATURE'
export const X402_PAYMENT_RESPONSE_HEADER = 'PAYMENT-RESPONSE'
export const X402_RESOURCE_URL = 'https://x402engine.app/api/crypto/price?ids=bitcoin'
const MAX_PROTOCOL_METADATA_BYTES = 16 * 1024

export interface X402SelectedRequirement {
  readonly scheme: 'exact'
  readonly network: typeof X402_SOLANA_MAINNET_NETWORK
  readonly amount: string
  readonly asset: string
  readonly payTo: string
  readonly maxTimeoutSeconds: number
  readonly extra: Readonly<Record<string, unknown>> & { readonly feePayer: string }
}

export interface X402PaymentRequiredSnapshot {
  readonly paymentRequired: PaymentRequired
  readonly requirement: X402SelectedRequirement
}

export interface X402ResourceResponse {
  readonly status: number
  readonly body: unknown
  readonly settlement: SettleResponse | null
  readonly requestId?: string
}

export class X402ProtocolError extends ValidationError {
  public constructor(message: string) {
    super(message)
    this.name = 'X402ProtocolError'
  }
}

export function parsePaymentRequiredResponse(
  response: Response,
  resourceUrl: string,
  expectedAsset: string,
): X402PaymentRequiredSnapshot {
  if (response.status !== 402) {
    throw new X402ProtocolError(
      `x402 discovery expected HTTP 402, received ${response.status}`,
    )
  }
  const encoded = response.headers.get(X402_PAYMENT_REQUIRED_HEADER)
  if (encoded === null) {
    throw new X402ProtocolError('x402 response has no PAYMENT-REQUIRED header')
  }
  let paymentRequired: PaymentRequired
  try {
    paymentRequired = decodePaymentRequiredHeader(encoded)
  } catch {
    throw new X402ProtocolError('x402 PAYMENT-REQUIRED header is invalid')
  }
  if (paymentRequired.x402Version !== 2) {
    throw new X402ProtocolError('x402 provider did not advertise protocol version 2')
  }
  if (paymentRequired.resource.url !== resourceUrl) {
    throw new X402ProtocolError(
      'x402 resource URL differs from the configured proof target',
    )
  }
  const compatible = paymentRequired.accepts.filter(
    (candidate): candidate is X402SelectedRequirement =>
      candidate.scheme === 'exact' &&
      candidate.network === X402_SOLANA_MAINNET_NETWORK &&
      candidate.asset === expectedAsset &&
      isPositiveAtomicAmount(candidate.amount) &&
      isSolanaAddress(candidate.payTo) &&
      typeof candidate.maxTimeoutSeconds === 'number' &&
      Number.isInteger(candidate.maxTimeoutSeconds) &&
      candidate.maxTimeoutSeconds > 0 &&
      candidate.maxTimeoutSeconds <= 3_600 &&
      isSolanaAddress(candidate.extra?.feePayer),
  )
  if (compatible.length !== 1) {
    throw new X402ProtocolError(
      compatible.length === 0
        ? 'x402 provider has no compatible Solana mainnet USDC requirement'
        : 'x402 provider returned multiple compatible payment requirements',
    )
  }
  const requirement = compatible[0]
  if (requirement === undefined) {
    throw new X402ProtocolError('x402 provider returned no usable payment requirement')
  }
  return { paymentRequired, requirement }
}

export function createPaymentSignatureHeader(payload: PaymentPayload): string {
  return encodePaymentSignatureHeader(payload)
}

export function parsePaymentResourceResponse(
  response: Response,
  body: unknown,
): X402ResourceResponse {
  const encoded = response.headers.get(X402_PAYMENT_RESPONSE_HEADER)
  let settlement: SettleResponse | null = null
  if (encoded !== null) {
    try {
      settlement = decodePaymentResponseHeader(encoded)
    } catch {
      throw new X402ProtocolError('x402 PAYMENT-RESPONSE header is invalid')
    }
  }
  const requestId = response.headers.get('x-request-id') ?? undefined
  return {
    status: response.status,
    body,
    settlement,
    ...(requestId === undefined ? {} : { requestId }),
  }
}

export function assertSuccessfulSettlement(
  settlement: SettleResponse | null,
  expectedNetwork: string = X402_SOLANA_MAINNET_NETWORK,
): asserts settlement is SettleResponse & {
  readonly success: true
  readonly transaction: string
  readonly network: string
  readonly payer: string
} {
  if (
    settlement === null ||
    settlement.success !== true ||
    typeof settlement.transaction !== 'string' ||
    settlement.transaction.length === 0 ||
    settlement.network !== expectedNetwork ||
    typeof settlement.payer !== 'string' ||
    settlement.payer.length === 0
  ) {
    throw new X402ProtocolError('x402 settlement response is not confirmed')
  }
}

export function hashRequirement(requirement: X402SelectedRequirement): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        scheme: requirement.scheme,
        network: requirement.network,
        amount: requirement.amount,
        asset: requirement.asset,
        payTo: requirement.payTo,
        max_timeout_seconds: requirement.maxTimeoutSeconds,
        fee_payer: requirement.extra.feePayer,
      }),
    )
    .digest('hex')
}

export function serializeProtocolMetadata(value: unknown): string {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) {
    throw new X402ProtocolError('x402 protocol metadata must be JSON serializable')
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_PROTOCOL_METADATA_BYTES) {
    throw new X402ProtocolError('x402 protocol metadata exceeds the safe size limit')
  }
  return serialized
}

export function isX402PaymentMetadata(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return false
  try {
    const parsed: unknown = JSON.parse(value)
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      (parsed as { protocol?: unknown }).protocol === X402_PROTOCOL
    )
  } catch {
    return false
  }
}

export function parseX402Metadata(value: string | null | undefined): {
  readonly resourceUrl: string
  readonly method: 'GET'
} {
  if (!isX402PaymentMetadata(value)) {
    throw new X402ProtocolError('Payment is not an x402 v2 payment')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(value as string) as unknown
  } catch {
    throw new X402ProtocolError('x402 payment metadata is invalid JSON')
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { resource_url?: unknown }).resource_url !== 'string' ||
    (parsed as { method?: unknown }).method !== 'GET'
  ) {
    throw new X402ProtocolError('x402 payment metadata is incomplete')
  }
  return {
    resourceUrl: (parsed as { resource_url: string }).resource_url,
    method: 'GET',
  }
}

function isPositiveAtomicAmount(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9]\d*$/u.test(value)
}

function isSolanaAddress(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false
  try {
    address(value)
    return true
  } catch {
    return false
  }
}
