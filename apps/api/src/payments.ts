import { createHash, randomBytes } from 'node:crypto'
import {
  assertPaymentAttemptStatusTransition,
  assertPaymentStatusTransition,
  ConflictError,
  createPaymentAttemptId,
  createPaymentId,
  createPositiveMoney,
  ExternalRailError,
  formatMoney,
  InsufficientFundsError,
  moneyFromAtomicUnits,
  selectPaymentRail,
  RecipientResolutionError,
  UnsupportedRailError,
  ValidationError,
  type Money,
  type PaymentKind,
  type PaymentRail,
  type RailPreparationContext,
  type RailPaymentRequest,
} from '@agent-payment/core'
import type {
  AuthenticatedAccount,
  PaymentAttemptStatus as StoredPaymentAttemptStatus,
  PaymentRecord,
  PaymentRepository,
  RecipientRecord,
  RecipientRepository,
  ReservationRepository,
} from '@agent-payment/db'

export interface SettledBalanceReader {
  getSettlementBalance(owner: string): Promise<{ readonly settled: Money }>
}

export interface PaymentRequest {
  readonly recipientId: string
  readonly amount: string
  readonly currency: string
  readonly description?: string
  readonly externalReference?: string
}

export interface PaymentResult {
  readonly payment: PaymentRecord
  readonly created: boolean
}

export type PayerSecretKeyProvider = (accountId: string) => Promise<Uint8Array>

type PaymentStore = PaymentRepository & RecipientRepository & ReservationRepository

export class PaymentService {
  public constructor(
    private readonly repository: PaymentStore,
    private readonly balanceReader: SettledBalanceReader,
    private readonly rails: readonly PaymentRail[],
    private readonly payerSecretKeyProvider?: PayerSecretKeyProvider,
  ) {}

  public async createPayment(
    account: AuthenticatedAccount,
    kind: PaymentKind,
    input: PaymentRequest,
    idempotencyKey: string,
  ): Promise<PaymentResult> {
    const money = createPositiveMoney(input.amount, input.currency)
    const normalizedKey = normalizeIdempotencyKey(idempotencyKey)
    const description = normalizeOptionalText(input.description, 'Description', 500)
    const externalReference = normalizeOptionalText(
      input.externalReference,
      'External reference',
      255,
    )
    const requestHash = hashCanonicalRequest({
      operation: kind,
      recipient_id: input.recipientId,
      amount: formatMoney(money),
      currency: money.currency,
      ...(description === undefined ? {} : { description }),
      ...(externalReference === undefined
        ? {}
        : { external_reference: externalReference }),
    })
    const replay = await this.repository.findIdempotencyReplay(
      account.account.id,
      kind,
      normalizedKey,
    )
    if (replay !== null) {
      if (replay.requestHash !== requestHash) {
        throw new ConflictError('Idempotency key was already used for another request')
      }
      return { payment: replay.payment, created: false }
    }
    const recipient = await this.resolveRecipient(account.account.id, input.recipientId)
    const routed = this.routePayment(
      account,
      recipient,
      kind,
      money,
      description,
      externalReference,
    )
    const balance = await this.balanceReader.getSettlementBalance(
      account.account.solanaPublicKey,
    )
    const persisted = await this.repository.createPaymentWithReservation({
      paymentId: createPaymentId(),
      reservationId: createPrefixedId('resv'),
      idempotencyId: createPrefixedId('idem'),
      ownerAccountId: account.account.id,
      operation: kind,
      idempotencyKey: normalizedKey,
      requestHash,
      payerAccountId: account.account.id,
      recipientId: recipient.id,
      amountAtomic: money.atomicUnits,
      currency: money.currency,
      ...(description === undefined ? {} : { description }),
      ...(externalReference === undefined ? {} : { externalReference }),
      route: routed.rail.name,
      settledAtomic: balance.settled.atomicUnits,
    })
    if (!persisted.created) {
      return persisted
    }

    return this.executePayment(
      persisted.payment,
      routed.rail,
      routed.request,
      account.account.solanaPublicKey,
    )
  }

  public async getPayment(
    accountId: string,
    paymentId: string,
  ): Promise<PaymentRecord> {
    const payment = await this.repository.findPaymentForOwner(accountId, paymentId)
    if (payment === null) {
      throw new ResourceNotFoundError('Payment not found')
    }
    return this.reconcilePaymentIfNeeded(payment)
  }

