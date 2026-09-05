import { createHash, randomBytes } from 'node:crypto'
import {
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
  RefundNotSupportedError,
  UnsupportedRailError,
  ValidationError,
  type Money,
  type PaymentKind,
  type PaymentRail,
  type RailExecutionResult,
  type RailRecoveryResult,
  type RailPreparedPayment,
  type RailPreparationContext,
  type RailPaymentRequest,
} from '@agent-payment/core'
import type {
  AuthenticatedAccount,
  PaymentRecord,
  PaymentAttemptRecord,
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
      payerPublicKey: account.account.solanaPublicKey,
      destinationRail: routed.request.destination.rail,
      destinationType: routed.request.destination.type,
      destinationReference: routed.request.destination.reference,
      ...(recipient.managedAccountId === null
        ? {}
        : { recipientManagedAccountId: recipient.managedAccountId }),
      counterpartyAddress: routed.request.destination.reference,
      ...(recipient.managedAccountId === null
        ? {}
        : { counterpartyAccountId: recipient.managedAccountId }),
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

  public async createRefund(
    account: AuthenticatedAccount,
    input: {
      readonly originalPaymentId: string
      readonly amount: string
      readonly currency: string
    },
    idempotencyKey: string,
  ): Promise<PaymentResult> {
    const money = createPositiveMoney(input.amount, input.currency)
    const normalizedKey = normalizeIdempotencyKey(idempotencyKey)
    const requestHash = hashCanonicalRequest({
      operation: 'REFUND',
      original_payment_id: input.originalPaymentId,
      amount: formatMoney(money),
      currency: money.currency,
    })
    const replay = await this.repository.findIdempotencyReplay(
      account.account.id,
      'REFUND',
      normalizedKey,
    )
    if (replay !== null) {
      if (replay.requestHash !== requestHash) {
        throw new ConflictError('Idempotency key was already used for another request')
      }
      return { payment: replay.payment, created: false }
    }
    const original = await this.repository.findPaymentForRefund(
      account.account.id,
      input.originalPaymentId,
    )
    if (original === null || original.payerPublicKey === null) {
      throw new RefundNotSupportedError()
    }
    if (
      original.status !== 'CONFIRMED' ||
      original.recipientManagedAccountId !== account.account.id
    ) {
      throw new RefundNotSupportedError(
        'This account does not control the original recipient',
      )
    }
    if (original.destinationRail === null || original.destinationType === null) {
      throw new RefundNotSupportedError()
    }
    const request: RailPaymentRequest = {
      operation: 'REFUND',
      currency: money.currency,
      amount: money,
      payerAccountId: account.account.id,
      recipientId: original.recipientId ?? original.id,
      destination: {
        rail: original.destinationRail,
        type: original.destinationType,
        reference: original.payerPublicKey,
      },
      externalReference: `refund:${original.id}`,
    }
    const rail = selectPaymentRail(request, this.rails)
    rail.validateDestination?.(request)
    const balance = await this.balanceReader.getSettlementBalance(
      account.account.solanaPublicKey,
    )
    const persisted = await this.repository.createRefundWithReservation({
      paymentId: createPaymentId(),
      reservationId: createPrefixedId('resv'),
      idempotencyId: createPrefixedId('idem'),
      ownerAccountId: account.account.id,
      operation: 'REFUND',
      idempotencyKey: normalizedKey,
      requestHash,
      payerAccountId: account.account.id,
      payerPublicKey: account.account.solanaPublicKey,
      recipientId: null,
      amountAtomic: money.atomicUnits,
      currency: money.currency,
      route: rail.name,
      destinationRail: request.destination.rail,
      destinationType: request.destination.type,
      destinationReference: request.destination.reference,
      recipientManagedAccountId: original.payerAccountId,
      originalPaymentId: original.id,
      counterpartyAccountId: original.payerAccountId,
      ...(original.payerPublicKey === null
        ? {}
        : { counterpartyAddress: original.payerPublicKey }),
      refundInitiatorAccountId: account.account.id,
      settledAtomic: balance.settled.atomicUnits,
    })
    if (!persisted.created) {
      return persisted
    }
    return this.executePayment(
      persisted.payment,
      rail,
      request,
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
    return this.recoverPayment(payment)
  }

  public listPayments(accountId: string): Promise<readonly PaymentRecord[]> {
    return this.repository.listPayments(accountId)
  }

  private async recoverPayment(payment: PaymentRecord): Promise<PaymentRecord> {
    if (payment.status === 'CONFIRMED' || payment.status === 'FAILED') {
      return payment
    }
    const attempts = await this.repository.listPaymentAttempts(payment.id)
    let attempt = attempts.at(-1)
    const rail = this.rails.find((candidate) => candidate.name === payment.route)
    const request = this.createPersistedRailRequest(payment)
    if (
      rail === undefined ||
      request === undefined ||
      payment.payerPublicKey === null
    ) {
      return payment
    }

    if (payment.status === 'CREATED') {
      payment = await this.repository.transitionPayment(
        payment.id,
        'CREATED',
        'ROUTING',
      )
    }

    const context = this.createPreparationContext(payment)
    if (attempt === undefined) {
      const initialAttempt = await this.repository.getOrCreatePaymentAttempt({
        id: createPaymentAttemptId(),
        paymentId: payment.id,
        rail: rail.name,
        status: 'CREATED',
      })
      attempt = initialAttempt.attempt
    }
    if (attempt.status === 'CREATED') {
      const prepared = await rail.prepare(request, context)
      try {
        attempt = await this.repository.updatePaymentAttempt(
          attempt.id,
          'CREATED',
          'PREPARED',
          this.durableAttemptFields(prepared),
        )
      } catch (error) {
        if (!(error instanceof ConflictError)) {
          throw error
        }
        const latestAttempt = (
          await this.repository.listPaymentAttempts(payment.id)
        ).at(-1)
        if (latestAttempt === undefined) {
          throw error
        }
        attempt = latestAttempt
      }
    }

    const prepared = this.preparedPaymentFromAttempt(attempt)
    if (
      prepared === undefined ||
      attempt.status === 'CONFIRMED' ||
      attempt.status === 'FAILED'
    ) {
      return payment
    }

    let recovery: RailRecoveryResult
    try {
      recovery =
        rail.recover === undefined
          ? await this.executeRail(prepared, rail)
          : await rail.recover(prepared, context)
    } catch {
      // A recovery read can be unavailable after a send. Keep the payment and
      // reservation recoverable instead of turning an unknown outcome into a failure.
      await this.tryMarkReconciling(payment, attempt)
      return (
        (await this.repository.findPaymentForOwner(
          payment.payerAccountId,
          payment.id,
        )) ?? payment
      )
    }
    if (recovery.replacement !== undefined) {
      const replacement = await this.repository.createReplacementPaymentAttempt({
        attemptId: createPaymentAttemptId(),
        paymentId: payment.id,
        previousAttemptId: attempt.id,
        rail: rail.name,
        durablePayload: recovery.replacement.durableExecution?.serializedPayload ?? '',
        expectedExternalId:
          recovery.replacement.durableExecution?.expectedExternalId ?? '',
        recoveryMetadata: recovery.replacement.durableExecution?.recoveryMetadata ?? '',
        ...(recovery.replacement.payloadSafe === undefined
          ? {}
          : { serializedPayloadSafe: recovery.replacement.payloadSafe }),
      })
      attempt = replacement.attempt
      if (replacement.created) {
        return this.executeRecoveredAttempt(
          payment,
          attempt,
          recovery.replacement,
          rail,
        )
      }
      const existingPrepared = this.preparedPaymentFromAttempt(attempt)
      if (existingPrepared === undefined) {
        return payment
      }
      return this.executeRecoveredAttempt(payment, attempt, existingPrepared, rail)
    }
    return this.finalizeRecoveredResult(payment, attempt, recovery)
  }

  private async applyRecoveredExecutionResult(
    payment: PaymentRecord,
    attempt: PaymentAttemptRecord,
    execution: RailExecutionResult,
  ): Promise<PaymentRecord> {
    try {
      return await this.applyExecutionResult(payment, attempt, execution)
    } catch (error) {
      if (!(error instanceof ConflictError)) {
        throw error
      }
      // Another process may have finalized this exact attempt while this
      // process was reading the chain. Its result is authoritative.
      return (
        (await this.repository.findPaymentForOwner(
          payment.payerAccountId,
          payment.id,
        )) ?? payment
      )
    }
  }

  private async executeRecoveredAttempt(
    payment: PaymentRecord,
    attempt: PaymentAttemptRecord,
    prepared: RailPreparedPayment,
    rail: PaymentRail,
  ): Promise<PaymentRecord> {
    try {
      return await this.applyRecoveredExecutionResult(
        payment,
        attempt,
        await this.executeRail(prepared, rail),
      )
    } catch {
      // The attempt already has durable recovery material. Any local failure
      // after this point may follow a network send, so it must stay recoverable.
      await this.tryMarkReconciling(payment, attempt)
      return (
        (await this.repository.findPaymentForOwner(
          payment.payerAccountId,
          payment.id,
        )) ?? payment
      )
    }
  }

  private async finalizeRecoveredResult(
    payment: PaymentRecord,
    attempt: PaymentAttemptRecord,
    execution: RailExecutionResult,
  ): Promise<PaymentRecord> {
    try {
      return await this.applyRecoveredExecutionResult(payment, attempt, execution)
    } catch {
      // Confirmation may already exist on-chain. Persistence failure must not
      // release the reservation or mark this payment as failed.
      await this.tryMarkReconciling(payment, attempt)
      return (
        (await this.repository.findPaymentForOwner(
          payment.payerAccountId,
          payment.id,
        )) ?? payment
      )
    }
  }

  private createPersistedRailRequest(
    payment: PaymentRecord,
  ): RailPaymentRequest | undefined {
    if (
      payment.destinationRail === null ||
      payment.destinationType === null ||
      payment.destinationReference === null
    ) {
      return undefined
    }
    const amount = moneyFromAtomicUnits(payment.amountAtomic, payment.currency)
    return {
      operation: payment.kind,
      currency: amount.currency,
      amount,
      payerAccountId: payment.payerAccountId,
      recipientId: payment.recipientId ?? payment.counterpartyAccountId ?? payment.id,
      destination: {
        rail: payment.destinationRail,
        type: payment.destinationType,
        reference: payment.destinationReference,
      },
      ...(payment.description === null ? {} : { description: payment.description }),
      ...(payment.externalReference === null
        ? {}
        : { externalReference: payment.externalReference }),
    }
  }

  private createPreparationContext(payment: PaymentRecord): RailPreparationContext {
    return {
      paymentId: payment.id,
      payerAccountId: payment.payerAccountId,
      payerPublicKey: payment.payerPublicKey as string,
      getPayerSecretKey: async () => {
        if (this.payerSecretKeyProvider === undefined) {
          throw new ExternalRailError('Payer custody is not configured')
        }
        return this.payerSecretKeyProvider(payment.payerAccountId)
      },
    }
  }

  private durableAttemptFields(prepared: RailPreparedPayment) {
    const durable = prepared.durableExecution
    return {
      ...(prepared.payloadSafe === undefined
        ? {}
        : { serializedPayloadSafe: prepared.payloadSafe }),
      ...(durable === undefined
        ? {}
        : {
            durablePayload: durable.serializedPayload,
            expectedExternalId: durable.expectedExternalId,
            recoveryMetadata: durable.recoveryMetadata,
          }),
    }
  }

  private preparedPaymentFromAttempt(
    attempt: PaymentAttemptRecord,
  ): RailPreparedPayment | undefined {
    if (
      attempt.durablePayload === null ||
      attempt.expectedExternalId === null ||
      attempt.recoveryMetadata === null
    ) {
      return undefined
    }
    return {
      rail: attempt.rail,
      ...(attempt.serializedPayloadSafe === null
        ? {}
        : { payloadSafe: attempt.serializedPayloadSafe }),
      durableExecution: {
        serializedPayload: attempt.durablePayload,
        expectedExternalId: attempt.expectedExternalId,
        recoveryMetadata: attempt.recoveryMetadata,
      },
    }
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
      let rail: PaymentRail
      try {
        rail = selectPaymentRail(request, this.rails)
      } catch (error) {
        lastUnsupportedRail = error instanceof Error ? error : undefined
        continue
      }
      rail.validateDestination?.(request)
      return { rail, request }
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
    let attempt: PaymentAttemptRecord | undefined
    let executionCalled = false

    try {
      attempt = await this.repository.createPaymentAttempt({
        id: createPaymentAttemptId(),
        paymentId: payment.id,
        rail: rail.name,
        status: 'CREATED',
      })
      assertPaymentStatusTransition(payment.status, 'ROUTING')
      payment = await this.repository.transitionPayment(
        payment.id,
        payment.status,
        'ROUTING',
      )

      const quote = await rail.quote(request)
      if (
        quote.amount.currency !== request.amount.currency ||
        quote.amount.atomicUnits !== request.amount.atomicUnits
      ) {
        throw new ExternalRailError('Payment rail returned an invalid quote')
      }
      const preparationContext = this.createPreparationContext({
        ...payment,
        payerPublicKey,
      })
      const prepared = await rail.prepare(request, preparationContext)
      attempt = await this.repository.updatePaymentAttempt(
        attempt.id,
        'CREATED',
        'PREPARED',
        this.durableAttemptFields(prepared),
      )

      const execute = rail.execute
      if (execute === undefined) {
        return {
          payment: await this.getPayment(payment.payerAccountId, payment.id),
          created: true,
        }
      }

      executionCalled = true
      const execution = await execute(prepared)
      return {
        payment: await this.applyExecutionResult(payment, attempt, execution),
        created: true,
      }
    } catch (error) {
      if (attempt === undefined) {
        throw error
      }
      if (executionCalled) {
        if (error instanceof ExternalRailError && error.kind === 'DETERMINISTIC') {
          await this.tryFinalizeFailure(payment, attempt, error)
          throw error
        }
        await this.tryMarkReconciling(payment, attempt)
        throw new ExternalRailError(
          'Payment execution outcome is ambiguous',
          error,
          'AMBIGUOUS',
          { payment_id: payment.id },
        )
      }
      await this.tryFinalizeFailure(payment, attempt, error)
      if (error instanceof InsufficientFundsError) {
        throw error
      }
      throw error instanceof ExternalRailError
        ? error
        : new ExternalRailError('Payment rail execution failed')
    }
  }

  private async executeRail(
    prepared: RailPreparedPayment,
    rail: PaymentRail,
  ): Promise<RailRecoveryResult> {
    const expectedExternalId = prepared.durableExecution?.expectedExternalId
    if (expectedExternalId !== undefined && rail.getStatus !== undefined) {
      return rail.getStatus(expectedExternalId)
    }
    if (rail.execute === undefined) {
      return { status: 'RECONCILING' }
    }
    return rail.execute(prepared)
  }

  private async applyExecutionResult(
    payment: PaymentRecord,
    attempt: PaymentAttemptRecord,
    execution: RailExecutionResult,
  ): Promise<PaymentRecord> {
    if (execution.status === 'CONFIRMED') {
      return this.repository.finalizeConfirmedPayment({
        paymentId: payment.id,
        expectedPaymentStatus: payment.status,
        attemptId: attempt.id,
        expectedAttemptStatus: attempt.status,
        ...(execution.railTransactionId === undefined
          ? {}
          : { railTransactionId: execution.railTransactionId }),
        ...(execution.confirmationMetadata === undefined
          ? {}
          : { confirmationMetadata: execution.confirmationMetadata }),
      })
    }
    if (execution.status === 'FAILED') {
      return this.repository.finalizeFailedPayment({
        paymentId: payment.id,
        expectedPaymentStatus: payment.status,
        attemptId: attempt.id,
        expectedAttemptStatus: attempt.status,
        failureCode: execution.failureCode ?? 'EXTERNAL_RAIL_FAILURE',
        failureMessageSafe:
          execution.failureMessageSafe ?? 'Payment rail execution failed',
      })
    }
    if (execution.status === 'SUBMITTED') {
      if (payment.status === 'SUBMITTED' && attempt.status === 'SUBMITTED') {
        return payment
      }
      return this.repository.markPaymentSubmitted({
        paymentId: payment.id,
        attemptId: attempt.id,
        expectedPaymentStatus: payment.status,
        expectedAttemptStatus: attempt.status,
        ...(execution.railTransactionId === undefined
          ? {}
          : { railTransactionId: execution.railTransactionId }),
      })
    }
    if (payment.status === 'RECONCILING' && attempt.status === 'RECONCILING') {
      return payment
    }
    return this.repository.markPaymentReconciling({
      paymentId: payment.id,
      attemptId: attempt.id,
      expectedPaymentStatus: payment.status,
      expectedAttemptStatus: attempt.status,
    })
  }

  private async tryMarkReconciling(
    payment: PaymentRecord,
    attempt: PaymentAttemptRecord,
  ): Promise<void> {
    try {
      await this.applyExecutionResult(payment, attempt, { status: 'RECONCILING' })
    } catch {
      // The original ambiguous error is safer than changing state without a DB commit.
    }
  }

  private async tryFinalizeFailure(
    payment: PaymentRecord,
    attempt: PaymentAttemptRecord,
    error: unknown,
  ): Promise<void> {
    try {
      await this.repository.finalizeFailedPayment({
        paymentId: payment.id,
        expectedPaymentStatus: payment.status,
        attemptId: attempt.id,
        expectedAttemptStatus: attempt.status,
        failureCode:
          error instanceof ExternalRailError ? error.code : 'EXTERNAL_RAIL_FAILURE',
        failureMessageSafe: 'Payment rail execution failed',
      })
    } catch {
      // A failed persistence transaction leaves the reservation recoverable.
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
    original_payment_id: payment.originalPaymentId,
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
