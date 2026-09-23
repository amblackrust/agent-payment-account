import { decodePaymentSignatureHeader } from '@x402/core/http'
import {
  parsePaymentPayload,
  type PaymentPayload,
  type PaymentRequirements,
} from '@x402/core/schemas'
import {
  address,
  getSignatureFromTransaction,
  getTransactionDecoder,
  signature,
} from '@solana/kit'
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token'
import type { FakeX402Config } from './config.js'
import type {
  FakeX402ParsedInstruction,
  FakeX402Rpc,
  FakeX402RpcTransaction,
  FakeX402TokenBalance,
} from './rpc.js'

const PAYMENT_TRANSACTION_FIELD = 'transaction'
const CONFIRMED_STATUSES = new Set(['confirmed', 'finalized'])
const CONFIRMATION_POLL_INTERVAL_MS = 250
const CONFIRMATION_TIMEOUT_MS = 30_000
type V2PaymentPayload = Extract<PaymentPayload, { readonly x402Version: 2 }>

export type FakeX402VerificationCode =
  | 'PAYMENT_HEADER_INVALID'
  | 'PAYMENT_PAYLOAD_INVALID'
  | 'PAYMENT_REQUIREMENT_MISMATCH'
  | 'TRANSACTION_INVALID'
  | 'FACILITATOR_SIGNATURE_REQUIRED'
  | 'TRANSACTION_NOT_FOUND'
  | 'TRANSACTION_FAILED'
  | 'TRANSACTION_NOT_CONFIRMED'
  | 'TRANSFER_MISMATCH'
  | 'DUPLICATE_PAYMENT'
  | 'RPC_UNAVAILABLE'

export class FakeX402VerificationError extends Error {
  public constructor(
    public readonly code: FakeX402VerificationCode,
    message: string,
  ) {
    super(message)
    this.name = 'FakeX402VerificationError'
  }
}

export interface FakeX402PaymentSubmission {
  readonly transaction: unknown
  readonly transactionBytes: Uint8Array
  readonly paymentPayload: PaymentPayload
}

export type FakeX402PaymentSubmitter = (
  input: FakeX402PaymentSubmission,
) => Promise<string>

export interface VerifiedFakeX402Payment {
  readonly transactionSignature: string
  readonly payer: string
  readonly accepted: PaymentRequirements
}

export interface FakeX402PaymentVerifier {
  verify(paymentSignatureHeader: string): Promise<VerifiedFakeX402Payment>
}