  public listPayments(accountId: string): Promise<readonly PaymentRecord[]> {
    return this.repository.listPayments(accountId)
  }

  private async reconcilePaymentIfNeeded(
    payment: PaymentRecord,
  ): Promise<PaymentRecord> {
    if (payment.status !== 'RECONCILING') {
      return payment
    }
    const attempts = await this.repository.listPaymentAttempts(payment.id)
    const attempt = attempts.at(-1)
    if (attempt === undefined) {
      return payment
    }
    const rail = this.rails.find((candidate) => candidate.name === attempt.rail)
    const transactionId = attempt.railTransactionId ?? attempt.expectedSignature
    if (rail?.getStatus === undefined || transactionId === null) {
      return payment
    }

    const status = await rail.getStatus(transactionId)
    if (status.status === 'SUBMITTED') {
      return payment
    }
    if (status.status === 'CONFIRMED') {
      await this.repository.updatePaymentAttempt(
        attempt.id,
        'RECONCILING',
        'CONFIRMED',
        {
          railTransactionId: status.railTransactionId ?? transactionId,
          ...(status.confirmedSlot === undefined
            ? {}
            : { confirmedSlot: status.confirmedSlot }),
        },
      )
      const confirmedPayment = await this.repository.transitionPayment(
        payment.id,
        'RECONCILING',
        'CONFIRMED',
        { confirmedAt: new Date() },
      )
      await this.repository.releaseReservation(payment.id)
      return confirmedPayment
    }

    await this.repository.updatePaymentAttempt(attempt.id, 'RECONCILING', 'FAILED')
    await this.repository.transitionPayment(payment.id, 'RECONCILING', 'FAILED', {
      failedAt: new Date(),
      failureCode: 'EXTERNAL_RAIL_FAILURE',
      failureMessageSafe: 'Payment rail execution failed',
    })
    await this.repository.releaseReservation(payment.id)
    return (
      (await this.repository.findPaymentForOwner(payment.payerAccountId, payment.id)) ??
      payment
    )
  }

  private async resolveRecipient(
    ownerAccountId: string,
    recipientId: string,
  ): Promise<RecipientRecord> {
    const recipient = await this.repository.findRecipientForOwner(
      ownerAccountId,
      recipientId,
    )
    if (recipient === null) {
      throw new RecipientResolutionError()
    }
    if (recipient.ownerStatus !== 'ACTIVE' || recipient.destinations.length === 0) {
      throw new RecipientResolutionError('Recipient is not payable')
    }
    return recipient
  }

  private routePayment(
    account: AuthenticatedAccount,
    recipient: RecipientRecord,
    kind: PaymentKind,
    amount: Money,
    description: string | undefined,
    externalReference: string | undefined,
  ): { readonly rail: PaymentRail; readonly request: RailPaymentRequest } {
    const destinations = [...recipient.destinations].sort((left, right) =>
      compareStrings(`${left.rail}:${left.id}`, `${right.rail}:${right.id}`),
    )
    let lastUnsupportedRail: Error | undefined
    for (const destination of destinations) {
      const request: RailPaymentRequest = {
        operation: kind,
        currency: amount.currency,
        amount,
        payerAccountId: account.account.id,
        recipientId: recipient.id,
        destination: {
          rail: destination.rail,
          type: destination.type,
          reference: destination.walletAddress,
        },
        ...(description === undefined ? {} : { description }),
        ...(externalReference === undefined ? {} : { externalReference }),
      }
      try {
        return { rail: selectPaymentRail(request, this.rails), request }
      } catch (error) {
        lastUnsupportedRail = error instanceof Error ? error : undefined
      }
    }
    if (lastUnsupportedRail !== undefined) {
      throw lastUnsupportedRail
    }
    throw new UnsupportedRailError('recipient-destination')
  }

