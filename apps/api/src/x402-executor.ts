import { createHash } from 'node:crypto'
import {
  address,
  createNoopSigner,
  getTransactionDecoder,
  signature,
  type Address,
} from '@solana/kit'
import {
  fetchMaybeMint,
  fetchMaybeToken,
  findAssociatedTokenPda,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token'
import { x402Client } from '@x402/core/client'
import { x402HTTPClient } from '@x402/core/http'
import type { PaymentPayload, PaymentRequired } from '@x402/core/types'
import { ExactSvmScheme } from '@x402/svm/exact/client'
import {
  convertFromSettlementAtomicUnits,
  createDenomination,
  createEconomicMapping,
  createSettlementAsset,
  ExternalRailError,
  type SettlementRoute,
} from '@agent-payment/core'
import type { SolanaRpc } from '@agent-payment/solana-rail'
import type { V2PaymentAttemptSnapshot, V2PaymentView } from '@agent-payment/db'
import type { V2OutgoingExecutor, V2PreparedEffect } from './outgoing-v2.js'
import {
  assertSuccessfulSettlement,
  createPaymentSignatureHeader,
  hashRequirement,
  parsePaymentRequiredResponse,
  parsePaymentResourceResponse,
  parseX402Metadata,
  serializeProtocolMetadata,
  X402_ABSOLUTE_MAX_PAYMENT_ATOMIC,
  X402_PROTOCOL,
  X402_SOLANA_MAINNET_NETWORK,
  X402_SOLANA_USDC_MINT,
} from './x402-protocol.js'
import {
  parseSolanaX402PreparedPayload,
  type SolanaX402PreparedPayload,
} from '@agent-payment/solana-rail'

const DEFAULT_HTTP_TIMEOUT_MS = 15_000
const DEFAULT_RPC_TIMEOUT_MS = 5_000
const MAX_RESPONSE_BODY_BYTES = 8 * 1024
const SOLANA_SPL_RAIL = 'SOLANA_SPL'
const MAINNET_CLUSTER = 'mainnet-beta'

export interface X402OutgoingExecutorOptions {
  readonly rpc: SolanaRpc
  readonly rpcUrl: string
  readonly settlementMint: string
  readonly resourceUrl: string
  readonly httpTimeoutMs?: number
  readonly rpcTimeoutMs?: number
  readonly maxPaymentAtomic: bigint
  readonly fetchImpl?: typeof fetch
  getPayerPublicKey(accountId: string): Promise<string | null>
  getDenomination(denominationId: string): Promise<{
    readonly id: string
    readonly symbol: string
    readonly maxScale: number
    readonly status: string
    readonly version: number
  } | null>
  getSettlementAsset(assetId: string): Promise<{
    readonly id: string
    readonly rail: string
    readonly network: string
    readonly assetReference: string
    readonly decimals: number
    readonly status: string
    readonly version: number
  } | null>
  getEconomicMapping(mappingId: string): Promise<{
    readonly id: string
    readonly denominationId: string
    readonly settlementAssetId: string
    readonly numerator: bigint
    readonly denominator: bigint
    readonly status: string
    readonly version: number
  } | null>
  getSettlementRoute(routeId: string): Promise<SettlementRoute | null>
  getActiveKeyVersion(accountId: string): Promise<number | null>
  signPaymentEffect(
    input: Parameters<V2OutgoingExecutor['sign']>[0],
  ): ReturnType<V2OutgoingExecutor['sign']>
}

export function createX402OutgoingExecutor(options: X402OutgoingExecutorOptions): Pick<
  V2OutgoingExecutor,
  'prepare' | 'sign' | 'submit' | 'reconcile'
> & {
  checkReadiness(): Promise<void>
} {
  const settlementMint = parseSolanaAddress(options.settlementMint, 'settlement mint')
  const httpTimeoutMs = options.httpTimeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS
  const rpcTimeoutMs = options.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS
  if (!Number.isInteger(httpTimeoutMs) || httpTimeoutMs <= 0) {
    throw new Error('x402 HTTP timeout must be a positive integer')
  }
  if (!Number.isInteger(rpcTimeoutMs) || rpcTimeoutMs <= 0) {
    throw new Error('x402 RPC timeout must be a positive integer')
  }
  if (options.maxPaymentAtomic <= 0n) {
    throw new Error('x402 maximum payment must be positive')
  }
  if (options.maxPaymentAtomic > X402_ABSOLUTE_MAX_PAYMENT_ATOMIC) {
    throw new Error('x402 maximum payment exceeds the absolute safety cap')
  }
  const fetchImpl = options.fetchImpl ?? fetch

  async function prepare(input: {
    readonly view: V2PaymentView
    readonly attempt: V2PaymentAttemptSnapshot
  }): Promise<V2PreparedEffect> {
    const payment = input.view.payment
    const metadata = parseX402Metadata(payment.metadataJson)
    if (metadata.resourceUrl !== options.resourceUrl) {
      throw deterministicError('x402 resource URL is not the configured proof target')
    }
    if (
      payment.routeId === null ||
      payment.settlementAssetId === null ||
      payment.denominationId === null ||
      payment.amountScale === null
    ) {
      throw deterministicError(
        'x402 payment is missing its immutable economic identity',
      )
    }
    if (input.attempt.routeId !== payment.routeId) {
      throw deterministicError('x402 payment attempt route does not match the payment')
    }
    const route = await requireRoute(await options.getSettlementRoute(payment.routeId))
    const [denominationRecord, assetRecord, mappingRecord, payerPublicKey, keyVersion] =
      await Promise.all([
        options.getDenomination(payment.denominationId),
        options.getSettlementAsset(payment.settlementAssetId),
        options.getEconomicMapping(
          payment.economicMappingId ?? route.economicMappingId,
        ),
        options.getPayerPublicKey(payment.payerAccountId),
        options.getActiveKeyVersion(payment.payerAccountId),
      ])
    if (denominationRecord === null || assetRecord === null || mappingRecord === null) {
      throw new ExternalRailError('x402 economic configuration is unavailable')
    }
    if (payerPublicKey === null) {
      throw new ExternalRailError('x402 payer account is unavailable')
    }
    if (keyVersion === null || !Number.isInteger(keyVersion) || keyVersion <= 0) {
      throw new ExternalRailError('x402 active custody key version is unavailable')
    }
    assertRouteConfiguration(
      route,
      assetRecord,
      mappingRecord,
      denominationRecord,
      settlementMint,
    )
    const denomination = createDenomination({
      id: denominationRecord.id,
      symbol: denominationRecord.symbol,
      maxScale: denominationRecord.maxScale,
      status: 'ACTIVE',
      version: denominationRecord.version,
    })
    const asset = createSettlementAsset({
      id: assetRecord.id,
      rail: assetRecord.rail,
      network: assetRecord.network,
      assetReference: assetRecord.assetReference,
      decimals: assetRecord.decimals,
      status: 'ACTIVE',
      version: assetRecord.version,
    })
    const mapping = createEconomicMapping({
      id: mappingRecord.id,
      denominationId: mappingRecord.denominationId,
      settlementAssetId: mappingRecord.settlementAssetId,
      numerator: mappingRecord.numerator,
      denominator: mappingRecord.denominator,
      status: 'ACTIVE',
      version: mappingRecord.version,
    })
    const discoveryResponse = await fetchResource(options.resourceUrl, false)
    const snapshot = parsePaymentRequiredResponse(
      discoveryResponse,
      options.resourceUrl,
      settlementMint,
    )
    const requirement = snapshot.requirement
    const tokenAmount = BigInt(requirement.amount)
    if (tokenAmount > options.maxPaymentAtomic) {
      throw deterministicError('x402 payment exceeds the configured absolute spend cap')
    }
    const logicalAmount = convertFromSettlementAtomicUnits(
      tokenAmount,
      mapping,
      denomination,
      asset,
    )
    if (logicalAmount.atomicUnits !== payment.amountAtomic) {
      throw deterministicError(
        'Current x402 requirement differs from the immutable logical payment amount',
      )
    }
    const destination = parseDestinationSnapshot(payment.destinationSnapshotJson)
    if (
      destination.rail !== route.rail ||
      destination.network !== route.network ||
      destination.assetReference !== asset.assetReference ||
      destination.walletAddress !== requirement.payTo
    ) {
      throw deterministicError(
        'Current x402 payTo differs from the approved payment destination snapshot',
      )
    }
    const payerOwner = parseSolanaAddress(payerPublicKey, 'payer public key')
    const recipientOwner = parseSolanaAddress(requirement.payTo, 'x402 payTo')
    if (payerOwner === recipientOwner) {
      throw deterministicError('x402 payTo must differ from the Agent Account signer')
    }
    await validateSettlementMint(asset)
    const [payerAta, recipientAta] = await Promise.all([
      findAssociatedTokenPda({
        owner: payerOwner,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
        mint: settlementMint,
      }),
      findAssociatedTokenPda({
        owner: recipientOwner,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
        mint: settlementMint,
      }),
    ])
    await validateSourceTokenAccount(payerAta[0], payerOwner, tokenAmount)
    await validateRecipientTokenAccount(recipientAta[0], recipientOwner)
    const paymentPayload = await createPaymentPayload(
      snapshot.paymentRequired,
      payerOwner,
    )
    const transactionBase64 = readPaymentTransaction(paymentPayload)
    const payloadHash = hashTransactionMessage(transactionBase64)
    const preparedPayload: SolanaX402PreparedPayload = {
      version: 1,
      protocol: X402_PROTOCOL,
      payerOwner,
      recipientOwner,
      payerAta: payerAta[0],
      recipientAta: recipientAta[0],
      settlementMint,
      tokenAmount: requirement.amount,
      feePayerIdentity: requirement.extra.feePayer,
      transactionBase64,
      payloadHash,
      requirementHash: hashRequirement(requirement),
      paymentPayloadJson: JSON.stringify(paymentPayload),
    }
    const preparedPayloadJson = JSON.stringify(preparedPayload)
    const effectHash = sha256(
      JSON.stringify({
        accountId: payment.payerAccountId,
        paymentId: payment.id,
        attemptId: input.attempt.id,
        routeId: route.id,
        network: route.network,
        x402Network: requirement.network,
        assetReference: asset.assetReference,
        destination: recipientOwner,
        amountAtomic: requirement.amount,
        feePayerIdentity: requirement.extra.feePayer,
        requirementHash: hashRequirement(requirement),
        payloadHash,
        keyVersion,
      }),
    )
    return {
      accountId: payment.payerAccountId,
      paymentId: payment.id,
      attemptId: input.attempt.id,
      ...(payment.correlationId === null || payment.correlationId === undefined
        ? {}
        : { correlationId: payment.correlationId }),
      effectHash,
      network: route.network,
      assetReference: asset.assetReference,
      destination: recipientOwner,
      amountAtomic: tokenAmount,
      feePayerIdentity: requirement.extra.feePayer,
      keyVersion,
      preparedPayload: preparedPayloadJson,
      routeId: route.id,
      payloadHash,
      validityExpiresAt: new Date(Date.now() + requirement.maxTimeoutSeconds * 1000),
    }
  }

  async function sign(input: Parameters<V2OutgoingExecutor['sign']>[0]) {
    return options.signPaymentEffect(input)
  }

  async function submit(input: {
    readonly prepared: V2PreparedEffect
    readonly signed: Parameters<V2OutgoingExecutor['submit']>[0]['signed']
  }): Promise<Awaited<ReturnType<V2OutgoingExecutor['submit']>>> {
    return sendPaidRequest(input.prepared, input.signed.signedPayload)
  }

  async function reconcile(input: {
    readonly view: V2PaymentView
    readonly attempt: V2PaymentAttemptSnapshot
    readonly signedPayload?: Uint8Array
  }): Promise<Awaited<ReturnType<NonNullable<V2OutgoingExecutor['reconcile']>>>> {
    const prepared = restorePreparedEffect(input.attempt)
    if (prepared === undefined || input.signedPayload === undefined) {
      return { status: 'UNKNOWN' }
    }
    if (
      input.attempt.signedPayloadHash === null ||
      sha256(input.signedPayload) !== input.attempt.signedPayloadHash
    ) {
      throw deterministicError(
        'Durable x402 signed payload hash does not match the attempt',
      )
    }
    if (input.attempt.expectedExternalId !== null) {
      const observed = await observeSettlementOnChain(input.attempt.expectedExternalId)
      if (observed.status === 'CONFIRMED') {
        return {
          status: 'CONFIRMED',
          externalId: input.attempt.expectedExternalId,
          evidenceMetadataJson: serializeProtocolMetadata({
            protocol: X402_PROTOCOL,
            resource_url: options.resourceUrl,
            on_chain: observed,
          }),
        }
      }
      if (observed.status === 'PENDING' || observed.status === 'FAILED') {
        return {
          status: 'UNKNOWN',
          externalId: input.attempt.expectedExternalId,
          evidenceMetadataJson: serializeProtocolMetadata({
            protocol: X402_PROTOCOL,
            resource_url: options.resourceUrl,
            on_chain: observed,
          }),
        }
      }
    }
    const result = await sendPaidRequest(prepared, input.signedPayload)
    if (result.status === 'CONFIRMED') {
      return {
        status: 'CONFIRMED',
        ...(result.externalId === undefined ? {} : { externalId: result.externalId }),
        ...(result.platformCostActual === undefined
          ? {}
          : { platformCostActual: result.platformCostActual }),
        ...(result.evidenceMetadataJson === undefined
          ? {}
          : { evidenceMetadataJson: result.evidenceMetadataJson }),
      }
    }
    if (result.status === 'UNKNOWN') {
      return {
        status: 'UNKNOWN',
        ...(result.externalId === undefined ? {} : { externalId: result.externalId }),
        ...(result.evidenceMetadataJson === undefined
          ? {}
          : { evidenceMetadataJson: result.evidenceMetadataJson }),
      }
    }
    throw deterministicError('x402 reconciliation returned an invalid terminal status')
  }

  async function checkReadiness(): Promise<void> {
    await validateSettlementMintWithoutPayment()
  }

  async function sendPaidRequest(
    prepared: V2PreparedEffect,
    signedPayload: Uint8Array,
  ): Promise<Awaited<ReturnType<V2OutgoingExecutor['submit']>>> {
    let durable: SolanaX402PreparedPayload
    try {
      durable = parseSolanaX402PreparedPayload(prepared.preparedPayload)
    } catch (error) {
      throw error
    }
    const paymentPayload = parsePaymentPayload(
      durable.paymentPayloadJson,
      durable,
      options.resourceUrl,
    )
    const signedTransaction = Buffer.from(signedPayload).toString('base64')
    validateSignedTransaction(signedPayload, durable)
    const paymentWithSignedTransaction: PaymentPayload = {
      ...paymentPayload,
      payload: {
        ...paymentPayload.payload,
        transaction: signedTransaction,
      },
    }
    const headers = {
      'PAYMENT-SIGNATURE': createPaymentSignatureHeader(paymentWithSignedTransaction),
      accept: 'application/json',
    }
    let response: Response
    try {
      response = await fetchResource(options.resourceUrl, true, headers)
    } catch (error) {
      return {
        status: 'UNKNOWN',
        evidenceMetadataJson: serializeProtocolMetadata({
          protocol: X402_PROTOCOL,
          resource_url: options.resourceUrl,
          transport: 'ERROR',
          error_code: error instanceof ExternalRailError ? error.kind : 'UNKNOWN',
        }),
      }
    }
    let body: unknown
    try {
      body = await readResponseBody(response)
    } catch {
      body = { unavailable: true }
    }
    let parsed
    try {
      parsed = parsePaymentResourceResponse(response, body)
    } catch {
      return {
        status: 'UNKNOWN',
        evidenceMetadataJson: serializeProtocolMetadata({
          protocol: X402_PROTOCOL,
          resource_url: options.resourceUrl,
          http_status: response.status,
          response_body: body,
          protocol_error: 'INVALID_PAYMENT_RESPONSE',
        }),
      }
    }
    const evidence = serializeProtocolMetadata({
      protocol: X402_PROTOCOL,
      resource_url: options.resourceUrl,
      http_status: parsed.status,
      response_body: parsed.body,
      ...(parsed.requestId === undefined
        ? {}
        : { provider_request_id: parsed.requestId }),
      requirement_hash: durable.requirementHash,
      settlement: parsed.settlement,
    })
    try {
      assertSuccessfulSettlement(parsed.settlement)
    } catch {
      return { status: 'UNKNOWN', evidenceMetadataJson: evidence }
    }
    if (parsed.settlement.payer !== durable.payerOwner) {
      return {
        status: 'UNKNOWN',
        evidenceMetadataJson: serializeProtocolMetadata({
          protocol: X402_PROTOCOL,
          resource_url: options.resourceUrl,
          http_status: parsed.status,
          response_body: parsed.body,
          settlement: parsed.settlement,
          protocol_error: 'SETTLEMENT_PAYER_MISMATCH',
        }),
      }
    }
    let onChain
    try {
      onChain = await observeSettlementOnChain(parsed.settlement.transaction)
    } catch (error) {
      return {
        status: 'UNKNOWN',
        externalId: parsed.settlement.transaction,
        evidenceMetadataJson: serializeProtocolMetadata({
          protocol: X402_PROTOCOL,
          resource_url: options.resourceUrl,
          http_status: parsed.status,
          response_body: parsed.body,
          ...(parsed.requestId === undefined
            ? {}
            : { provider_request_id: parsed.requestId }),
          requirement_hash: durable.requirementHash,
          settlement: parsed.settlement,
          on_chain: {
            status: 'RPC_UNAVAILABLE',
            error_code: error instanceof ExternalRailError ? error.kind : 'UNKNOWN',
          },
        }),
      }
    }
    const settledEvidence = serializeProtocolMetadata({
      protocol: X402_PROTOCOL,
      resource_url: options.resourceUrl,
      http_status: parsed.status,
      response_body: parsed.body,
      ...(parsed.requestId === undefined
        ? {}
        : { provider_request_id: parsed.requestId }),
      requirement_hash: durable.requirementHash,
      settlement: parsed.settlement,
      on_chain: onChain,
    })
    if (onChain.status !== 'CONFIRMED') {
      return {
        status: 'UNKNOWN',
        ...(onChain.status === 'INVALID'
          ? {}
          : { externalId: parsed.settlement.transaction }),
        evidenceMetadataJson: settledEvidence,
      }
    }
    return {
      status: 'CONFIRMED',
      externalId: parsed.settlement.transaction,
      evidenceMetadataJson: settledEvidence,
    }
  }

  async function fetchResource(
    url: string,
    paid: boolean,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), httpTimeoutMs)
    try {
      return await fetchImpl(url, {
        method: 'GET',
        headers,
        signal: controller.signal,
      })
    } catch (error) {
      throw new ExternalRailError(
        paid
          ? 'x402 paid resource request outcome is unknown'
          : 'x402 discovery request failed',
        error,
        paid ? 'AMBIGUOUS' : 'RETRYABLE',
      )
    } finally {
      clearTimeout(timeout)
    }
  }

  async function observeSettlementOnChain(
    transactionId: string,
  ): Promise<
    | { readonly status: 'CONFIRMED' }
    | { readonly status: 'PENDING' }
    | { readonly status: 'FAILED' }
    | { readonly status: 'NOT_FOUND' }
    | { readonly status: 'INVALID' }
  > {
    let transactionSignature
    try {
      transactionSignature = signature(transactionId)
    } catch {
      return { status: 'INVALID' }
    }
    const response = await withRpcTimeout((abortSignal) =>
      options.rpc
        .getSignatureStatuses([transactionSignature], {
          searchTransactionHistory: true,
        })
        .send({ abortSignal }),
    )
    const status = response.value[0]
    if (status === null || status === undefined) return { status: 'NOT_FOUND' }
    if (status.err !== null) return { status: 'FAILED' }
    if (
      status.confirmationStatus === 'confirmed' ||
      status.confirmationStatus === 'finalized'
    ) {
      return { status: 'CONFIRMED' }
    }
    return { status: 'PENDING' }
  }

  async function validateSettlementMint(asset: {
    readonly decimals: number
    readonly assetReference: string
  }): Promise<void> {
    if (asset.assetReference !== options.settlementMint) {
      throw deterministicError('x402 settlement mint differs from the configured asset')
    }
    const mint = await withRpcTimeout((abortSignal) =>
      fetchMaybeMint(options.rpc, settlementMint, { abortSignal }),
    )
    if (
      !mint.exists ||
      mint.programAddress !== TOKEN_PROGRAM_ADDRESS ||
      !mint.data.isInitialized ||
      mint.data.decimals !== asset.decimals
    ) {
      throw deterministicError(
        'Configured canonical USDC mint is unavailable or invalid',
      )
    }
  }

  async function validateSettlementMintWithoutPayment(): Promise<void> {
    if (options.settlementMint !== X402_SOLANA_USDC_MINT) {
      throw new ExternalRailError(
        'Configured x402 settlement mint is not canonical Solana USDC',
      )
    }
    const mint = await withRpcTimeout((abortSignal) =>
      fetchMaybeMint(options.rpc, settlementMint, { abortSignal }),
    )
    if (!mint.exists || mint.programAddress !== TOKEN_PROGRAM_ADDRESS) {
      throw new ExternalRailError('Configured settlement mint is unavailable')
    }
  }

  async function validateSourceTokenAccount(
    tokenAccount: Address,
    owner: Address,
    requiredAmount: bigint,
  ): Promise<void> {
    const account = await withRpcTimeout((abortSignal) =>
      fetchMaybeToken(options.rpc, tokenAccount, { abortSignal }),
    )
    if (
      !account.exists ||
      account.programAddress !== TOKEN_PROGRAM_ADDRESS ||
      account.data.mint !== settlementMint ||
      account.data.owner !== owner
    ) {
      throw deterministicError(
        'Agent Account USDC token account is unavailable or invalid',
      )
    }
    if (account.data.amount < requiredAmount) {
      throw deterministicError(
        'Agent Account USDC balance is below the x402 payment amount',
      )
    }
  }

  async function validateRecipientTokenAccount(
    tokenAccount: Address,
    owner: Address,
  ): Promise<void> {
    const account = await withRpcTimeout((abortSignal) =>
      fetchMaybeToken(options.rpc, tokenAccount, { abortSignal }),
    )
    if (
      !account.exists ||
      account.programAddress !== TOKEN_PROGRAM_ADDRESS ||
      account.data.mint !== settlementMint ||
      account.data.owner !== owner
    ) {
      throw deterministicError(
        'x402 payTo Associated Token Account is unavailable; no token-account creation is attempted',
      )
    }
  }

  async function withRpcTimeout<T>(
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), rpcTimeoutMs)
    try {
      return await operation(controller.signal)
    } catch (error) {
      if (controller.signal.aborted) {
        throw new ExternalRailError(
          'x402 Solana RPC request timed out',
          error,
          'RETRYABLE',
        )
      }
      throw new ExternalRailError('x402 Solana RPC request failed', error, 'RETRYABLE')
    } finally {
      clearTimeout(timeout)
    }
  }

  async function createPaymentPayload(
    paymentRequired: PaymentRequired,
    payerOwner: Address,
  ): Promise<PaymentPayload> {
    const coreClient = new x402Client((_version, requirements) => {
      const selected = requirements.find(
        (candidate) =>
          candidate.scheme === 'exact' &&
          candidate.network === X402_SOLANA_MAINNET_NETWORK &&
          candidate.asset === settlementMint &&
          candidate.payTo ===
            paymentRequired.accepts.find(
              (accepted) =>
                accepted.scheme === 'exact' &&
                accepted.network === X402_SOLANA_MAINNET_NETWORK &&
                accepted.asset === settlementMint,
            )?.payTo,
      )
      if (selected === undefined) {
        throw deterministicError(
          'x402 payment requirement changed before payload creation',
        )
      }
      return selected
    })
    coreClient.register(
      X402_SOLANA_MAINNET_NETWORK,
      new ExactSvmScheme(createNoopSigner(payerOwner), { rpcUrl: options.rpcUrl }),
    )
    const httpClient = new x402HTTPClient(coreClient)
    return httpClient.createPaymentPayload(paymentRequired)
  }

  return { prepare, sign, submit, reconcile, checkReadiness }
}

