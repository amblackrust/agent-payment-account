import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
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
  type ClusterUrl,
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
  ExternalRailError,
  formatMoney,
  InsufficientFundsError,
  ValidationError,
  type Money,
  type PaymentRail,
  type RailPreparedPayment,
  type RailExecutionResult,
  type RailRecoveryResult,
  type RailStatusResult,
} from '@agent-payment/core'
import type { SolanaRpc } from './read.js'
import { DEFAULT_RPC_TIMEOUT_MS, SolanaRailConfigurationError } from './read.js'

export const SOLANA_SPL_RAIL = 'SOLANA_SPL'
const CONFIRMATION_COMMITMENT = 'confirmed' as const
const DEFAULT_CONFIRMATION_TIMEOUT_MS = 15_000
const DEFAULT_POLL_INTERVAL_MS = 250
const SOLANA_SECRET_KEY_BYTES = 64

function createPaymentMemo(
  paymentId: string,
  externalReference: string | undefined,
): string {
  return externalReference === undefined
    ? paymentId
    : `${paymentId}|reference:${externalReference}`
}

type SolanaCluster = 'localnet' | 'devnet' | 'testnet' | 'mainnet-beta'

export interface SolanaPaymentRailOptions {
  readonly rpcUrl: string
  readonly expectedCluster: SolanaCluster
  readonly allowMainnet: boolean
  readonly settlementMint: string
  readonly feePayerSecret: string
  readonly rpcTimeoutMs?: number | undefined
  readonly confirmationTimeoutMs?: number | undefined
  readonly pollIntervalMs?: number | undefined
  readonly now?: (() => number) | undefined
  readonly sleep?: ((milliseconds: number) => Promise<void>) | undefined
}

export interface SolanaPaymentRailWithRpcOptions extends Omit<
  SolanaPaymentRailOptions,
  'rpcUrl' | 'feePayerSecret'
> {
  readonly rpc: SolanaRpc
  readonly feePayerSecret: string | Uint8Array
}

interface SettlementMetadata {
  readonly decimals: number
}

interface SignatureObservation {
  readonly known: boolean
  readonly result: RailExecutionResult
}

interface SolanaRecoveryMetadata {
  readonly version: 1
  readonly blockhash: string
  readonly lastValidBlockHeight: string
  readonly payerOwner: string
  readonly recipientOwner: string
  readonly payerAta: string
  readonly recipientAta: string
  readonly settlementMint: string
  readonly tokenDecimals: number
  readonly tokenAmount: string
  readonly createsRecipientAta: boolean
  readonly externalReference?: string
}

class SolanaBlockhashExpiredError extends ExternalRailError {
  public constructor() {
    super(
      'Solana transaction blockhash expired before confirmation',
      undefined,
      'DETERMINISTIC',
    )
    this.name = 'SolanaBlockhashExpiredError'
  }
}

function parseAddress(value: string, fieldName: string): Address {
  try {
    return address(value)
  } catch {
    throw new SolanaRailConfigurationError(`Invalid Solana ${fieldName}`)
  }
}

function validatePositiveInteger(value: number, fieldName: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new SolanaRailConfigurationError(`${fieldName} must be a positive integer`)
  }
  return value
}

