import { createHash } from 'node:crypto'
import { address } from '@solana/kit'
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from '@x402/core/http'
import type {
  Network,
  PaymentPayload,
  PaymentRequired,
  SettleResponse,
} from '@x402/core/types'
import { ValidationError } from '@agent-payment/core'

export const X402_SOLANA_MAINNET_NETWORK = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'
export const X402_SOLANA_DEVNET_NETWORK = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'
export const X402_SOLANA_MAINNET_CLUSTER = 'mainnet-beta'
export const X402_SOLANA_DEVNET_CLUSTER = 'devnet'
export const X402_SOLANA_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
export const X402_ABSOLUTE_MAX_PAYMENT_ATOMIC = 100_000n
export const X402_PROTOCOL = 'x402-v2'
export const X402_PAYMENT_REQUIRED_HEADER = 'PAYMENT-REQUIRED'
export const X402_PAYMENT_SIGNATURE_HEADER = 'PAYMENT-SIGNATURE'
export const X402_PAYMENT_RESPONSE_HEADER = 'PAYMENT-RESPONSE'
export const X402_RESOURCE_URL = 'https://x402engine.app/api/crypto/price?ids=bitcoin'
const MAX_PROTOCOL_METADATA_BYTES = 16 * 1024

export interface X402SolanaAdapterConfig {
  readonly network: Network
  readonly routeNetwork: string
  readonly settlementMint: string
  readonly providerDestination?: string
}

export interface X402SolanaAdapterConfigInput {
  readonly network?: string
  readonly routeNetwork?: string
  readonly settlementMint?: string
  readonly providerDestination?: string
}

/**
 * Maps the rail's explicit Solana cluster to the x402 v2 CAIP-2 network.
 * Localnet and testnet intentionally return undefined because this adapter has
 * no implicit x402 provider contract for those environments.
 */
export function x402NetworkForSolanaCluster(
  cluster: string,
): typeof X402_SOLANA_MAINNET_NETWORK | typeof X402_SOLANA_DEVNET_NETWORK | undefined {
  if (cluster === X402_SOLANA_MAINNET_CLUSTER) return X402_SOLANA_MAINNET_NETWORK
  if (cluster === X402_SOLANA_DEVNET_CLUSTER) return X402_SOLANA_DEVNET_NETWORK
  return undefined
}

export interface X402SelectedRequirement {
  readonly scheme: 'exact'
  readonly network: Network
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

export function resolveX402SolanaAdapterConfig(
  input: X402SolanaAdapterConfigInput = {},
): X402SolanaAdapterConfig {
  const network = input.network ?? X402_SOLANA_MAINNET_NETWORK
  if (!isX402SolanaNetwork(network)) {
    throw new X402ProtocolError('x402 Solana network must be a concrete CAIP-2 network')
  }

  const settlementMint =
    input.settlementMint ??
    (network === X402_SOLANA_MAINNET_NETWORK ? X402_SOLANA_USDC_MINT : undefined)
  if (settlementMint === undefined || !isSolanaAddress(settlementMint)) {
    throw new X402ProtocolError('x402 settlement mint must be a valid Solana address')
  }
  if (
    network === X402_SOLANA_DEVNET_NETWORK &&
    settlementMint === X402_SOLANA_USDC_MINT
  ) {
    throw new X402ProtocolError(
      'x402 Solana devnet requires an explicit non-mainnet test settlement mint',
    )
  }

  const routeNetwork = input.routeNetwork ?? inferRouteNetwork(network) ?? undefined
  if (routeNetwork === undefined || routeNetwork.length === 0) {
    throw new X402ProtocolError(
      'x402 route network is required for an unrecognized Solana network',
    )
  }

  if (
    input.providerDestination !== undefined &&
    !isSolanaAddress(input.providerDestination)
  ) {
    throw new X402ProtocolError(
      'x402 provider destination must be a valid Solana address',
    )
  }

  return {
    network,
    routeNetwork,
    settlementMint,
    ...(input.providerDestination === undefined
      ? {}
      : { providerDestination: input.providerDestination }),
  }
}

export function assertCompatibleX402SolanaAdapterConfig(
  config: X402SolanaAdapterConfig,
): void {
  if (
    config.network === X402_SOLANA_MAINNET_NETWORK &&
    (config.routeNetwork !== X402_SOLANA_MAINNET_CLUSTER ||
      config.settlementMint !== X402_SOLANA_USDC_MINT)
  ) {
    throw new X402ProtocolError(
      'x402 mainnet requires the canonical Solana mainnet USDC configuration',
    )
  }
  if (
    config.routeNetwork === X402_SOLANA_MAINNET_CLUSTER &&
    config.network !== X402_SOLANA_MAINNET_NETWORK
  ) {
    throw new X402ProtocolError(
      'x402 mainnet route requires the canonical Solana mainnet network',
    )
  }
  if (
    config.network === X402_SOLANA_DEVNET_NETWORK &&
    (config.routeNetwork !== X402_SOLANA_DEVNET_CLUSTER ||
      config.settlementMint === X402_SOLANA_USDC_MINT)
  ) {
    throw new X402ProtocolError(
      'x402 Solana devnet requires the devnet settlement route and a non-mainnet test mint',
    )
  }
}

export function parsePaymentRequiredResponse(
  response: Response,
  resourceUrl: string,
  expectedAsset: string,
  expectedNetwork: string = X402_SOLANA_MAINNET_NETWORK,
  expectedPayTo?: string,
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
  if (!isX402SolanaNetwork(expectedNetwork) || !isSolanaAddress(expectedAsset)) {
    throw new X402ProtocolError('x402 expected Solana network or asset is invalid')
  }
  if (expectedPayTo !== undefined && !isSolanaAddress(expectedPayTo)) {
    throw new X402ProtocolError('x402 expected provider destination is invalid')
  }
  const compatible = paymentRequired.accepts.filter(
    (candidate): candidate is X402SelectedRequirement =>
      candidate.scheme === 'exact' &&
      candidate.network === expectedNetwork &&
      candidate.asset === expectedAsset &&
      (expectedPayTo === undefined || candidate.payTo === expectedPayTo) &&
      isPositiveAtomicAmount(candidate.amount) &&
      isSolanaAddress(candidate.payTo) &&
      typeof candidate.maxTimeoutSeconds === 'number' &&
      Number.isInteger(candidate.maxTimeoutSeconds) &&
      candidate.maxTimeoutSeconds > 0 &&
      candidate.maxTimeoutSeconds <= 3_600 &&
      isSolanaAddress(candidate.extra?.feePayer),
  )
  if (compatible.length !== 1) {
    const requirementLabel =
      expectedNetwork === X402_SOLANA_MAINNET_NETWORK &&
      expectedAsset === X402_SOLANA_USDC_MINT
        ? 'Solana mainnet USDC'
        : 'the configured Solana network and settlement asset'
    throw new X402ProtocolError(
      compatible.length === 0
        ? `x402 provider has no compatible ${requirementLabel} requirement`
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

function isX402SolanaNetwork(value: unknown): value is Network {
  return typeof value === 'string' && /^solana:[1-9A-HJ-NP-Za-km-z]+$/u.test(value)
}

function inferRouteNetwork(network: string): string | undefined {
  if (network === X402_SOLANA_MAINNET_NETWORK) {
    return X402_SOLANA_MAINNET_CLUSTER
  }
  if (network === X402_SOLANA_DEVNET_NETWORK) {
    return X402_SOLANA_DEVNET_CLUSTER
  }
  return undefined
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