function assertRouteConfiguration(
  route: SettlementRoute,
  asset: {
    readonly id: string
    readonly rail: string
    readonly network: string
    readonly assetReference: string
    readonly decimals: number
    readonly status: string
  },
  mapping: {
    readonly settlementAssetId: string
    readonly denominationId: string
    readonly status: string
  },
  denomination: { readonly id: string; readonly status: string },
  settlementMint: Address,
): void {
  if (
    route.rail !== SOLANA_SPL_RAIL ||
    route.network !== MAINNET_CLUSTER ||
    asset.status !== 'ACTIVE' ||
    asset.rail !== SOLANA_SPL_RAIL ||
    asset.network !== MAINNET_CLUSTER ||
    asset.assetReference !== settlementMint ||
    asset.assetReference !== X402_SOLANA_USDC_MINT ||
    asset.decimals !== 6 ||
    mapping.status !== 'ACTIVE' ||
    mapping.settlementAssetId !== asset.id ||
    mapping.denominationId !== denomination.id ||
    denomination.status !== 'ACTIVE'
  ) {
    throw deterministicError('x402 route configuration is not Solana mainnet USDC')
  }
}

async function requireRoute(route: SettlementRoute | null): Promise<SettlementRoute> {
  if (route === null)
    throw new ExternalRailError('x402 settlement route is unavailable')
  return route
}