  private async executePayment(
    payment: PaymentRecord,
    rail: PaymentRail,
    request: RailPaymentRequest,
    payerPublicKey: string,
  ): Promise<PaymentResult> {
    let paymentStatus = payment.status
    let attemptStatus: StoredPaymentAttemptStatus = 'CREATED'
    let attempt:
      Awaited<ReturnType<PaymentRepository['createPaymentAttempt']>> | undefined

    try {
      attempt = await this.repository.createPaymentAttempt({
        id: createPaymentAttemptId(),
        paymentId: payment.id,
        attemptNumber: 1,
        rail: rail.name,
        status: attemptStatus,
      })
      assertPaymentStatusTransition(paymentStatus, 'ROUTING')
      await this.repository.transitionPayment(payment.id, paymentStatus, 'ROUTING')
      paymentStatus = 'ROUTING'

      const quote = await rail.quote(request)
      if (
        quote.amount.currency !== request.amount.currency ||
        quote.amount.atomicUnits !== request.amount.atomicUnits
      ) {
        throw new ExternalRailError('Payment rail returned an invalid quote')
      }
      const preparationContext: RailPreparationContext = {
        paymentId: payment.id,
        payerAccountId: payment.payerAccountId,
        payerPublicKey,
        getPayerSecretKey: async () => {
          if (this.payerSecretKeyProvider === undefined) {
            throw new ExternalRailError('Payer custody is not configured')
          }
          return this.payerSecretKeyProvider(payment.payerAccountId)
        },
      }
      const prepared = await rail.prepare(request, preparationContext)
      assertPaymentAttemptStatusTransition(attemptStatus, 'PREPARED')
      const durableExecution = prepared.durableExecution
      await this.repository.updatePaymentAttempt(
        attempt.id,
        attemptStatus,
        'PREPARED',
        prepared.payloadSafe === undefined && durableExecution === undefined
          ? undefined
          : {
              ...(prepared.payloadSafe === undefined
                ? {}
                : { serializedPayloadSafe: prepared.payloadSafe }),
              ...(durableExecution === undefined
                ? {}
                : {
                    signedTransactionBase64:
                      durableExecution.serializedTransactionBase64,
                    expectedSignature: durableExecution.expectedTransactionId,
                    blockhash: durableExecution.blockhash,
                    lastValidBlockHeight: durableExecution.lastValidBlockHeight,
                  }),
            },
      )
      attemptStatus = 'PREPARED'

      const execute = rail.execute
      if (execute === undefined) {
        return {
          payment: await this.getPayment(payment.payerAccountId, payment.id),
          created: true,
        }
      }

      const execution = await execute(prepared)
      if (execution.status === 'FAILED') {
        throw new ExternalRailError('Payment rail reported a failed execution')
      }
      assertPaymentAttemptStatusTransition(attemptStatus, 'SUBMITTED')
      await this.repository.updatePaymentAttempt(
        attempt.id,
        attemptStatus,
        'SUBMITTED',
        execution.railTransactionId === undefined
          ? undefined
          : { railTransactionId: execution.railTransactionId },
      )
      attemptStatus = 'SUBMITTED'
      assertPaymentStatusTransition(paymentStatus, 'SUBMITTED')
      await this.repository.transitionPayment(payment.id, paymentStatus, 'SUBMITTED')
      paymentStatus = 'SUBMITTED'

      if (execution.status === 'CONFIRMED') {
        assertPaymentAttemptStatusTransition(attemptStatus, 'CONFIRMED')
        await this.repository.updatePaymentAttempt(
          attempt.id,
          attemptStatus,
          'CONFIRMED',
          execution.railTransactionId === undefined &&
            execution.confirmedSlot === undefined
            ? undefined
            : {
                ...(execution.railTransactionId === undefined
                  ? {}
                  : { railTransactionId: execution.railTransactionId }),
                ...(execution.confirmedSlot === undefined
                  ? {}
                  : { confirmedSlot: execution.confirmedSlot }),
              },
        )
        attemptStatus = 'CONFIRMED'
        assertPaymentStatusTransition(paymentStatus, 'CONFIRMED')
        const confirmedPayment = await this.repository.transitionPayment(
          payment.id,
          paymentStatus,
          'CONFIRMED',
          { confirmedAt: new Date() },
        )
        await this.repository.releaseReservation(payment.id)
        return { payment: confirmedPayment, created: true }
      }
      if (execution.status === 'SUBMITTED') {
        return {
          payment: await this.getPayment(payment.payerAccountId, payment.id),
          created: true,
        }
      }
      throw new ExternalRailError(
        'Payment rail returned an unsupported execution state',
      )
    } catch (error) {
      if (
        error instanceof ExternalRailError &&
        error.kind === 'AMBIGUOUS' &&
        attempt !== undefined
      ) {
        await this.markPaymentReconciling(
          payment.id,
          paymentStatus,
          attempt.id,
          attemptStatus,
        )
        throw new ExternalRailError(
          'Payment execution outcome is ambiguous',
          error,
          'AMBIGUOUS',
          { payment_id: payment.id },
        )
      }
      if (attempt === undefined) {
        assertPaymentStatusTransition(paymentStatus, 'FAILED')
        await this.repository.transitionPayment(payment.id, paymentStatus, 'FAILED', {
          failedAt: new Date(),
          failureCode: 'EXTERNAL_RAIL_FAILURE',
          failureMessageSafe: 'Payment rail execution failed',
        })
        await this.repository.releaseReservation(payment.id)
      } else {
        await this.failPayment(payment.id, paymentStatus, attempt.id, attemptStatus)
      }
      if (error instanceof InsufficientFundsError) {
        throw error
      }
      throw error instanceof ExternalRailError
        ? error
        : new ExternalRailError('Payment rail execution failed')
    }
  }

