import {
  InvalidStateError,
  PolicyDeniedError,
  UnsupportedCurrencyError,
  ValidationError,
  type PaymentKind,
} from '@agent-payment/core'
import type {
  AuthenticatedAccount,
  PaymentRecord,
  V2DatabaseRepository,
  V2PaymentView,
} from '@agent-payment/db'
import type { PaymentRequest, PaymentResult, PaymentServiceLike } from './payments.js'
import type { V2PaymentService } from './payments-v2.js'

/**
 * Keeps the retained v1 wire contract while routing every new operation
 * through the durable V2 orchestrator.
 */
export class V2PaymentServiceAdapter implements PaymentServiceLike {
  private readonly maxPageSize: number

  public constructor(
    private readonly service: V2PaymentService,
    private readonly repository: V2DatabaseRepository,
    maxPageSize = 100,
  ) {
    if (!Number.isInteger(maxPageSize) || maxPageSize < 1) {
      throw new InvalidStateError('Maximum page size must be a positive integer')
    }
    this.maxPageSize = maxPageSize
  }

  public async createPayment(
    account: AuthenticatedAccount,
    kind: PaymentKind,
    input: PaymentRequest,
    idempotencyKey: string,
    requestId?: string,
  ): Promise<PaymentResult> {
    const denominationId = await this.findDenominationId(input.currency)
    const result = await this.service.createPayment(
      account,
      {
        kind,
        recipientId: input.recipientId,
        amount: input.amount,
        denominationId,
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.externalReference === undefined
          ? {}
          : { externalReference: input.externalReference }),
      },
      normalizeIdempotencyKey(idempotencyKey),
      requestId ?? 'legacy-v1',
    )
    return this.toPaymentResult(result.view, result.created)
  }

  public async createRefund(
    account: AuthenticatedAccount,
    input: {
      readonly originalPaymentId: string
      readonly amount: string
      readonly currency: string
    },
    idempotencyKey: string,
    requestId?: string,
  ): Promise<PaymentResult> {
    const denominationId = await this.findDenominationId(input.currency)
    const result = await this.service.createRefund(
      account,
      input.originalPaymentId,
      { amount: input.amount, denominationId },
      normalizeIdempotencyKey(idempotencyKey),
      requestId ?? 'legacy-v1',
    )
    return this.toPaymentResult(result.view, result.created)
  }

  public async getPayment(
    accountId: string,
    paymentId: string,
  ): Promise<PaymentRecord> {
    return this.toPaymentRecord(await this.service.getPayment(accountId, paymentId))
  }

  public async listPaymentsPage(
    accountId: string,
    input: { readonly limit?: number; readonly cursor?: string },
  ): Promise<{
    readonly payments: readonly PaymentRecord[]
    readonly next_cursor: string | null
  }> {
    const limit = input.limit ?? 50
    if (!Number.isInteger(limit) || limit < 1 || limit > this.maxPageSize) {
      throw new ValidationError(
        `Payment limit must be an integer from 1 to ${this.maxPageSize}`,
      )
    }
    const cursor =
      input.cursor === undefined
        ? undefined
        : encodeV2Cursor(decodeCursor(input.cursor))
    const page = await this.service.listPayments(accountId, {
      limit,
      ...(cursor === undefined ? {} : { cursor }),
    })
    return {
      payments: await Promise.all(
        page.payments.map((payment) => this.toPaymentRecord(payment)),
      ),
      next_cursor:
        page.nextCursor === null
          ? null
          : encodeLegacyCursor(decodeCursor(page.nextCursor)),
    }
  }

  private async findDenominationId(currency: string): Promise<string> {
    const denomination = await this.repository.findDenominationBySymbol(currency)
    if (denomination === null) throw new UnsupportedCurrencyError(currency)
    return denomination.id
  }

  private async toPaymentResult(
    view: V2PaymentView,
    created: boolean,
  ): Promise<PaymentResult> {
    if (view.policyDecision === 'DENY') {
      throw new PolicyDeniedError('Payment was denied by policy', {
        payment_id: view.payment.id,
        reason_codes: view.reasonCodes.join(','),
      })
    }
    return { payment: await this.toPaymentRecord(view), created }
  }

  private async toPaymentRecord(view: V2PaymentView): Promise<PaymentRecord> {
    const payment = view.payment
    const destination = parseDestinationSnapshot(payment.destinationSnapshotJson)
    const payerPublicKey = await this.repository.findAccountPublicKey(
      payment.payerAccountId,
    )
    return {
      id: payment.id,
      payerAccountId: payment.payerAccountId,
      payerPublicKey,
      recipientId: payment.recipientId,
      kind: asPaymentKind(payment.kind),
      amountAtomic: payment.amountAtomic,
      currency: payment.currency,
      status: asPaymentStatus(payment.status),
      description: payment.description,
      externalReference: payment.externalReference,
      route: destination?.rail ?? null,
      createdAt: payment.createdAt,
      updatedAt: payment.updatedAt,
      confirmedAt: payment.confirmedAt,
      failedAt: payment.failedAt,
      failureCode: payment.failureCode,
      failureMessageSafe: payment.failureMessageSafe,
      destinationRail: destination?.rail ?? null,
      destinationType: destination?.destinationType ?? null,
      destinationReference: destination?.walletAddress ?? null,
      recipientManagedAccountId: payment.recipientManagedAccountId,
      originalPaymentId: payment.originalPaymentId,
      counterpartyAccountId: payment.recipientManagedAccountId,
      counterpartyAddress: destination?.walletAddress ?? null,
      lastRecoveryAttemptAt: null,
      nextRecoveryAt: null,
      recoveryCount: 0,
      stuckSince: null,
      denominationId: payment.denominationId,
      amountScale: payment.amountScale,
      routeId: payment.routeId,
      settlementAssetId: payment.settlementAssetId,
      destinationSnapshotJson: payment.destinationSnapshotJson,
      policyDecisionId: payment.policyDecisionId,
      approvalId: payment.approvalId,
      executionState: payment.executionState,
      settlementState: payment.settlementState,
      outcomeState: payment.outcomeState,
      rowVersion: payment.rowVersion,
    }
  }
}