export function createFakeX402PaymentVerifier(input: {
  readonly config: FakeX402Config
  readonly rpc: FakeX402Rpc
  readonly submitter?: FakeX402PaymentSubmitter
}): FakeX402PaymentVerifier {
  const acceptedTransactions = new Map<string, VerifiedFakeX402Payment>()
  const inFlightTransactions = new Set<string>()

  return {
    verify: async (paymentSignatureHeader) => {
      const paymentPayload = decodePaymentPayload(paymentSignatureHeader)
      assertPaymentPayloadMatchesConfig(paymentPayload, input.config)
      const transactionValue = paymentPayload.payload[PAYMENT_TRANSACTION_FIELD]
      if (typeof transactionValue !== 'string') {
        throw new FakeX402VerificationError(
          'TRANSACTION_INVALID',
          'Payment payload does not contain a Solana transaction',
        )
      }

      const transactionBytes = decodeBase64Transaction(transactionValue)
      const transaction = decodeSolanaTransaction(transactionBytes)
      let transactionSignature = readTransactionSignature(
        transaction,
        input.config.facilitatorFeePayer,
      )
      if (transactionSignature === undefined) {
        if (input.submitter === undefined) {
          throw new FakeX402VerificationError(
            'FACILITATOR_SIGNATURE_REQUIRED',
            'Payment transaction still needs the facilitator fee-payer signature',
          )
        }
        transactionSignature = await submitPartialTransaction(
          input.submitter,
          transaction,
          transactionBytes,
          paymentPayload,
        )
      } else {
        const existing = acceptedTransactions.get(transactionSignature)
        if (existing !== undefined) return existing
        const status = await readSignatureStatus(input.rpc, transactionSignature)
        if (status === null) {
          if (input.submitter === undefined) {
            throw new FakeX402VerificationError(
              'TRANSACTION_NOT_FOUND',
              'The fully signed Solana transaction has not been submitted',
            )
          }
          const submittedSignature = await submitTransaction(
            input.submitter,
            transaction,
            transactionBytes,
            paymentPayload,
          )
          if (submittedSignature !== transactionSignature) {
            throw new FakeX402VerificationError(
              'TRANSACTION_INVALID',
              'The submitted Solana transaction signature does not match its payload',
            )
          }
        }
      }

      const accepted = acceptedTransactions.get(transactionSignature)
      if (accepted !== undefined) {
        return accepted
      }
      if (inFlightTransactions.has(transactionSignature)) {
        throw new FakeX402VerificationError(
          'DUPLICATE_PAYMENT',
          'This Solana transaction is already being verified',
        )
      }

      inFlightTransactions.add(transactionSignature)
      try {
        const status = await waitForConfirmedStatus(input.rpc, transactionSignature)
        if (status === null) {
          throw new FakeX402VerificationError(
            'TRANSACTION_NOT_FOUND',
            'The submitted Solana transaction is not known by the devnet RPC',
          )
        }
        if (status.err !== null) {
          throw new FakeX402VerificationError(
            'TRANSACTION_FAILED',
            'The submitted Solana transaction failed on devnet',
          )
        }
        if (!CONFIRMED_STATUSES.has(status.confirmationStatus ?? '')) {
          throw new FakeX402VerificationError(
            'TRANSACTION_NOT_CONFIRMED',
            'The submitted Solana transaction is not confirmed yet',
          )
        }

        const confirmedTransaction = await readConfirmedTransaction(
          input.rpc,
          transactionSignature,
        )
        const transfer = await verifySplTransfer(confirmedTransaction, input.config)
        const verified = {
          transactionSignature,
          payer: transfer.payer,
          accepted: paymentPayload.accepted,
        }
        acceptedTransactions.set(transactionSignature, verified)
        return verified
      } finally {
        inFlightTransactions.delete(transactionSignature)
      }
    },
  }
}

function decodePaymentPayload(header: string): V2PaymentPayload {
  let decodedHeader: unknown
  try {
    decodedHeader = decodePaymentSignatureHeader(header)
  } catch {
    throw new FakeX402VerificationError(
      'PAYMENT_HEADER_INVALID',
      'PAYMENT-SIGNATURE is not a valid x402 v2 header',
    )
  }
  const parsed = parsePaymentPayload(decodedHeader)
  if (!parsed.success || parsed.data.x402Version !== 2) {
    throw new FakeX402VerificationError(
      'PAYMENT_PAYLOAD_INVALID',
      'PAYMENT-SIGNATURE does not contain a valid x402 v2 payment payload',
    )
  }
  return parsed.data as V2PaymentPayload
}

function assertPaymentPayloadMatchesConfig(
  paymentPayload: V2PaymentPayload,
  config: FakeX402Config,
): void {
  const accepted = paymentPayload.accepted
  const feePayer = accepted.extra?.feePayer
  if (
    accepted.scheme !== 'exact' ||
    accepted.network !== config.network ||
    accepted.asset !== config.settlementMint ||
    accepted.amount !== config.amountAtomic.toString() ||
    accepted.payTo !== config.destination ||
    accepted.maxTimeoutSeconds !== config.maxTimeoutSeconds ||
    feePayer !== config.facilitatorFeePayer ||
    paymentPayload.resource?.url !== config.resourceUrl
  ) {
    throw new FakeX402VerificationError(
      'PAYMENT_REQUIREMENT_MISMATCH',
      'Payment payload does not match the fake x402 resource requirements',
    )
  }
}

function decodeBase64Transaction(value: string): Uint8Array {
  if (
    value.length === 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(value) ||
    value.length % 4 === 1
  ) {
    throw new FakeX402VerificationError(
      'TRANSACTION_INVALID',
      'Payment payload contains an invalid base64 transaction',
    )
  }
  const bytes = Uint8Array.from(Buffer.from(value, 'base64'))
  const canonical = Buffer.from(bytes).toString('base64')
  if (canonical.replace(/=+$/u, '') !== value.replace(/=+$/u, '')) {
    throw new FakeX402VerificationError(
      'TRANSACTION_INVALID',
      'Payment payload contains an invalid base64 transaction',
    )
  }
  return bytes
}