  private async markPaymentReconciling(
    paymentId: string,
    paymentStatus: PaymentRecord['status'],
    attemptId: string,
    attemptStatus: StoredPaymentAttemptStatus,
  ): Promise<void> {
    if (attemptStatus !== 'RECONCILING') {
      assertPaymentAttemptStatusTransition(attemptStatus, 'RECONCILING')
      await this.repository.updatePaymentAttempt(
        attemptId,
        attemptStatus,
        'RECONCILING',
      )
    }
    if (paymentStatus !== 'RECONCILING') {
      assertPaymentStatusTransition(paymentStatus, 'RECONCILING')
      await this.repository.transitionPayment(paymentId, paymentStatus, 'RECONCILING')
    }
  }

  private async failPayment(
    paymentId: string,
    paymentStatus: PaymentRecord['status'],
    attemptId: string,
    attemptStatus: StoredPaymentAttemptStatus,
  ): Promise<void> {
    if (attemptStatus !== 'FAILED' && attemptStatus !== 'CONFIRMED') {
      assertPaymentAttemptStatusTransition(attemptStatus, 'FAILED')
      await this.repository.updatePaymentAttempt(attemptId, attemptStatus, 'FAILED')
    }
    if (paymentStatus !== 'FAILED' && paymentStatus !== 'CONFIRMED') {
      assertPaymentStatusTransition(paymentStatus, 'FAILED')
      await this.repository.transitionPayment(paymentId, paymentStatus, 'FAILED', {
        failedAt: new Date(),
        failureCode: 'EXTERNAL_RAIL_FAILURE',
        failureMessageSafe: 'Payment rail execution failed',
      })
      await this.repository.releaseReservation(paymentId)
    }
  }
}

export function serializePayment(payment: PaymentRecord) {
  return {
    id: payment.id,
    recipient_id: payment.recipientId,
    kind: payment.kind,
    amount: formatMoney(moneyFromAtomicUnits(payment.amountAtomic, payment.currency)),
    currency: payment.currency,
    status: payment.status,
    description: payment.description,
    external_reference: payment.externalReference,
    route: payment.route,
    created_at: payment.createdAt.toISOString(),
    updated_at: payment.updatedAt.toISOString(),
    confirmed_at: payment.confirmedAt?.toISOString() ?? null,
    failed_at: payment.failedAt?.toISOString() ?? null,
    failure_code: payment.failureCode,
    failure_message: payment.failureMessageSafe,
  }
}

function normalizeIdempotencyKey(value: string): string {
  const normalized = value.trim()
  if (normalized.length === 0 || normalized.length > 255) {
    throw new ValidationError('Idempotency-Key must contain 1 to 255 characters')
  }
  return normalized
}

function normalizeOptionalText(
  value: string | undefined,
  field: string,
  maxLength: number,
): string | undefined {
  if (value === undefined) {
    return undefined
  }
  const normalized = value.trim()
  if (normalized.length === 0 || normalized.length > maxLength) {
    throw new ValidationError(`${field} must contain 1 to ${maxLength} characters`)
  }
  return normalized
}

function hashCanonicalRequest(value: unknown): string {
  const canonical = canonicalize(value)
  return createSha256(canonical)
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`
  }
  const object = value as Record<string, unknown>
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(object[key])}`)
    .join(',')}}`
}

function createSha256(value: string): string {
  // Kept local to the API package so the core contract remains runtime-agnostic.
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function createPrefixedId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString('hex')}`
}

function compareStrings(left: string, right: string): -1 | 0 | 1 {
  if (left < right) {
    return -1
  }
  if (left > right) {
    return 1
  }
  return 0
}

class ResourceNotFoundError extends Error {
  public readonly statusCode = 404

  public constructor(message: string) {
    super(message)
    this.name = 'ResourceNotFoundError'
  }
}