function normalizeIdempotencyKey(value: string): string {
  const normalized = value.trim()
  if (normalized.length === 0 || normalized.length > 255) {
    throw new ValidationError('Idempotency-Key must contain 1 to 255 characters')
  }
  return normalized
}

function parseDestinationSnapshot(value: string | null): {
  readonly rail: string
  readonly destinationType: string
  readonly walletAddress: string
} | null {
  if (value === null) return null
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>
    if (
      typeof parsed.rail !== 'string' ||
      typeof parsed.destination_type !== 'string' ||
      typeof parsed.wallet_address !== 'string'
    ) {
      throw new Error('destination snapshot is incomplete')
    }
    return {
      rail: parsed.rail,
      destinationType: parsed.destination_type,
      walletAddress: parsed.wallet_address,
    }
  } catch {
    throw new InvalidStateError('Payment destination snapshot is corrupt')
  }
}

function asPaymentKind(value: string): PaymentKind {
  if (value === 'PAY' || value === 'SEND' || value === 'REFUND') return value
  throw new InvalidStateError('Payment kind is invalid')
}

function asPaymentStatus(value: string): PaymentRecord['status'] {
  const statuses: readonly PaymentRecord['status'][] = [
    'CREATED',
    'ROUTING',
    'AWAITING_APPROVAL',
    'REJECTED_BY_POLICY',
    'REJECTED',
    'SUBMITTED',
    'RECONCILING',
    'CONFIRMED',
    'PROVED_NO_EFFECT',
    'REVIEW_REQUIRED',
    'CLOSED_UNRESOLVED',
    'FAILED',
    'EXPIRED',
  ]
  if (statuses.includes(value as PaymentRecord['status'])) {
    return value as PaymentRecord['status']
  }
  throw new InvalidStateError('Payment status is invalid')
}

function decodeCursor(value: string): {
  readonly createdAt: Date
  readonly id: string
} {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as {
      created_at?: unknown
      createdAt?: unknown
      id?: unknown
    }
    const createdAtValue = parsed.created_at ?? parsed.createdAt
    if (typeof createdAtValue !== 'string' || typeof parsed.id !== 'string') {
      throw new Error('invalid cursor')
    }
    const createdAt = new Date(createdAtValue)
    if (Number.isNaN(createdAt.getTime()) || parsed.id.length === 0) {
      throw new Error('invalid cursor')
    }
    return { createdAt, id: parsed.id }
  } catch {
    throw new ValidationError('Payment cursor is invalid')
  }
}

function encodeV2Cursor(cursor: {
  readonly createdAt: Date
  readonly id: string
}): string {
  return Buffer.from(
    JSON.stringify({ created_at: cursor.createdAt.toISOString(), id: cursor.id }),
    'utf8',
  ).toString('base64url')
}

function encodeLegacyCursor(cursor: {
  readonly createdAt: Date
  readonly id: string
}): string {
  return Buffer.from(
    JSON.stringify({ createdAt: cursor.createdAt.toISOString(), id: cursor.id }),
    'utf8',
  ).toString('base64url')
}