function decodeSolanaTransaction(transactionBytes: Uint8Array): unknown {
  try {
    return getTransactionDecoder().decode(transactionBytes)
  } catch {
    throw new FakeX402VerificationError(
      'TRANSACTION_INVALID',
      'Payment payload contains an invalid Solana transaction',
    )
  }
}

function readTransactionSignature(
  transaction: unknown,
  feePayer: string,
): string | undefined {
  if (!isTransactionWithSignatures(transaction)) return undefined
  const feePayerSignature = transaction.signatures[feePayer]
  if (feePayerSignature === null || feePayerSignature === undefined) return undefined
  try {
    return String(getSignatureFromTransaction(transaction as never))
  } catch {
    throw new FakeX402VerificationError(
      'TRANSACTION_INVALID',
      'Payment payload contains an invalid facilitator signature',
    )
  }
}

async function submitPartialTransaction(
  submitter: FakeX402PaymentSubmitter,
  transaction: unknown,
  transactionBytes: Uint8Array,
  paymentPayload: PaymentPayload,
): Promise<string> {
  try {
    const signature = await submitter({ transaction, transactionBytes, paymentPayload })
    if (signature.length === 0) throw new Error('empty signature')
    addressFromSignature(signature)
    return signature
  } catch (error) {
    if (error instanceof FakeX402VerificationError) throw error
    throw new FakeX402VerificationError(
      'TRANSACTION_INVALID',
      'Facilitator could not complete and submit the Solana transaction',
    )
  }
}

async function submitTransaction(
  submitter: FakeX402PaymentSubmitter,
  transaction: unknown,
  transactionBytes: Uint8Array,
  paymentPayload: PaymentPayload,
): Promise<string> {
  try {
    const submitted = await submitter({ transaction, transactionBytes, paymentPayload })
    addressFromSignature(submitted)
    return submitted
  } catch (error) {
    if (error instanceof FakeX402VerificationError) throw error
    throw new FakeX402VerificationError(
      'TRANSACTION_INVALID',
      'The fake x402 service could not submit the signed Solana transaction',
    )
  }
}

async function readSignatureStatus(rpc: FakeX402Rpc, transactionSignature: string) {
  try {
    const response = await rpc
      .getSignatureStatuses([transactionSignature], { searchTransactionHistory: true })
      .send()
    return response.value[0] ?? null
  } catch {
    throw new FakeX402VerificationError(
      'RPC_UNAVAILABLE',
      'The devnet RPC could not read the Solana transaction status',
    )
  }
}

async function waitForConfirmedStatus(
  rpc: FakeX402Rpc,
  transactionSignature: string,
): Promise<Awaited<ReturnType<typeof readSignatureStatus>>> {
  const deadline = Date.now() + CONFIRMATION_TIMEOUT_MS
  let status = await readSignatureStatus(rpc, transactionSignature)
  while (
    Date.now() < deadline &&
    (status === null ||
      (status.err === null && !CONFIRMED_STATUSES.has(status.confirmationStatus ?? '')))
  ) {
    await new Promise((resolve) => setTimeout(resolve, CONFIRMATION_POLL_INTERVAL_MS))
    status = await readSignatureStatus(rpc, transactionSignature)
  }
  return status
}

async function readConfirmedTransaction(
  rpc: FakeX402Rpc,
  transactionSignature: string,
): Promise<FakeX402RpcTransaction> {
  try {
    const transaction = await rpc
      .getTransaction(transactionSignature, {
        encoding: 'jsonParsed',
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      })
      .send()
    if (transaction === null) {
      throw new FakeX402VerificationError(
        'TRANSACTION_NOT_FOUND',
        'The confirmed Solana transaction details are unavailable',
      )
    }
    return transaction
  } catch (error) {
    if (error instanceof FakeX402VerificationError) throw error
    throw new FakeX402VerificationError(
      'RPC_UNAVAILABLE',
      'The devnet RPC could not read the confirmed Solana transaction',
    )
  }
}

