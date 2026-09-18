import { createHash } from 'node:crypto'
import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createKeyPairSignerFromBytes,
  createNoopSigner,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  isSolanaError,
  pipe,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  signature,
  type Address,
  type Base64EncodedWireTransaction,
  type Instruction,
  type KeyPairSigner,
} from '@solana/kit'
import {
  fetchMaybeMint,
  fetchMaybeToken,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token'
import { getAddMemoInstruction } from '@solana-program/memo'
import {
  convertToSettlementAtomicUnits,
  createDenomination,
  createEconomicMapping,
  createSettlementAsset,
  exactMoneyFromAtomicUnits,
  ExternalRailError as CoreExternalRailError,
  MAX_REFERENCE_BYTES,
  type LifecycleStatus,
  type SettlementRoute,
} from '@agent-payment/core'
import {
  DEFAULT_RPC_TIMEOUT_MS,
  type SolanaRpc,
  SolanaRailConfigurationError,
} from './read.js'

const CONFIRMATION_COMMITMENT = 'confirmed' as const
const DEFAULT_MIN_FEE_PAYER_BALANCE_LAMPORTS = 1_000_000n
const SOLANA_SECRET_KEY_BYTES = 64
const SOLANA_SPL_RAIL = 'SOLANA_SPL'

export interface SolanaV2PaymentView {
  readonly payment: {
    readonly id: string
    readonly payerAccountId: string
    readonly correlationId?: string | null
    readonly recipientManagedAccountId: string | null
    readonly externalReference: string | null
    readonly metadataJson?: string
    readonly amountAtomic: bigint
    readonly amountScale: number | null
    readonly denominationId: string | null
    readonly routeId: string | null
    readonly settlementAssetId: string | null
    readonly economicMappingId?: string | null
    readonly destinationSnapshotJson: string | null
  }
}

export interface SolanaV2AttemptSnapshot {
  readonly id: string
  readonly paymentId: string
  readonly attemptNumber: number
  readonly routeId: string | null
  readonly preparedEffectJson?: string | null
}

export interface SolanaV2SigningRequest {
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
  readonly preparedPayload?: string
  readonly routeId?: string
  readonly payloadHash?: string
}

export interface SolanaV2SignedEffect {
  readonly effectHash: string
  readonly keyVersion: number
  readonly signedPayload: Uint8Array
  readonly externalId: string
}

export interface SolanaV2OutgoingExecutorOptions {
  readonly rpc: SolanaRpc
  readonly settlementMint: string
  readonly feePayerSecret?: string | Uint8Array
  readonly rpcTimeoutMs?: number
  readonly minimumFeePayerBalanceLamports?: bigint
  readonly platformCostAssetId?: string
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
  readonly reserveSponsorship?: (input: {
    readonly accountId: string
    readonly paymentId: string
    readonly lamports: bigint
  }) => Promise<void>
  signPaymentEffect(input: SolanaV2SigningRequest): Promise<SolanaV2SignedEffect>
}

export interface SolanaV2PreparedEffect extends SolanaV2SigningRequest {
  readonly paymentId: string
  readonly attemptId: string
  readonly routeId: string
  readonly payloadHash: string
  readonly preparedPayload: string
  readonly platformCostEstimate?: {
    readonly assetId: string
    readonly amountAtomic: bigint
  }
  readonly validitySlot?: bigint
}

interface SolanaV2PlatformCostObservation {
  readonly assetId: string
  readonly amountAtomic: bigint
}

interface SolanaV2PreparedPayload {
  readonly version: 1
  readonly payerOwner: string
  readonly recipientOwner: string
  readonly payerAta: string
  readonly recipientAta: string
  readonly settlementMint: string
  readonly tokenDecimals: number
  readonly tokenAmount: string
  readonly createsRecipientAta: boolean
  readonly blockhash: string
  readonly lastValidBlockHeight: string
  readonly feePayerIdentity: string
  readonly memo: string
  readonly messageBase64: string
  readonly externalReference?: string
}

interface SolanaV2ObservedSignature {
  readonly known: boolean
  readonly status: 'SUBMITTED' | 'CONFIRMED' | 'FAILED'
  readonly failureCode?: string
  readonly failureMessageSafe?: string
}

export function createSolanaV2OutgoingExecutor(
  options: SolanaV2OutgoingExecutorOptions,
): {
  prepare(input: {
    readonly view: SolanaV2PaymentView
    readonly attempt: SolanaV2AttemptSnapshot
  }): Promise<SolanaV2PreparedEffect>
  sign(input: SolanaV2SigningRequest): Promise<SolanaV2SignedEffect>
  submit(input: {
    readonly prepared: SolanaV2PreparedEffect
    readonly signed: SolanaV2SignedEffect
  }): Promise<{
    readonly status: 'SUBMITTED' | 'CONFIRMED' | 'FAILED' | 'UNKNOWN'
    readonly externalId?: string
    readonly failureCode?: string
    readonly failureMessageSafe?: string
    readonly platformCostActual?: SolanaV2PlatformCostObservation
  }>
  reconcile(input: {
    readonly view: SolanaV2PaymentView
    readonly attempt: SolanaV2AttemptSnapshot
  }): Promise<{
    readonly status: 'CONFIRMED' | 'PROVED_NO_EFFECT' | 'UNKNOWN'
    readonly externalId?: string
    readonly platformCostActual?: SolanaV2PlatformCostObservation
  }>
  checkReadiness(): Promise<void>
} {
  const settlementMint = parseAddress(options.settlementMint, 'settlement mint')
  const rpcTimeoutMs = options.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS
  if (!Number.isInteger(rpcTimeoutMs) || rpcTimeoutMs <= 0) {
    throw new SolanaRailConfigurationError(
      'Solana RPC timeout must be a positive integer',
    )
  }
  const minimumFeePayerBalanceLamports =
    options.minimumFeePayerBalanceLamports ?? DEFAULT_MIN_FEE_PAYER_BALANCE_LAMPORTS
  if (minimumFeePayerBalanceLamports <= 0n) {
    throw new SolanaRailConfigurationError(
      'Minimum fee payer balance must be a positive lamport amount',
    )
  }
  const platformCostAssetId = options.platformCostAssetId?.trim()
  if (options.platformCostAssetId !== undefined && platformCostAssetId === '') {
    throw new SolanaRailConfigurationError(
      'Platform cost asset identity must not be empty',
    )
  }
  let feePayerSignerPromise: Promise<KeyPairSigner> | undefined

  async function getFeePayerSigner(): Promise<KeyPairSigner> {
    if (options.feePayerSecret === undefined) {
      throw new SolanaRailConfigurationError(
        'A fee-payer secret is required for outgoing execution',
      )
    }
    feePayerSignerPromise ??= createSigner(options.feePayerSecret, 'fee payer secret')
    return feePayerSignerPromise
  }

  async function withRpcTimeout<T>(
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController()
    let timeout: NodeJS.Timeout | undefined
    let timedOut = false
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        timedOut = true
        controller.abort()
        reject(
          new CoreExternalRailError(
            'Solana RPC request timed out',
            undefined,
            'RETRYABLE',
          ),
        )
      }, rpcTimeoutMs)
    })
    try {
      return await Promise.race([operation(controller.signal), timeoutPromise])
    } catch (error) {
      if (timedOut || controller.signal.aborted) {
        throw new CoreExternalRailError(
          'Solana RPC request timed out',
          undefined,
          'RETRYABLE',
        )
      }
      throw toExternalRailError(error)
    } finally {
      if (timeout !== undefined) clearTimeout(timeout)
    }
  }

  async function getTokenDecimals(): Promise<number> {
    const mint = await withRpcTimeout((abortSignal) =>
      fetchMaybeMint(options.rpc, settlementMint, { abortSignal }),
    )
    if (!mint.exists)
      throw new CoreExternalRailError('Configured settlement mint is unavailable')
    if (mint.programAddress !== TOKEN_PROGRAM_ADDRESS || !mint.data.isInitialized) {
      throw new CoreExternalRailError('Configured settlement mint is invalid')
    }
    return mint.data.decimals
  }

  async function prepare(input: {
    readonly view: SolanaV2PaymentView
    readonly attempt: SolanaV2AttemptSnapshot
  }): Promise<SolanaV2PreparedEffect> {
    const payment = input.view.payment
    if (
      payment.routeId === null ||
      payment.settlementAssetId === null ||
      payment.denominationId === null ||
      payment.amountScale === null
    ) {
      throw new CoreExternalRailError(
        'V2 payment is missing its immutable route or economic identity',
        undefined,
        'DETERMINISTIC',
      )
    }
    if (input.attempt.routeId !== payment.routeId) {
      throw new CoreExternalRailError(
        'Payment attempt route does not match the payment snapshot',
        undefined,
        'DETERMINISTIC',
      )
    }
    const route = await options.getSettlementRoute(payment.routeId)
    if (route === null)
      throw new CoreExternalRailError('Settlement route is unavailable')
    const economicMappingId = payment.economicMappingId ?? route.economicMappingId
    const [denominationRecord, assetRecord, mappingRecord, payerPublicKey, keyVersion] =
      await Promise.all([
        options.getDenomination(payment.denominationId),
        options.getSettlementAsset(payment.settlementAssetId),
        options.getEconomicMapping(economicMappingId),
        options.getPayerPublicKey(payment.payerAccountId),
        options.getActiveKeyVersion(payment.payerAccountId),
      ])
    if (denominationRecord === null || assetRecord === null || mappingRecord === null) {
      throw new CoreExternalRailError('V2 economic configuration is unavailable')
    }
    if (payerPublicKey === null)
      throw new CoreExternalRailError('Payer account is unavailable')
    if (keyVersion === null || !Number.isInteger(keyVersion) || keyVersion <= 0) {
      throw new CoreExternalRailError('Active custody key version is unavailable')
    }
    if (
      route.rail !== SOLANA_SPL_RAIL ||
      assetRecord.rail !== SOLANA_SPL_RAIL ||
      assetRecord.id !== route.settlementAssetId ||
      assetRecord.assetReference !== settlementMint ||
      mappingRecord.settlementAssetId !== assetRecord.id ||
      mappingRecord.denominationId !== denominationRecord.id
    ) {
      throw new CoreExternalRailError(
        'V2 route configuration does not match the configured Solana settlement asset',
        undefined,
        'DETERMINISTIC',
      )
    }
    if (payment.amountScale !== denominationRecord.maxScale) {
      throw new CoreExternalRailError(
        'V2 payment amount scale does not match its denomination',
        undefined,
        'DETERMINISTIC',
      )
    }
    const denomination = createDenomination({
      id: denominationRecord.id,
      symbol: denominationRecord.symbol,
      maxScale: denominationRecord.maxScale,
      status: asLifecycleStatus(denominationRecord.status),
      version: denominationRecord.version,
    })
    const asset = createSettlementAsset({
      id: assetRecord.id,
      rail: assetRecord.rail,
      network: assetRecord.network,
      assetReference: assetRecord.assetReference,
      decimals: assetRecord.decimals,
      status: asLifecycleStatus(assetRecord.status),
      version: assetRecord.version,
    })
    const mapping = createEconomicMapping({
      id: mappingRecord.id,
      denominationId: mappingRecord.denominationId,
      settlementAssetId: mappingRecord.settlementAssetId,
      numerator: mappingRecord.numerator,
      denominator: mappingRecord.denominator,
      status: asLifecycleStatus(mappingRecord.status),
      version: mappingRecord.version,
    })
    const tokenDecimals = await getTokenDecimals()
    if (tokenDecimals !== asset.decimals) {
      throw new CoreExternalRailError(
        'Configured settlement mint decimals differ from the persisted settlement asset',
        undefined,
        'DETERMINISTIC',
      )
    }
    const tokenAmount = convertToSettlementAtomicUnits(
      exactMoneyFromAtomicUnits(payment.amountAtomic, denomination),
      mapping,
      asset,
    )
    if (tokenAmount <= 0n) {
      throw new CoreExternalRailError(
        'Settlement amount must be positive after exact economic mapping',
        undefined,
        'DETERMINISTIC',
      )
    }
    const destination = parseDestinationSnapshot(payment.destinationSnapshotJson)
    if (
      destination.rail !== route.rail ||
      destination.network !== route.network ||
      destination.assetReference !== asset.assetReference
    ) {
      throw new CoreExternalRailError(
        'Destination snapshot does not match the persisted route',
        undefined,
        'DETERMINISTIC',
      )
    }
    const payerOwner = parseAddress(payerPublicKey, 'payer public key')
    const recipientOwner = parseAddress(
      destination.walletAddress,
      'recipient public key',
    )
    if (payerOwner === recipientOwner) {
      throw new CoreExternalRailError(
        'Recipient destination must differ from the payer account',
        undefined,
        'DETERMINISTIC',
      )
    }
    const feePayerSigner = await getFeePayerSigner()
    if (feePayerSigner.address === payerOwner) {
      throw new CoreExternalRailError(
        'Platform fee payer must be different from the payer account signer',
        undefined,
        'DETERMINISTIC',
      )
    }
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
    const source = await withRpcTimeout((abortSignal) =>
      fetchMaybeToken(options.rpc, payerAta[0], { abortSignal }),
    )
    if (
      !source.exists ||
      source.programAddress !== TOKEN_PROGRAM_ADDRESS ||
      source.data.mint !== settlementMint ||
      source.data.owner !== payerOwner
    ) {
      throw new CoreExternalRailError('Payer token account is unavailable or invalid')
    }
    if (source.data.amount < tokenAmount) {
      throw new CoreExternalRailError(
        'Payer settlement token balance is insufficient',
        undefined,
        'DETERMINISTIC',
      )
    }
    const recipientAccount = await withRpcTimeout((abortSignal) =>
      fetchMaybeToken(options.rpc, recipientAta[0], { abortSignal }),
    )
    if (
      recipientAccount.exists &&
      (recipientAccount.programAddress !== TOKEN_PROGRAM_ADDRESS ||
        recipientAccount.data.mint !== settlementMint ||
        recipientAccount.data.owner !== recipientOwner)
    ) {
      throw new CoreExternalRailError(
        'Recipient token account has unexpected ownership',
      )
    }
    const createsRecipientAta = !recipientAccount.exists
    if (createsRecipientAta && payment.recipientManagedAccountId === null) {
      throw new CoreExternalRailError(
        'Recipient token account must already exist for externally controlled recipients',
        undefined,
        'DETERMINISTIC',
      )
    }
    const latestBlockhash = await withRpcTimeout((abortSignal) =>
      options.rpc
        .getLatestBlockhash({ commitment: CONFIRMATION_COMMITMENT })
        .send({ abortSignal }),
    )
    const memo = createPaymentMemo(
      payment.id,
      payment.externalReference ?? destination.externalReference,
    )
    const preparedPayloadWithoutMessage: Omit<
      SolanaV2PreparedPayload,
      'messageBase64'
    > = {
      version: 1,
      payerOwner,
      recipientOwner,
      payerAta: payerAta[0],
      recipientAta: recipientAta[0],
      settlementMint,
      tokenDecimals,
      tokenAmount: tokenAmount.toString(),
      createsRecipientAta,
      blockhash: latestBlockhash.value.blockhash,
      lastValidBlockHeight: latestBlockhash.value.lastValidBlockHeight.toString(),
      feePayerIdentity: feePayerSigner.address,
      memo,
      ...(payment.externalReference === null
        ? {}
        : { externalReference: payment.externalReference }),
    }
    const unsignedMessage = buildTransferMessage(
      preparedPayloadWithoutMessage,
      createNoopSigner(payerOwner),
      createNoopSigner(feePayerSigner.address),
    )
    const compiled = compileTransaction(unsignedMessage)
    const messageBase64 = Buffer.from(compiled.messageBytes).toString('base64')
    const feeForMessage = await withRpcTimeout((abortSignal) =>
      options.rpc
        .getFeeForMessage(messageBase64 as never, {
          commitment: CONFIRMATION_COMMITMENT,
        })
        .send({ abortSignal }),
    )
    if (feeForMessage.value === null) {
      throw new CoreExternalRailError(
        'Solana network fee could not be determined',
        undefined,
        'DETERMINISTIC',
      )
    }
    const recipientAtaRent = createsRecipientAta
      ? await withRpcTimeout((abortSignal) =>
          options.rpc.getMinimumBalanceForRentExemption(165n).send({ abortSignal }),
        )
      : 0n
    const platformCost = feeForMessage.value + recipientAtaRent
    const feeBalance = await withRpcTimeout((abortSignal) =>
      options.rpc
        .getBalance(feePayerSigner.address, { commitment: CONFIRMATION_COMMITMENT })
        .send({ abortSignal }),
    )
    if (
      feeBalance.value < minimumFeePayerBalanceLamports ||
      feeBalance.value - minimumFeePayerBalanceLamports < platformCost
    ) {
      throw new CoreExternalRailError(
        'Platform fee payer balance cannot cover this transaction while preserving the minimum operating reserve',
        undefined,
        'DETERMINISTIC',
      )
    }
    if (options.reserveSponsorship === undefined) {
      throw new CoreExternalRailError(
        'Platform fee accounting is not configured',
        undefined,
        'DETERMINISTIC',
      )
    }
    await options.reserveSponsorship({
      accountId: payment.payerAccountId,
      paymentId: payment.id,
      lamports: platformCost,
    })
    const preparedPayload: SolanaV2PreparedPayload = {
      ...preparedPayloadWithoutMessage,
      messageBase64,
    }
    const serializedPayload = JSON.stringify(preparedPayload)
    const payloadHash = sha256(Buffer.from(messageBase64, 'base64'))
    const effectHash = sha256(
      JSON.stringify({
        accountId: payment.payerAccountId,
        paymentId: payment.id,
        attemptId: input.attempt.id,
        routeId: route.id,
        network: route.network,
        assetReference: asset.assetReference,
        destination: destination.walletAddress,
        amountAtomic: tokenAmount.toString(),
        feePayerIdentity: feePayerSigner.address,
        keyVersion,
        payloadHash,
      }),
    )
    return {
      accountId: payment.payerAccountId,
      paymentId: payment.id,
      attemptId: input.attempt.id,
      ...(payment.correlationId === null
        ? {}
        : { correlationId: payment.correlationId }),
      effectHash,
      network: route.network,
      assetReference: asset.assetReference,
      destination: destination.walletAddress,
      amountAtomic: tokenAmount,
      feePayerIdentity: feePayerSigner.address,
      keyVersion,
      preparedPayload: serializedPayload,
      routeId: route.id,
      payloadHash,
      ...(platformCostAssetId === undefined
        ? {}
        : {
            platformCostEstimate: {
              assetId: platformCostAssetId,
              amountAtomic: platformCost,
            },
          }),
      validitySlot: latestBlockhash.value.lastValidBlockHeight,
    }
  }

  async function sign(input: SolanaV2SigningRequest): Promise<SolanaV2SignedEffect> {
    if (input.preparedPayload === undefined) {
      throw new CoreExternalRailError(
        'Prepared Solana signing payload is unavailable',
        undefined,
        'DETERMINISTIC',
      )
    }
    const signed = await options.signPaymentEffect(input)
    if (
      signed.effectHash !== input.effectHash ||
      signed.keyVersion !== input.keyVersion
    ) {
      throw new CoreExternalRailError(
        'Custody returned a mismatched Solana signing result',
        undefined,
        'DETERMINISTIC',
      )
    }
    return signed
  }

  async function submit(input: {
    readonly prepared: SolanaV2PreparedEffect
    readonly signed: SolanaV2SignedEffect
  }): Promise<{
    readonly status: 'SUBMITTED' | 'CONFIRMED' | 'FAILED' | 'UNKNOWN'
    readonly externalId?: string
    readonly failureCode?: string
    readonly failureMessageSafe?: string
  }> {
    parsePreparedPayload(input.prepared.preparedPayload)
    const initial = await observeSignature(input.signed.externalId)
    if (initial.status === 'CONFIRMED') {
      const platformCostActual = await readActualPlatformCost(
        input.signed.externalId,
        input.prepared.preparedPayload,
      )
      return {
        status: 'CONFIRMED',
        externalId: input.signed.externalId,
        ...(platformCostActual === undefined ? {} : { platformCostActual }),
      }
    }
    if (initial.status === 'FAILED') {
      return {
        status: 'FAILED',
        externalId: input.signed.externalId,
        ...(initial.failureCode === undefined
          ? {}
          : { failureCode: initial.failureCode }),
        ...(initial.failureMessageSafe === undefined
          ? {}
          : { failureMessageSafe: initial.failureMessageSafe }),
      }
    }
    if (initial.known)
      return { status: 'SUBMITTED', externalId: input.signed.externalId }
    try {
      const sent = await withRpcTimeout((abortSignal) =>
        options.rpc
          .sendTransaction(
            Buffer.from(input.signed.signedPayload).toString(
              'base64',
            ) as Base64EncodedWireTransaction,
            {
              encoding: 'base64',
              preflightCommitment: CONFIRMATION_COMMITMENT,
              maxRetries: 0n,
            },
          )
          .send({ abortSignal }),
      )
      if (sent !== input.signed.externalId) {
        return {
          status: 'UNKNOWN',
          externalId: input.signed.externalId,
        }
      }
      return { status: 'SUBMITTED', externalId: sent }
    } catch (error) {
      const normalized = toExternalRailError(error)
      if (normalized.kind === 'DETERMINISTIC') {
        return {
          status: 'FAILED',
          externalId: input.signed.externalId,
          failureCode: 'EXTERNAL_RAIL_REJECTED',
          failureMessageSafe: normalized.message,
        }
      }
      return { status: 'UNKNOWN', externalId: input.signed.externalId }
    }
  }

  async function reconcile(input: {
    readonly view: SolanaV2PaymentView
    readonly attempt: SolanaV2AttemptSnapshot
  }): Promise<{
    readonly status: 'CONFIRMED' | 'PROVED_NO_EFFECT' | 'UNKNOWN'
    readonly externalId?: string
  }> {
    void input.view
    void input.attempt
    const currentAttempt = input.attempt as SolanaV2AttemptSnapshot & {
      readonly expectedExternalId?: string | null
      readonly validitySlot?: bigint | null
    }
    if (
      currentAttempt.expectedExternalId === undefined ||
      currentAttempt.expectedExternalId === null
    ) {
      return { status: 'UNKNOWN' }
    }
    const observed = await observeSignature(currentAttempt.expectedExternalId)
    if (observed.status === 'CONFIRMED') {
      const platformCostActual = await readActualPlatformCost(
        currentAttempt.expectedExternalId,
        preparedPayloadFromAttempt(currentAttempt),
      )
      return {
        status: 'CONFIRMED',
        externalId: currentAttempt.expectedExternalId,
        ...(platformCostActual === undefined ? {} : { platformCostActual }),
      }
    }
    if (observed.status === 'FAILED') {
      return {
        status: 'PROVED_NO_EFFECT',
        externalId: currentAttempt.expectedExternalId,
      }
    }
    if (
      !observed.known &&
      currentAttempt.validitySlot !== undefined &&
      currentAttempt.validitySlot !== null
    ) {
      const currentBlockHeight = await withRpcTimeout((abortSignal) =>
        options.rpc
          .getBlockHeight({ commitment: CONFIRMATION_COMMITMENT })
          .send({ abortSignal }),
      )
      if (currentBlockHeight > currentAttempt.validitySlot) {
        return {
          status: 'PROVED_NO_EFFECT',
          externalId: currentAttempt.expectedExternalId,
        }
      }
    }
    return { status: 'UNKNOWN', externalId: currentAttempt.expectedExternalId }
  }

  async function checkReadiness(): Promise<void> {
    await getTokenDecimals()
    if (options.feePayerSecret === undefined) return
    const feePayerSigner = await getFeePayerSigner()
    const balance = await withRpcTimeout((abortSignal) =>
      options.rpc
        .getBalance(feePayerSigner.address, { commitment: CONFIRMATION_COMMITMENT })
        .send({ abortSignal }),
    )
    if (balance.value < minimumFeePayerBalanceLamports) {
      throw new CoreExternalRailError(
        'Platform fee payer is below the minimum operating balance',
        undefined,
        'DETERMINISTIC',
      )
    }
  }

  async function observeSignature(
    transactionId: string,
  ): Promise<SolanaV2ObservedSignature> {
    let transactionSignature
    try {
      transactionSignature = signature(transactionId)
    } catch {
      throw new CoreExternalRailError(
        'Solana transaction signature is invalid',
        undefined,
        'DETERMINISTIC',
      )
    }
    const response = await withRpcTimeout((abortSignal) =>
      options.rpc
        .getSignatureStatuses([transactionSignature], {
          searchTransactionHistory: true,
        })
        .send({ abortSignal }),
    )
    const status = response.value[0]
    if (status === null || status === undefined)
      return { known: false, status: 'SUBMITTED' }
    if (status.err !== null) {
      return {
        known: true,
        status: 'FAILED',
        failureCode: 'EXTERNAL_RAIL_FAILURE',
        failureMessageSafe: 'Solana transaction was rejected by the network',
      }
    }
    return {
      known: true,
      status:
        status.confirmationStatus === 'confirmed' ||
        status.confirmationStatus === 'finalized'
          ? 'CONFIRMED'
          : 'SUBMITTED',
    }
  }

  async function readActualPlatformCost(
    transactionId: string,
    preparedPayload: string | undefined,
  ): Promise<SolanaV2PlatformCostObservation | undefined> {
    if (platformCostAssetId === undefined) return undefined
    try {
      const rpc = options.rpc as unknown as {
        getTransaction(
          signature: string,
          config: Readonly<Record<string, unknown>>,
        ): {
          send(options?: { readonly abortSignal?: AbortSignal }): Promise<{
            readonly meta: { readonly fee?: number | bigint | null } | null
          } | null>
        }
      }
      const response = await withRpcTimeout((abortSignal) =>
        rpc
          .getTransaction(transactionId, {
            encoding: 'jsonParsed',
            commitment: CONFIRMATION_COMMITMENT,
            maxSupportedTransactionVersion: 0,
          })
          .send({ abortSignal }),
      )
      const fee = response?.meta?.fee
      if (fee === undefined || fee === null) return undefined
      let recipientAtaRent = 0n
      if (preparedPayload !== undefined) {
        const payload = parsePreparedPayload(preparedPayload)
        if (payload.createsRecipientAta) {
          recipientAtaRent = await withRpcTimeout((abortSignal) =>
            options.rpc.getMinimumBalanceForRentExemption(165n).send({ abortSignal }),
          )
        }
      }
      return {
        assetId: platformCostAssetId,
        amountAtomic: BigInt(fee) + recipientAtaRent,
      }
    } catch {
      return undefined
    }
  }

  return { prepare, sign, submit, reconcile, checkReadiness }
}