function parseDestinationSnapshot(serialized: string | null): {
  readonly rail: string
  readonly network: string
  readonly assetReference: string
  readonly walletAddress: string
} {
  if (serialized === null)
    throw deterministicError('x402 destination snapshot is missing')
  let parsed: unknown
  try {
    parsed = JSON.parse(serialized) as unknown
  } catch {
    throw deterministicError('x402 destination snapshot is invalid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw deterministicError('x402 destination snapshot is invalid')
  }
  const value = parsed as Record<string, unknown>
  const rail = value.rail
  const network = value.network
  const assetReference = value.asset_reference
  const walletAddress = value.wallet_address
  if (
    typeof rail !== 'string' ||
    typeof network !== 'string' ||
    typeof assetReference !== 'string' ||
    typeof walletAddress !== 'string'
  ) {
    throw deterministicError('x402 destination snapshot is incomplete')
  }
  return { rail, network, assetReference, walletAddress }
}

function parsePaymentPayload(
  serialized: string,
  durable: SolanaX402PreparedPayload,
  resourceUrl: string,
): PaymentPayload {
  let parsed: unknown
  try {
    parsed = JSON.parse(serialized) as unknown
  } catch {
    throw deterministicError('x402 durable payment payload is invalid JSON')
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    (parsed as { x402Version?: unknown }).x402Version !== 2
  ) {
    throw deterministicError('x402 durable payment payload is invalid')
  }
  const value = parsed as Record<string, unknown>
  if (
    typeof value.accepted !== 'object' ||
    value.accepted === null ||
    Array.isArray(value.accepted) ||
    typeof value.payload !== 'object' ||
    value.payload === null ||
    Array.isArray(value.payload)
  ) {
    throw deterministicError('x402 durable payment payload is incomplete')
  }
  const transaction = (value.payload as Record<string, unknown>).transaction
  if (typeof transaction !== 'string' || transaction.length === 0) {
    throw deterministicError('x402 durable payment transaction is missing')
  }
  const accepted = value.accepted as Record<string, unknown>
  const extra = accepted.extra
  if (
    accepted.scheme !== 'exact' ||
    accepted.network !== X402_SOLANA_MAINNET_NETWORK ||
    accepted.amount !== durable.tokenAmount ||
    accepted.asset !== durable.settlementMint ||
    accepted.payTo !== durable.recipientOwner ||
    typeof extra !== 'object' ||
    extra === null ||
    Array.isArray(extra) ||
    (extra as Record<string, unknown>).feePayer !== durable.feePayerIdentity ||
    transaction !== durable.transactionBase64 ||
    typeof value.resource !== 'object' ||
    value.resource === null ||
    Array.isArray(value.resource) ||
    (value.resource as Record<string, unknown>).url !== resourceUrl
  ) {
    throw deterministicError(
      'x402 durable payment payload does not match the prepared effect',
    )
  }
  return parsed as PaymentPayload
}

function readPaymentTransaction(payload: PaymentPayload): string {
  const transaction = payload.payload.transaction
  if (typeof transaction !== 'string' || transaction.length === 0) {
    throw deterministicError('x402 scheme did not produce a Solana transaction')
  }
  return transaction
}

function hashTransactionMessage(transactionBase64: string): string {
  const bytes = Buffer.from(transactionBase64, 'base64')
  if (bytes.length === 0) throw deterministicError('x402 transaction payload is empty')
  let decoded
  try {
    decoded = getTransactionDecoder().decode(bytes)
  } catch (error) {
    throw new ExternalRailError(
      'x402 scheme produced an invalid Solana transaction',
      error,
      'DETERMINISTIC',
    )
  }
  return sha256(Uint8Array.from(decoded.messageBytes))
}

function validateSignedTransaction(
  signedPayload: Uint8Array,
  durable: SolanaX402PreparedPayload,
): void {
  let decoded
  try {
    decoded = getTransactionDecoder().decode(signedPayload)
  } catch (error) {
    throw new ExternalRailError(
      'Custody returned an invalid x402 Solana transaction',
      error,
      'DETERMINISTIC',
    )
  }
  if (sha256(Uint8Array.from(decoded.messageBytes)) !== durable.payloadHash) {
    throw deterministicError('Custody changed the prepared x402 transaction message')
  }
  const signatures = decoded.signatures as unknown as Readonly<Record<string, unknown>>
  if (
    signatures[durable.payerOwner] === null ||
    signatures[durable.feePayerIdentity] !== null
  ) {
    throw deterministicError(
      'Custody did not return the expected x402 partial signature',
    )
  }
}

function restorePreparedEffect(
  attempt: V2PaymentAttemptSnapshot,
): V2PreparedEffect | undefined {
  if (attempt.preparedEffectJson === undefined || attempt.preparedEffectJson === null) {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(attempt.preparedEffectJson) as unknown
  } catch {
    throw deterministicError('x402 durable prepared effect is invalid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw deterministicError('x402 durable prepared effect is invalid')
  }
  const value = parsed as Record<string, unknown>
  if (
    typeof value.preparedPayload !== 'string' ||
    typeof value.effectHash !== 'string' ||
    typeof value.payloadHash !== 'string'
  ) {
    throw deterministicError('x402 durable prepared effect is incomplete')
  }
  return {
    ...(value as unknown as V2PreparedEffect),
    amountAtomic: BigInt(String(value.amountAtomic)),
    preparedPayload: value.preparedPayload,
    effectHash: value.effectHash,
    payloadHash: value.payloadHash,
  }
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text()
  const bytes = Buffer.byteLength(text, 'utf8')
  const bounded =
    bytes > MAX_RESPONSE_BODY_BYTES
      ? `${text.slice(0, MAX_RESPONSE_BODY_BYTES)}\n[truncated]`
      : text
  try {
    return JSON.parse(bounded) as unknown
  } catch {
    return bounded
  }
}

function parseSolanaAddress(value: string, field: string): Address {
  try {
    return address(value)
  } catch {
    throw deterministicError(`Invalid ${field}`)
  }
}

function deterministicError(message: string): ExternalRailError {
  return new ExternalRailError(message, undefined, 'DETERMINISTIC')
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex')
}