function validateNonNegativeInteger(value: number, fieldName: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new SolanaRailConfigurationError(
      `${fieldName} must be a non-negative integer`,
    )
  }
  return value
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
  if (/^[0-9a-fA-F]{128}$/.test(trimmed)) {
    return Uint8Array.from(trimmed.match(/.{2}/g) ?? [], (byte) =>
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
      // The common configuration error below avoids exposing the secret value.
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

function usdMoneyToTokenAtomicUnits(money: Money, tokenDecimals: number): bigint {
  if (money.currency !== 'USD') {
    throw new ExternalRailError('Only USD settlement is supported')
  }
  if (tokenDecimals >= 2) {
    return money.atomicUnits * 10n ** BigInt(tokenDecimals - 2)
  }

  const divisor = 10n ** BigInt(2 - tokenDecimals)
  if (money.atomicUnits % divisor !== 0n) {
    throw new ExternalRailError(
      'Payment amount cannot be represented by settlement token decimals',
    )
  }
  return money.atomicUnits / divisor
}

function serializeConfirmationMetadata(slot: bigint | undefined): string | undefined {
  return slot === undefined ? undefined : JSON.stringify({ slot: slot.toString() })
}

function parseRecoveryMetadata(value: string): SolanaRecoveryMetadata {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch (error) {
    throw new ExternalRailError(
      'Solana recovery metadata is invalid',
      error,
      'DETERMINISTIC',
    )
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as { version?: unknown }).version !== 1
  ) {
    throw new ExternalRailError(
      'Solana recovery metadata is invalid',
      undefined,
      'DETERMINISTIC',
    )
  }
  return parsed as SolanaRecoveryMetadata
}

function identifyCluster(genesisHash: string): SolanaCluster | undefined {
  const knownGenesisHashes: Readonly<
    Record<Exclude<SolanaCluster, 'localnet'>, string>
  > = {
    'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
    devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
    testnet: '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY',
  }
  for (const [cluster, knownGenesisHash] of Object.entries(knownGenesisHashes)) {
    if (genesisHash === knownGenesisHash) {
      return cluster as SolanaCluster
    }
  }
  return undefined
}

function assertExpectedCluster(
  expectedCluster: SolanaCluster,
  allowMainnet: boolean,
  genesisHash: string,
): void {
  const actualCluster = identifyCluster(genesisHash)
  if (actualCluster === 'mainnet-beta' && !allowMainnet) {
    throw new SolanaRailConfigurationError(
      'Mainnet RPC detected but ALLOW_MAINNET is not enabled',
    )
  }
  if (actualCluster !== undefined && actualCluster !== expectedCluster) {
    throw new SolanaRailConfigurationError(
      `Solana RPC cluster mismatch: expected ${expectedCluster}, detected ${actualCluster}`,
    )
  }
  if (expectedCluster !== 'localnet' && actualCluster !== expectedCluster) {
    throw new SolanaRailConfigurationError(
      `Solana RPC cluster mismatch: expected ${expectedCluster}`,
    )
  }
  if (expectedCluster === 'mainnet-beta' && !allowMainnet) {
    throw new SolanaRailConfigurationError(
      'Mainnet requires ALLOW_MAINNET=true as an explicit safety flag',
    )
  }
}

function toExternalRailError(error: unknown): ExternalRailError {
  if (error instanceof ExternalRailError) {
    return error
  }
  if (
    isSolanaError(
      error,
      SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
    )
  ) {
    return new ExternalRailError(
      'Solana transaction was rejected during preflight',
      undefined,
      'DETERMINISTIC',
    )
  }
  return new ExternalRailError(
    'Solana settlement rail is unavailable',
    error,
    'RETRYABLE',
  )
}

export function createSolanaPaymentRail(
  options: SolanaPaymentRailOptions,
): PaymentRail {
  return createSolanaPaymentRailWithRpc({
    ...options,
    rpc: createSolanaRpc(options.rpcUrl as ClusterUrl),
  })
}

export function createSolanaPaymentRailWithRpc(
  options: SolanaPaymentRailWithRpcOptions,
): PaymentRail {
  if (options.expectedCluster === 'mainnet-beta' && !options.allowMainnet) {
    throw new SolanaRailConfigurationError(
      'Mainnet requires ALLOW_MAINNET=true as an explicit safety flag',
    )
  }
  const settlementMint = parseAddress(options.settlementMint, 'settlement mint')
  const rpcTimeoutMs = validatePositiveInteger(
    options.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS,
    'Solana RPC timeout',
  )
  const confirmationTimeoutMs = validatePositiveInteger(
    options.confirmationTimeoutMs ?? DEFAULT_CONFIRMATION_TIMEOUT_MS,
    'Solana confirmation timeout',
  )
  const pollIntervalMs = validateNonNegativeInteger(
    options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    'Solana confirmation poll interval',
  )
  const now = options.now ?? Date.now
  const sleep =
    options.sleep ??
    ((milliseconds) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
  let metadataPromise: Promise<SettlementMetadata> | undefined

  async function withRpcTimeout<T>(
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController()
    let timedOut = false
    let timeout: NodeJS.Timeout | undefined
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        timedOut = true
        controller.abort()
        reject(
          new ExternalRailError('Solana RPC request timed out', undefined, 'RETRYABLE'),
        )
      }, rpcTimeoutMs)
    })
    try {
      return await Promise.race([operation(controller.signal), timeoutPromise])
    } catch (error) {
      if (timedOut || controller.signal.aborted) {
        throw new ExternalRailError(
          'Solana RPC request timed out',
          undefined,
          'RETRYABLE',
        )
      }
      throw toExternalRailError(error)
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout)
      }
    }
  }

  async function validateSettlementMetadata(): Promise<SettlementMetadata> {
    const genesisHash = await withRpcTimeout((abortSignal) =>
      options.rpc.getGenesisHash().send({ abortSignal }),
    )
    assertExpectedCluster(options.expectedCluster, options.allowMainnet, genesisHash)

    const mintAccount = await withRpcTimeout((abortSignal) =>
      fetchMaybeMint(options.rpc, settlementMint, { abortSignal }),
    )
    if (!mintAccount.exists) {
      throw new ExternalRailError('Configured settlement mint is unavailable')
    }
    if (mintAccount.programAddress !== TOKEN_PROGRAM_ADDRESS) {
      throw new ExternalRailError(
        'Configured settlement mint uses an unsupported token program',
      )
    }
    if (!mintAccount.data.isInitialized) {
      throw new ExternalRailError('Configured settlement mint is not initialized')
    }
    if (
      !Number.isInteger(mintAccount.data.decimals) ||
      mintAccount.data.decimals < 0 ||
      mintAccount.data.decimals > 255
    ) {
      throw new ExternalRailError('Configured settlement mint has invalid decimals')
    }
    return { decimals: mintAccount.data.decimals }
  }

  async function getSettlementMetadata(): Promise<SettlementMetadata> {
    if (metadataPromise === undefined) {
      metadataPromise = validateSettlementMetadata().catch((error: unknown) => {
        metadataPromise = undefined
        throw error
      })
    }
    return metadataPromise
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

  async function fetchTokenAccount(tokenAccount: Address, description: string) {
    const result = await withRpcTimeout((abortSignal) =>
      fetchMaybeToken(options.rpc, tokenAccount, { abortSignal }),
    )
    if (!result.exists) {
      throw new ExternalRailError(`${description} token account is missing`)
    }
    if (
      result.programAddress !== TOKEN_PROGRAM_ADDRESS ||
      result.data.mint !== settlementMint
    ) {
      throw new ExternalRailError(`${description} token account has an invalid mint`)
    }
    return result.data
  }

  async function observeSignature(
    transactionId: string,
  ): Promise<SignatureObservation> {
    const transactionSignature = signature(transactionId)
    const response = await withRpcTimeout((abortSignal) =>
      options.rpc
        .getSignatureStatuses([transactionSignature], {
          searchTransactionHistory: true,
        })
        .send({ abortSignal }),
    )
    const status = response.value[0]
    if (status === null || status === undefined) {
      return {
        known: false,
        result: { status: 'RECONCILING', railTransactionId: transactionId },
      }
    }
    if (status.err !== null) {
      return {
        known: true,
        result: {
          status: 'FAILED',
          railTransactionId: transactionId,
          failureCode: 'EXTERNAL_RAIL_FAILURE',
          failureMessageSafe: 'Solana transaction was rejected by the network',
        },
      }
    }
    if (
      status.confirmationStatus === 'confirmed' ||
      status.confirmationStatus === 'finalized'
    ) {
      const confirmationMetadata = serializeConfirmationMetadata(status.slot)
      return {
        known: true,
        result: {
          status: 'CONFIRMED',
          railTransactionId: transactionId,
          ...(confirmationMetadata === undefined ? {} : { confirmationMetadata }),
        },
      }
    }
    return {
      known: true,
      result: { status: 'SUBMITTED', railTransactionId: transactionId },
    }
  }

  async function waitForConfirmation(
    transactionId: string,
    lastValidBlockHeight: bigint,
  ): Promise<RailExecutionResult> {
    const deadline = now() + confirmationTimeoutMs
    while (now() <= deadline) {
      const observation = await observeSignature(transactionId)
      if (
        observation.result.status === 'CONFIRMED' ||
        observation.result.status === 'FAILED'
      ) {
        return observation.result
      }
      const currentBlockHeight = await withRpcTimeout((abortSignal) =>
        options.rpc
          .getBlockHeight({ commitment: CONFIRMATION_COMMITMENT })
          .send({ abortSignal }),
      )
      if (currentBlockHeight > lastValidBlockHeight) {
        throw new SolanaBlockhashExpiredError()
      }
      if (pollIntervalMs > 0) {
        await sleep(pollIntervalMs)
      }
    }
    throw new ExternalRailError(
      'Solana transaction confirmation timed out',
      undefined,
      'AMBIGUOUS',
    )
  }

  async function executePrepared(
    prepared: RailPreparedPayment,
  ): Promise<RailExecutionResult> {
    const durableExecution = prepared.durableExecution
    if (durableExecution === undefined) {
      throw new ExternalRailError(
        'Prepared Solana transaction is unavailable',
        undefined,
        'DETERMINISTIC',
      )
    }
    const initialObservation = await observeSignature(
      durableExecution.expectedExternalId,
    )
    if (
      initialObservation.result.status === 'CONFIRMED' ||
      initialObservation.result.status === 'FAILED'
    ) {
      return initialObservation.result
    }
    if (initialObservation.known) {
      return waitForConfirmation(
        durableExecution.expectedExternalId,
        BigInt(
          parseRecoveryMetadata(durableExecution.recoveryMetadata).lastValidBlockHeight,
        ),
      )
    }

    let sentSignature: string
    try {
      sentSignature = await withRpcTimeout((abortSignal) =>
        options.rpc
          .sendTransaction(
            durableExecution.serializedPayload as Base64EncodedWireTransaction,
            {
              encoding: 'base64',
              preflightCommitment: CONFIRMATION_COMMITMENT,
              maxRetries: 0n,
            },
          )
          .send({ abortSignal }),
      )
    } catch (error) {
      if (error instanceof ExternalRailError && error.kind === 'DETERMINISTIC') {
        throw error
      }
      throw new ExternalRailError(
        'Solana transaction outcome is ambiguous',
        error,
        'AMBIGUOUS',
      )
    }
    if (sentSignature !== durableExecution.expectedExternalId) {
      throw new ExternalRailError(
        'Solana RPC returned an unexpected transaction signature',
        undefined,
        'AMBIGUOUS',
      )
    }
    try {
      return await waitForConfirmation(
        durableExecution.expectedExternalId,
        BigInt(
          parseRecoveryMetadata(durableExecution.recoveryMetadata).lastValidBlockHeight,
        ),
      )
    } catch (error) {
      throw new ExternalRailError(
        'Solana transaction outcome is ambiguous',
        error,
        'AMBIGUOUS',
      )
    }
  }

  return {
    name: SOLANA_SPL_RAIL,
    canRoute: (request) =>
      request.currency === 'USD' && request.destination.rail === SOLANA_SPL_RAIL,
    validateDestination: (request) => {
      if (request.destination.rail !== SOLANA_SPL_RAIL) {
        return
      }
      try {
        parseAddress(request.destination.reference, 'recipient public key')
      } catch {
        throw new ValidationError('Recipient Solana wallet address is invalid')
      }
    },
    quote: async (request) => ({ rail: SOLANA_SPL_RAIL, amount: request.amount }),
    prepare: async (request, context) => {
      if (context === undefined) {
        throw new ExternalRailError('Payer custody context is required')
      }
      const metadata = await getSettlementMetadata()
      const payerOwner = parseAddress(context.payerPublicKey, 'payer public key')
      const recipientOwner = parseAddress(
        request.destination.reference,
        'recipient public key',
      )
      const payerSecret = await context.getPayerSecretKey()
      try {
        const payerSigner = await createSigner(payerSecret, 'payer secret')
        const feePayerSigner = await createSigner(
          options.feePayerSecret,
          'fee payer secret',
        )
        if (payerSigner.address !== payerOwner) {
          throw new ExternalRailError('Payer custody public key does not match account')
        }
        if (feePayerSigner.address === payerSigner.address) {
          throw new ExternalRailError(
            'Platform fee payer must be different from the payer account signer',
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
        const sourceData = await fetchTokenAccount(payerAta[0], 'Payer')
        if (sourceData.owner !== payerOwner) {
          throw new ExternalRailError(
            'Payer token account owner does not match account',
          )
        }
        const tokenAmount = usdMoneyToTokenAtomicUnits(
          request.amount,
          metadata.decimals,
        )
        if (sourceData.amount < tokenAmount) {
          throw new InsufficientFundsError(
            'Payer settlement token balance is insufficient',
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
          throw new ExternalRailError(
            'Recipient token account has unexpected ownership',
          )
        }

        const instructions: Instruction[] = []
        if (!recipientAccount.exists) {
          instructions.push(
            getCreateAssociatedTokenIdempotentInstruction({
              payer: feePayerSigner,
              ata: recipientAta[0],
              owner: recipientOwner,
              mint: settlementMint,
            }),
          )
        }
        instructions.push(
          getTransferCheckedInstruction({
            source: payerAta[0],
            mint: settlementMint,
            destination: recipientAta[0],
            authority: payerSigner,
            amount: tokenAmount,
            decimals: metadata.decimals,
          }),
          getAddMemoInstruction({
            memo: createPaymentMemo(context.paymentId, request.externalReference),
          }),
        )

        const latestBlockhash = await withRpcTimeout((abortSignal) =>
          options.rpc
            .getLatestBlockhash({ commitment: CONFIRMATION_COMMITMENT })
            .send({ abortSignal }),
        )
        const transactionMessage = pipe(
          createTransactionMessage({ version: 0 }),
          (message) => setTransactionMessageFeePayerSigner(feePayerSigner, message),
          (message) =>
            setTransactionMessageLifetimeUsingBlockhash(latestBlockhash.value, message),
          (message) => appendTransactionMessageInstructions(instructions, message),
        )
        const compiledTransaction = compileTransaction(transactionMessage)
        const messageBase64 = Buffer.from(compiledTransaction.messageBytes).toString(
          'base64',
        )
        const feeForMessage = await withRpcTimeout((abortSignal) =>
          options.rpc
            .getFeeForMessage(messageBase64 as never, {
              commitment: CONFIRMATION_COMMITMENT,
            })
            .send({ abortSignal }),
        )
        if (feeForMessage.value === null) {
          throw new ExternalRailError(
            'Solana network fee could not be determined',
            undefined,
            'DETERMINISTIC',
          )
        }
        const recipientAtaRent = recipientAccount.exists
          ? 0n
          : await withRpcTimeout((abortSignal) =>
              options.rpc.getMinimumBalanceForRentExemption(165n).send({ abortSignal }),
            )
        const requiredFeePayerBalance = feeForMessage.value + recipientAtaRent
        const feeBalance = await withRpcTimeout((abortSignal) =>
          options.rpc
            .getBalance(feePayerSigner.address, { commitment: CONFIRMATION_COMMITMENT })
            .send({ abortSignal }),
        )
        if (feeBalance.value < requiredFeePayerBalance) {
          throw new ExternalRailError(
            'Platform fee payer balance is insufficient for this transaction',
            undefined,
            'DETERMINISTIC',
          )
        }
        const signedTransaction =
          await signTransactionMessageWithSigners(transactionMessage)
        const serializedTransactionBase64 =
          getBase64EncodedWireTransaction(signedTransaction)
        const expectedTransactionId = getSignatureFromTransaction(signedTransaction)

        const recoveryMetadata: SolanaRecoveryMetadata = {
          version: 1,
          blockhash: latestBlockhash.value.blockhash,
          lastValidBlockHeight: latestBlockhash.value.lastValidBlockHeight.toString(),
          payerOwner,
          recipientOwner,
          payerAta: payerAta[0],
          recipientAta: recipientAta[0],
          settlementMint,
          tokenDecimals: metadata.decimals,
          tokenAmount: tokenAmount.toString(),
          createsRecipientAta: !recipientAccount.exists,
          ...(request.externalReference === undefined
            ? {}
            : { externalReference: request.externalReference }),
        }
        return {
          rail: SOLANA_SPL_RAIL,
          payloadSafe: JSON.stringify({
            payer_ata: payerAta[0],
            recipient_ata: recipientAta[0],
            settlement_mint: settlementMint,
            token_decimals: metadata.decimals,
            token_amount: tokenAmount.toString(),
            creates_recipient_ata: !recipientAccount.exists,
          }),
          durableExecution: {
            serializedPayload: serializedTransactionBase64,
            expectedExternalId: expectedTransactionId,
            recoveryMetadata: JSON.stringify(recoveryMetadata),
          },
        }
      } catch (error) {
        if (error instanceof InsufficientFundsError) {
          throw error
        }
        throw toExternalRailError(error)
      } finally {
        payerSecret.fill(0)
      }
    },
    execute: executePrepared,
    recover: async (prepared): Promise<RailRecoveryResult> => {
      const durableExecution = prepared.durableExecution
      if (durableExecution === undefined) {
        throw new ExternalRailError(
          'Prepared Solana transaction is unavailable',
          undefined,
          'DETERMINISTIC',
        )
      }
      const metadata = parseRecoveryMetadata(durableExecution.recoveryMetadata)
      const observation = await observeSignature(durableExecution.expectedExternalId)
      if (
        observation.result.status === 'CONFIRMED' ||
        observation.result.status === 'FAILED'
      ) {
        return observation.result
      }
      if (observation.known) {
        try {
          return await waitForConfirmation(
            durableExecution.expectedExternalId,
            BigInt(metadata.lastValidBlockHeight),
          )
        } catch (error) {
          if (!(error instanceof SolanaBlockhashExpiredError)) {
            throw error
          }
        }
      }
      const currentBlockHeight = await withRpcTimeout((abortSignal) =>
        options.rpc
          .getBlockHeight({ commitment: CONFIRMATION_COMMITMENT })
          .send({ abortSignal }),
      )
      const finalObservation = await observeSignature(
        durableExecution.expectedExternalId,
      )
      if (
        finalObservation.result.status === 'CONFIRMED' ||
        finalObservation.result.status === 'FAILED'
      ) {
        return finalObservation.result
      }
      if (currentBlockHeight <= BigInt(metadata.lastValidBlockHeight)) {
        return executePrepared(prepared)
      }
      return {
        status: 'RECONCILING',
        railTransactionId: durableExecution.expectedExternalId,
      }
    },
    getStatus: async (transactionId): Promise<RailStatusResult> => {
      const observation = await observeSignature(transactionId)
      return observation.result
    },
  }
}

/**
 * Preparation-only route retained for Task 03 isolation tests. Production
 * uses createSolanaPaymentRail, which supplies the durable signing boundary.
 */
export function createSolanaPaymentPreparationRail(): PaymentRail {
  return {
    name: SOLANA_SPL_RAIL,
    canRoute: (request) =>
      request.currency === 'USD' && request.destination.rail === SOLANA_SPL_RAIL,
    quote: async (request) => ({ rail: SOLANA_SPL_RAIL, amount: request.amount }),
    prepare: async (request) => ({
      rail: SOLANA_SPL_RAIL,
      payloadSafe: JSON.stringify({
        operation: request.operation,
        recipient_id: request.recipientId,
        amount: formatMoney(request.amount),
        currency: request.currency,
        destination_reference: request.destination.reference,
      }),
    }),
  }
}