function preparedPayloadFromAttempt(
  attempt: SolanaV2AttemptSnapshot,
): string | undefined {
  if (attempt.preparedEffectJson === undefined || attempt.preparedEffectJson === null) {
    return undefined
  }
  try {
    const parsed = JSON.parse(attempt.preparedEffectJson) as unknown
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      'preparedPayload' in parsed &&
      typeof parsed.preparedPayload === 'string'
    ) {
      return parsed.preparedPayload
    }
  } catch {
    return undefined
  }
  return undefined
}

export async function signSolanaV2PreparedEffect(input: {
  readonly request: SolanaV2SigningRequest
  readonly payerSecret: string | Uint8Array
  readonly feePayerSecret: string | Uint8Array
}): Promise<SolanaV2SignedEffect> {
  if (input.request.preparedPayload === undefined) {
    throw new CoreExternalRailError('Prepared Solana signing payload is unavailable')
  }
  const payload = parsePreparedPayload(input.request.preparedPayload)
  const payloadHash = sha256(Buffer.from(payload.messageBase64, 'base64'))
  if (
    input.request.payloadHash !== undefined &&
    input.request.payloadHash !== payloadHash
  ) {
    throw new CoreExternalRailError(
      'Prepared Solana payload hash does not match the signing request',
      undefined,
      'DETERMINISTIC',
    )
  }
  if (
    input.request.feePayerIdentity !== payload.feePayerIdentity ||
    input.request.destination !== payload.recipientOwner ||
    input.request.assetReference !== payload.settlementMint ||
    input.request.amountAtomic !== BigInt(payload.tokenAmount)
  ) {
    throw new CoreExternalRailError(
      'Prepared Solana payload does not match the constrained signing request',
      undefined,
      'DETERMINISTIC',
    )
  }
  const feePayerSigner = await createSigner(input.feePayerSecret, 'fee payer secret')
  const payerSigner = await createSigner(input.payerSecret, 'payer secret')
  if (feePayerSigner.address !== payload.feePayerIdentity) {
    throw new CoreExternalRailError(
      'Fee payer custody public key does not match the prepared effect',
      undefined,
      'DETERMINISTIC',
    )
  }
  if (payerSigner.address !== payload.payerOwner) {
    throw new CoreExternalRailError(
      'Payer custody public key does not match the prepared effect',
      undefined,
      'DETERMINISTIC',
    )
  }
  const message = buildTransferMessage(payload, payerSigner, feePayerSigner)
  const compiled = compileTransaction(message)
  const rebuiltMessageBase64 = Buffer.from(compiled.messageBytes).toString('base64')
  if (rebuiltMessageBase64 !== payload.messageBase64) {
    throw new CoreExternalRailError(
      'Prepared Solana message changed before signing',
      undefined,
      'DETERMINISTIC',
    )
  }
  const signedTransaction = await signTransactionMessageWithSigners(message)
  const wireTransaction = getBase64EncodedWireTransaction(signedTransaction)
  const externalId = getSignatureFromTransaction(signedTransaction)
  return {
    effectHash: input.request.effectHash,
    keyVersion: input.request.keyVersion,
    signedPayload: Uint8Array.from(Buffer.from(wireTransaction, 'base64')),
    externalId,
  }
}

