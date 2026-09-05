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
  readonly durableExecution?: RailDurableExecution
}

export interface RailDurableExecution {
  readonly serializedPayload: string
  readonly expectedExternalId: string
  readonly recoveryMetadata: string
}

export interface RailPreparationContext {
  readonly paymentId: string
  readonly payerAccountId: string
  readonly payerPublicKey: string
  readonly getPayerSecretKey: () => Promise<Uint8Array>
}

export type RailExecutionStatus = 'SUBMITTED' | 'CONFIRMED' | 'FAILED' | 'RECONCILING'

export interface RailExecutionResult {
  readonly status: RailExecutionStatus
  readonly railTransactionId?: string
  readonly confirmationMetadata?: string
  readonly failureCode?: string
  readonly failureMessageSafe?: string
}

export interface RailStatusResult {
  readonly status: RailExecutionStatus
  readonly railTransactionId?: string
  readonly confirmationMetadata?: string
  readonly failureCode?: string
  readonly failureMessageSafe?: string
}

export interface PaymentRail {
  readonly name: string
  canRoute(request: RailPaymentRequest): boolean
  readonly validateDestination?: (request: RailPaymentRequest) => void
  quote(request: RailPaymentRequest): Promise<RailQuote>
  prepare(
    request: RailPaymentRequest,
    context?: RailPreparationContext,
  ): Promise<RailPreparedPayment>
  /**
   * Execution is optional while a rail is only registered through its
   * preparation boundary. Task 04 will provide the Solana implementation.
   */
  readonly execute?: (prepared: RailPreparedPayment) => Promise<RailExecutionResult>
  readonly recover?: (
    prepared: RailPreparedPayment,
    context?: RailPreparationContext,
  ) => Promise<RailRecoveryResult>
  readonly getStatus?: (railTransactionId: string) => Promise<RailStatusResult>
}

export interface RailRecoveryResult extends RailExecutionResult {
  readonly replacement?: RailPreparedPayment
}