async function verifySplTransfer(
  transaction: FakeX402RpcTransaction,
  config: FakeX402Config,
): Promise<{ readonly payer: string }> {
  if (transaction.meta === null || transaction.meta.err !== null) {
    throw new FakeX402VerificationError(
      'TRANSACTION_FAILED',
      'The Solana transaction has failed execution metadata',
    )
  }

  const destinationAta = await findAssociatedTokenPda({
    owner: address(config.destination),
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
    mint: address(config.settlementMint),
  })
  const accountKeys = transaction.transaction.message.accountKeys ?? []
  if (accountKeyAddress(accountKeys[0]) !== config.facilitatorFeePayer) {
    throw transferMismatch(
      'The configured facilitator is not the Solana transaction fee payer',
    )
  }
  if (!isSigner(accountKeys, config.facilitatorFeePayer)) {
    throw transferMismatch(
      'The configured facilitator did not sign the Solana transaction',
    )
  }
  const destinationIndex = findAccountIndex(accountKeys, destinationAta[0])
  if (destinationIndex === undefined) {
    throw transferMismatch(
      'The transaction does not reference the required destination ATA',
    )
  }

  const preDestination = findTokenBalance(
    transaction.meta.preTokenBalances,
    destinationIndex,
  )
  const postDestination = findTokenBalance(
    transaction.meta.postTokenBalances,
    destinationIndex,
  )
  if (
    preDestination === undefined ||
    postDestination === undefined ||
    preDestination.mint !== config.settlementMint ||
    postDestination.mint !== config.settlementMint
  ) {
    throw transferMismatch('The destination ATA has no matching TEST_USDC post-balance')
  }
  if (postDestination.owner !== config.destination) {
    throw transferMismatch(
      'The destination ATA owner differs from the payment requirement',
    )
  }

  const preAmount = readTokenAmount(preDestination)
  const postAmount = readTokenAmount(postDestination)
  if (postAmount - preAmount !== config.amountAtomic) {
    throw transferMismatch(
      'The destination token balance delta differs from the required amount',
    )
  }

  const transfers = collectTransfers(transaction)
  const settlementTransfers = transfers.filter((transfer) => {
    const sourceBalance = findTokenBalanceByAddress(transaction, transfer.source)
    const mint = transfer.mint ?? sourceBalance?.mint
    return mint === config.settlementMint
  })
  const matchingTransfers = transfers.filter((transfer) => {
    const sourceBalance = findTokenBalanceByAddress(transaction, transfer.source)
    const mint = transfer.mint ?? sourceBalance?.mint
    return (
      transfer.destination === destinationAta[0] &&
      transfer.amount === config.amountAtomic &&
      mint === config.settlementMint
    )
  })
  if (settlementTransfers.length !== 1 || matchingTransfers.length !== 1) {
    throw transferMismatch(
      'The transaction does not contain exactly one TEST_USDC transfer',
    )
  }

  const transfer = matchingTransfers[0]
  if (transfer === undefined) {
    throw transferMismatch('The matching SPL transfer is unavailable')
  }
  const sourceBalance = findTokenBalanceByAddress(transaction, transfer.source)
  if (sourceBalance === undefined || sourceBalance.owner === undefined) {
    throw transferMismatch('The source token account owner is unavailable')
  }
  if (sourceBalance.mint !== config.settlementMint) {
    throw transferMismatch('The source token account mint differs from TEST_USDC')
  }
  const sourceIndex = findAccountIndex(accountKeys, transfer.source)
  const preSource =
    sourceIndex === undefined
      ? undefined
      : findTokenBalance(transaction.meta.preTokenBalances, sourceIndex)
  const postSource =
    sourceIndex === undefined
      ? undefined
      : findTokenBalance(transaction.meta.postTokenBalances, sourceIndex)
  if (
    preSource === undefined ||
    postSource === undefined ||
    preSource.mint !== config.settlementMint ||
    postSource.mint !== config.settlementMint ||
    readTokenAmount(postSource) - readTokenAmount(preSource) !== -config.amountAtomic
  ) {
    throw transferMismatch(
      'The source token balance delta differs from the required amount',
    )
  }
  if (transfer.authority !== sourceBalance.owner) {
    throw transferMismatch('The transfer authority differs from the source token owner')
  }
  if (!isSigner(accountKeys, transfer.authority)) {
    throw transferMismatch('The source token owner did not sign the Solana transaction')
  }

  return { payer: sourceBalance.owner }
}

function collectTransfers(
  transaction: FakeX402RpcTransaction,
): readonly ParsedTransfer[] {
  const topLevel = transaction.transaction.message.instructions ?? []
  const inner =
    transaction.meta?.innerInstructions?.flatMap((group) => group.instructions) ?? []
  return [...topLevel, ...inner]
    .map(parseTransfer)
    .filter((transfer): transfer is ParsedTransfer => transfer !== undefined)
}