function buildTransferMessage(
  payload: Omit<SolanaV2PreparedPayload, 'messageBase64'> | SolanaV2PreparedPayload,
  payerSigner: KeyPairSigner | ReturnType<typeof createNoopSigner>,
  feePayerSigner: KeyPairSigner | ReturnType<typeof createNoopSigner>,
) {
  const recipientOwner = parseAddress(payload.recipientOwner, 'recipient public key')
  const payerAta = parseAddress(payload.payerAta, 'payer token account')
  const recipientAta = parseAddress(payload.recipientAta, 'recipient token account')
  const mint = parseAddress(payload.settlementMint, 'settlement mint')
  const instructions: Instruction[] = []
  if (payload.createsRecipientAta) {
    instructions.push(
      getCreateAssociatedTokenIdempotentInstruction({
        payer: feePayerSigner,
        ata: recipientAta,
        owner: recipientOwner,
        mint,
      }),
    )
  }
  instructions.push(
    getTransferCheckedInstruction({
      source: payerAta,
      mint,
      destination: recipientAta,
      authority: payerSigner,
      amount: BigInt(payload.tokenAmount),
      decimals: payload.tokenDecimals,
    }),
    getAddMemoInstruction({ memo: payload.memo }),
  )
  return pipe(
    createTransactionMessage({ version: 0 }),
    (message) => setTransactionMessageFeePayerSigner(feePayerSigner, message),
    (message) =>
      setTransactionMessageLifetimeUsingBlockhash(
        {
          blockhash: payload.blockhash as never,
          lastValidBlockHeight: BigInt(payload.lastValidBlockHeight),
        },
        message,
      ),
    (message) => appendTransactionMessageInstructions(instructions, message),
  )
}

