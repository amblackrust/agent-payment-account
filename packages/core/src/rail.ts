import type { Currency, Money } from './money.js'
import type { PaymentOperation } from './payment.js'

export interface RailRecipientDestination {
  readonly rail: string
  readonly type: string
  readonly reference: string
}

export interface RailPaymentRequest {
  readonly operation: Extract<PaymentOperation, 'PAY' | 'SEND'>
  readonly currency: Currency
  readonly amount: Money
  readonly payerAccountId: string
  readonly recipientId: string
  readonly destination: RailRecipientDestination
  readonly description?: string
  readonly externalReference?: string
}

export interface RailQuote {
  readonly rail: string
  readonly amount: Money
  readonly fee?: Money
}

export interface RailPreparedPayment {
  readonly rail: string
  readonly payloadSafe?: string
}

export type RailExecutionStatus = 'SUBMITTED' | 'CONFIRMED' | 'FAILED'

export interface RailExecutionResult {
  readonly status: RailExecutionStatus
  readonly railTransactionId?: string
  readonly failureCode?: string
  readonly failureMessageSafe?: string
}

export interface RailStatusResult {
  readonly status: RailExecutionStatus
  readonly railTransactionId?: string
}

export interface PaymentRail {
  readonly name: string
  canRoute(request: RailPaymentRequest): boolean
  quote(request: RailPaymentRequest): Promise<RailQuote>
  prepare(request: RailPaymentRequest): Promise<RailPreparedPayment>
  execute(prepared: RailPreparedPayment): Promise<RailExecutionResult>
  getStatus(railTransactionId: string): Promise<RailStatusResult>
}
