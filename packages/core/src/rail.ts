import type { Currency, Money } from './money.js'
import type { PaymentOperation } from './payment.js'

export interface RailRecipientDestination {
  readonly rail: string
  readonly type: string
  readonly reference: string
}

export interface RailPaymentRequest {
  readonly operation: Extract<PaymentOperation, 'PAY' | 'SEND' | 'REFUND'>
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
  /**
   * The application has verified whether a destination is eligible for
   * platform-sponsored account creation. Rails must not infer that policy
   * from an arbitrary destination address.
   */
  readonly allowRecipientAtaCreation?: boolean
  readonly reserveSponsorship?: (lamports: bigint) => Promise<void>
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
   * Execution is optional for a preparation-only rail registration.
   * A production rail may implement it when its safe execution boundary exists.
   */
  readonly execute?: (prepared: RailPreparedPayment) => Promise<RailExecutionResult>
  readonly recover?: (
    prepared: RailPreparedPayment,
    context?: RailPreparationContext,
  ) => Promise<RailRecoveryResult>
  readonly getStatus?: (railTransactionId: string) => Promise<RailStatusResult>
}

export type RailRecoveryResult = RailExecutionResult