function parsePreparedPayload(serialized: string): SolanaV2PreparedPayload {
  let parsed: unknown
  try {
    parsed = JSON.parse(serialized) as unknown
  } catch {
    throw new CoreExternalRailError(
      'Prepared Solana payload is invalid JSON',
      undefined,
      'DETERMINISTIC',
    )
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as { version?: unknown }).version !== 1
  ) {
    throw new CoreExternalRailError(
      'Prepared Solana payload is invalid',
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
    'blockhash',
    'lastValidBlockHeight',
    'feePayerIdentity',
    'memo',
    'messageBase64',
  ] as const
  for (const field of requiredStrings) {
    if (typeof value[field] !== 'string' || value[field].length === 0) {
      throw new CoreExternalRailError(
        'Prepared Solana payload is incomplete',
        undefined,
        'DETERMINISTIC',
      )
    }
  }
  if (
    typeof value.tokenDecimals !== 'number' ||
    !Number.isInteger(value.tokenDecimals) ||
    value.tokenDecimals < 0 ||
    value.tokenDecimals > 255 ||
    typeof value.createsRecipientAta !== 'boolean' ||
    !/^\d+$/u.test(value.tokenAmount as string) ||
    !/^\d+$/u.test(value.lastValidBlockHeight as string) ||
    Buffer.from(value.messageBase64 as string, 'base64').length === 0
  ) {
    throw new CoreExternalRailError(
      'Prepared Solana payload contains invalid numeric fields',
      undefined,
      'DETERMINISTIC',
    )
  }
  return {
    version: 1,
    payerOwner: value.payerOwner as string,
    recipientOwner: value.recipientOwner as string,
    payerAta: value.payerAta as string,
    recipientAta: value.recipientAta as string,
    settlementMint: value.settlementMint as string,
    tokenDecimals: value.tokenDecimals,
    tokenAmount: value.tokenAmount as string,
    createsRecipientAta: value.createsRecipientAta,
    blockhash: value.blockhash as string,
    lastValidBlockHeight: value.lastValidBlockHeight as string,
    feePayerIdentity: value.feePayerIdentity as string,
    memo: value.memo as string,
    messageBase64: value.messageBase64 as string,
    ...(typeof value.externalReference === 'string'
      ? { externalReference: value.externalReference }
      : {}),
  }
}