function parseTransfer(
  instruction: FakeX402ParsedInstruction,
): ParsedTransfer | undefined {
  if (
    instruction.program !== 'spl-token' &&
    instruction.programId !== TOKEN_PROGRAM_ADDRESS
  ) {
    return undefined
  }
  if (instruction.parsed === null || typeof instruction.parsed !== 'object') {
    return undefined
  }
  const parsed = instruction.parsed as {
    readonly type?: unknown
    readonly info?: unknown
  }
  if (parsed.type !== 'transfer' && parsed.type !== 'transferChecked') return undefined
  if (parsed.info === null || typeof parsed.info !== 'object') return undefined
  const info = parsed.info as {
    readonly source?: unknown
    readonly destination?: unknown
    readonly amount?: unknown
    readonly mint?: unknown
    readonly authority?: unknown
    readonly tokenAmount?: { readonly amount?: unknown }
  }
  if (typeof info.source !== 'string' || typeof info.destination !== 'string') {
    return undefined
  }
  const amountValue = info.tokenAmount?.amount ?? info.amount
  if (typeof amountValue !== 'string' && typeof amountValue !== 'number')
    return undefined
  let amount: bigint
  try {
    amount = BigInt(String(amountValue))
  } catch {
    return undefined
  }
  return {
    source: info.source,
    destination: info.destination,
    amount,
    ...(typeof info.mint === 'string' ? { mint: info.mint } : {}),
    ...(typeof info.authority === 'string' ? { authority: info.authority } : {}),
  }
}

interface ParsedTransfer {
  readonly source: string
  readonly destination: string
  readonly amount: bigint
  readonly mint?: string
  readonly authority?: string
}

function findTokenBalance(
  balances: readonly FakeX402TokenBalance[] | undefined,
  accountIndex: number,
): FakeX402TokenBalance | undefined {
  return balances?.find((balance) => balance.accountIndex === accountIndex)
}

function findTokenBalanceByAddress(
  transaction: FakeX402RpcTransaction,
  tokenAccount: string,
): FakeX402TokenBalance | undefined {
  const accountIndex = findAccountIndex(
    transaction.transaction.message.accountKeys ?? [],
    tokenAccount,
  )
  if (accountIndex === undefined) return undefined
  return (
    findTokenBalance(transaction.meta?.postTokenBalances, accountIndex) ??
    findTokenBalance(transaction.meta?.preTokenBalances, accountIndex)
  )
}

function readTokenAmount(balance: FakeX402TokenBalance | undefined): bigint {
  if (balance === undefined) return 0n
  try {
    return BigInt(balance.uiTokenAmount.amount)
  } catch {
    throw transferMismatch('Solana RPC returned an invalid token balance')
  }
}

function findAccountIndex(
  accountKeys: readonly (string | { readonly pubkey: string })[],
  expectedAddress: string,
): number | undefined {
  const index = accountKeys.findIndex((key) =>
    typeof key === 'string' ? key === expectedAddress : key.pubkey === expectedAddress,
  )
  return index === -1 ? undefined : index
}

function accountKeyAddress(
  key: string | { readonly pubkey: string } | undefined,
): string | undefined {
  return typeof key === 'string' ? key : key?.pubkey
}

function isSigner(
  accountKeys: readonly (
    string | { readonly pubkey: string; readonly signer?: boolean }
  )[],
  expectedAddress: string,
): boolean {
  return accountKeys.some(
    (key) =>
      typeof key !== 'string' && key.pubkey === expectedAddress && key.signer === true,
  )
}

function isTransactionWithSignatures(
  transaction: unknown,
): transaction is { readonly signatures: Readonly<Record<string, unknown>> } {
  return (
    typeof transaction === 'object' &&
    transaction !== null &&
    'signatures' in transaction &&
    typeof transaction.signatures === 'object' &&
    transaction.signatures !== null
  )
}

function addressFromSignature(value: string): void {
  try {
    signature(value)
  } catch {
    throw new Error('invalid Solana signature')
  }
}

function transferMismatch(message: string): FakeX402VerificationError {
  return new FakeX402VerificationError('TRANSFER_MISMATCH', message)
}