function parseDestinationSnapshot(serialized: string | null): {
  readonly rail: string
  readonly network: string
  readonly assetReference: string
  readonly walletAddress: string
  readonly externalReference?: string
} {
  if (serialized === null) {
    throw new CoreExternalRailError(
      'V2 payment has no destination snapshot',
      undefined,
      'DETERMINISTIC',
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(serialized) as unknown
  } catch {
    throw new CoreExternalRailError(
      'V2 destination snapshot is invalid JSON',
      undefined,
      'DETERMINISTIC',
    )
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new CoreExternalRailError(
      'V2 destination snapshot is invalid',
      undefined,
      'DETERMINISTIC',
    )
  }
  const value = parsed as Record<string, unknown>
  const fields = ['rail', 'network', 'asset_reference', 'wallet_address'] as const
  for (const field of fields) {
    if (typeof value[field] !== 'string' || value[field].length === 0) {
      throw new CoreExternalRailError(
        'V2 destination snapshot is incomplete',
        undefined,
        'DETERMINISTIC',
      )
    }
  }
  if (
    value.external_reference !== undefined &&
    typeof value.external_reference !== 'string'
  ) {
    throw new CoreExternalRailError(
      'V2 destination external reference is invalid',
      undefined,
      'DETERMINISTIC',
    )
  }
  return {
    rail: value.rail as string,
    network: value.network as string,
    assetReference: value.asset_reference as string,
    walletAddress: value.wallet_address as string,
    ...(value.external_reference === undefined
      ? {}
      : { externalReference: value.external_reference }),
  }
}

function createPaymentMemo(
  paymentId: string,
  externalReference: string | undefined,
): string {
  if (
    externalReference !== undefined &&
    new TextEncoder().encode(externalReference).byteLength > MAX_REFERENCE_BYTES
  ) {
    throw new CoreExternalRailError(
      `External reference must contain at most ${MAX_REFERENCE_BYTES} UTF-8 bytes`,
      undefined,
      'DETERMINISTIC',
    )
  }
  return externalReference === undefined
    ? paymentId
    : `${paymentId}|reference:${externalReference}`
}

function parseAddress(value: string, fieldName: string): Address {
  try {
    return address(value)
  } catch {
    throw new SolanaRailConfigurationError(`Invalid Solana ${fieldName}`)
  }
}

function parseSecretKey(value: string | Uint8Array, fieldName: string): Uint8Array {
  if (value instanceof Uint8Array) {
    if (value.length !== SOLANA_SECRET_KEY_BYTES) {
      throw new SolanaRailConfigurationError(
        `${fieldName} must contain a 64-byte Solana secret key`,
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
      // The stable validation error below intentionally omits the secret value.
    }
  }
  const decoded = Buffer.from(trimmed, 'base64')
  if (
    decoded.length === SOLANA_SECRET_KEY_BYTES &&
    decoded.toString('base64') === trimmed
  ) {
    return new Uint8Array(decoded)
  }
  throw new SolanaRailConfigurationError(
    `${fieldName} must be a 64-byte JSON array, hex or base64 secret key`,
  )
}

async function createSigner(
  secret: string | Uint8Array,
  fieldName: string,
): Promise<KeyPairSigner> {
  const secretBytes = parseSecretKey(secret, fieldName)
  try {
    return await createKeyPairSignerFromBytes(secretBytes, false)
  } finally {
    secretBytes.fill(0)
  }
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex')
}

function asLifecycleStatus(value: string): LifecycleStatus {
  if (value === 'ACTIVE' || value === 'RETIRED') return value
  throw new CoreExternalRailError(
    'Persisted financial configuration has an invalid lifecycle status',
  )
}

function toExternalRailError(error: unknown): CoreExternalRailError {
  if (error instanceof CoreExternalRailError) return error
  if (
    isSolanaError(
      error,
      SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
    )
  ) {
    return new CoreExternalRailError(
      'Solana transaction was rejected during preflight',
      undefined,
      'DETERMINISTIC',
    )
  }
  return new CoreExternalRailError(
    'Solana settlement rail is unavailable',
    error,
    'RETRYABLE',
  )
}
