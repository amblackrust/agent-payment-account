import {
  apiErrorResponseSchema,
  balanceResponseSchema,
  paymentResponseSchema,
  receiveResponseSchema,
  transactionListResponseSchema,
  transactionResponseSchema,
  v2ErrorEnvelopeSchema,
  v2AccountResponseSchema,
  v2BalanceResponseSchema,
  v2FundingDestinationResponseSchema,
  v2HistoryResponseSchema,
  v2PaymentCreateRequestSchema,
  v2PaymentListResponseSchema,
  v2PaymentResponseSchema,
  v2RecipientResponseSchema,
  v2RecipientListResponseSchema,
  v2ReceiveResponseSchema,
  v2ReceiveListResponseSchema,
  type ApiErrorResponse,
  type BalanceResponse,
  type PaymentResponse,
  type ReceiveResponse,
  type TransactionListResponse,
  type TransactionResponse,
  type V2PaymentCreateRequest,
  type V2PaymentListResponse,
  type V2PaymentResponse,
  type V2AccountResponse,
  type V2BalanceResponse,
  type V2FundingDestinationResponse,
  type V2HistoryResponse,
  type V2RecipientResponse,
  type V2RecipientListResponse,
  type V2ReceiveResponse,
  type V2ReceiveListResponse,
} from '@agent-payment/contracts'

export type Currency = 'USD'

export type PaymentKind = 'PAY' | 'SEND' | 'REFUND'
export type TransactionKind = PaymentKind | 'RECEIVE'
export type PaymentStatus =
  | 'CREATED'
  | 'ROUTING'
  | 'AWAITING_APPROVAL'
  | 'REJECTED_BY_POLICY'
  | 'REJECTED'
  | 'SUBMITTED'
  | 'RECONCILING'
  | 'CONFIRMED'
  | 'PROVED_NO_EFFECT'
  | 'REVIEW_REQUIRED'
  | 'CLOSED_UNRESOLVED'
  | 'FAILED'
  | 'EXPIRED'

export type TransactionDirection = 'INCOMING' | 'OUTGOING'

export interface Balance {
  readonly currency: Currency
  readonly settled: string
  readonly pendingOutgoing: string
  readonly available: string
}

export interface Payment {
  readonly id: string
  readonly recipientId: string | null
  readonly kind: PaymentKind
  readonly amount: string
  readonly currency: Currency
  readonly status: PaymentStatus
  readonly description: string | null
  readonly externalReference: string | null
  readonly route: string | null
  readonly createdAt: string
  readonly updatedAt: string
  readonly confirmedAt: string | null
  readonly failedAt: string | null
  readonly failureCode: string | null
  readonly failureMessage: string | null
  readonly originalPaymentId: string | null
}

export interface ReceiveRequest {
  readonly id: string
  readonly accountId: string
  readonly amount: string | null
  readonly currency: Currency
  readonly reference: string
  readonly status: 'OPEN' | 'PAID' | 'EXPIRED' | 'CANCELLED'
  readonly createdAt: string
  readonly expiresAt: string | null
  readonly paidAt: string | null
  readonly destination: {
    readonly type: 'external_transfer_target'
    readonly reference: string
  }
  readonly settlement: {
    readonly owner: string
    readonly tokenAccount: string
    readonly mint: string
  }
}

export interface PaymentInput {
  readonly recipientId: string
  readonly amount: string
  readonly currency?: Currency
  readonly description?: string
  readonly externalReference?: string
}

export type V2PaymentStatus = V2PaymentResponse['status']

export interface V2Payment {
  readonly id: string
  readonly kind: PaymentKind
  readonly recipientId: string | null
  readonly description: string | null
  readonly externalReference: string | null
  readonly amount: string
  readonly denominationId: string
  readonly denominationSymbol: string
  readonly status: V2PaymentStatus
  readonly policyDecision: 'ALLOW' | 'REQUIRE_APPROVAL' | 'DENY'
  readonly policyReasonCodes: readonly string[]
  readonly approvalState:
    'NOT_REQUIRED' | 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED'
  readonly attemptCount: number
  readonly reservationStatus: 'NONE' | 'HELD' | 'RELEASED' | 'CONSUMED'
  readonly routeId: string | null
  readonly routeSelectionReason: string | null
  readonly settlementAssetId: string | null
  readonly executionState: string
  readonly settlementState: string
  readonly outcomeState: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly confirmedAt: string | null
  readonly failureCode: string | null
  readonly failureMessage: string | null
  readonly originalPaymentId: string | null
}

export interface V2PaymentInput {
  readonly kind?: PaymentKind
  readonly recipientId: string
  readonly amount: string
  readonly denominationId: string
  readonly description?: string
  readonly externalReference?: string
  readonly routePreference?: string
}

export interface V2PaymentPage {
  readonly payments: readonly V2Payment[]
  readonly nextCursor: string | null
}

export interface V2RefundInput {
  readonly amount: string
  readonly denominationId: string
  readonly description?: string
  readonly externalReference?: string
  readonly routePreference?: string
}

export interface V2Account {
  readonly id: string
  readonly name: string
  readonly status: V2AccountResponse['status']
  readonly solanaPublicKey: string
  readonly workspaceId: string | null
  readonly runtimeVersion: string | null
  readonly provisioningFailureCode: string | null
  readonly disabledAt: string | null
  readonly disabledReason: string | null
  readonly rowVersion: number
  readonly createdAt: string
  readonly updatedAt: string
}

export interface V2Balance {
  readonly accountId: string
  readonly denominationId: string
  readonly settled: string
  readonly reserved: string
  readonly spendable: string
  readonly observedAt: string
  readonly degraded: boolean
}

export interface V2FundingDestination {
  readonly id: string
  readonly accountId: string
  readonly routeId: string
  readonly network: string
  readonly assetId: string
  readonly destination: string
  readonly readiness: 'READY' | 'PENDING' | 'DEGRADED' | 'UNAVAILABLE'
  readonly senderConstraints: Readonly<Record<string, unknown>>
  readonly lastValidatedAt: string | null
  readonly lastFailureCode: string | null
}

export interface V2ReceiveRequest {
  readonly id: string
  readonly accountId: string
  readonly amount: string | null
  readonly denominationId: string | null
  readonly currency: string
  readonly reference: string
  readonly status: 'OPEN' | 'PAID' | 'EXPIRED' | 'CANCELLED'
  readonly createdAt: string
  readonly expiresAt: string | null
  readonly paidAt: string | null
  readonly destination: ReceiveRequest['destination']
  readonly settlement: ReceiveRequest['settlement']
}

export interface V2ReceiveInput {
  readonly denominationId: string
  readonly amount?: string
  readonly reference?: string
  readonly expiresAt?: string
}

export interface V2HistoryItem {
  readonly id: string
  readonly direction: 'INCOMING' | 'OUTGOING'
  readonly kind: string
  readonly status: string
  readonly amount: string
  readonly denominationId: string | null
  readonly currency: string
  readonly recipientId: string | null
  readonly externalId: string | null
  readonly occurredAt: string
}

export interface V2HistoryPage {
  readonly items: readonly V2HistoryItem[]
  readonly nextCursor: string | null
}

export interface V2RecipientDestination {
  readonly id: string
  readonly rail: string
  readonly type: string
  readonly walletAddress: string
}

export interface V2Recipient {
  readonly id: string
  readonly displayName: string
  readonly type: string
  readonly managedAccountId: string | null
  readonly destinations: readonly V2RecipientDestination[]
  readonly createdAt: string
  readonly updatedAt: string
}

export interface V2RecipientInput {
  readonly displayName: string
  readonly type: string
  readonly managedAccountId?: string
  readonly destination: {
    readonly type: 'SOLANA_SPL'
    readonly walletAddress: string
  }
}

export interface V2RecipientUpdateInput {
  readonly displayName?: string
  readonly type?: string
  readonly managedAccountId?: string | null
  readonly rowVersion: number
  readonly destination?: {
    readonly id: string
    readonly type: 'SOLANA_SPL'
    readonly walletAddress: string
  }
}

export interface V2RecipientPage {
  readonly recipients: readonly V2Recipient[]
  readonly nextCursor: string | null
}

export interface RefundInput {
  readonly originalPaymentId: string
  readonly amount: string
  readonly currency?: Currency
}

export interface ReceiveInput {
  readonly amount?: string
  readonly currency?: Currency
  readonly reference?: string
  readonly expiresAt?: string
}

export interface Counterparty {
  readonly recipientId: string | null
  readonly displayName: string | null
  readonly accountId: string | null
  readonly address: string | null
}

export interface Transaction {
  readonly id: string
  readonly direction: TransactionDirection
  readonly kind: TransactionKind
  readonly amount: string
  readonly currency: Currency
  readonly status: PaymentStatus | 'CONFIRMED'
  readonly counterparty: Counterparty
  readonly createdAt: string
  readonly updatedAt: string
  readonly confirmedAt: string | null
  readonly signature: string | null
}

export interface TransactionPage {
  readonly transactions: readonly Transaction[]
  readonly nextCursor: string | null
}

export interface IdempotencyOptions {
  readonly idempotencyKey?: string
}

export interface AgentPaymentAccountOptions {
  readonly baseUrl: string
  readonly apiKey: string
  readonly timeoutMs?: number
  readonly retryCount?: number
  readonly fetch?: typeof globalThis.fetch
}

export type SdkErrorCode =
  | 'AUTHENTICATION_ERROR'
  | 'VALIDATION_ERROR'
  | 'INSUFFICIENT_FUNDS'
  | 'RECIPIENT_ERROR'
  | 'UNSUPPORTED_RAIL'
  | 'CONFLICT'
  | 'REFUND_NOT_SUPPORTED'
  | 'PAYMENT_PENDING'
  | 'EXTERNAL_SERVICE_ERROR'
  | 'AUTHORIZATION_ERROR'
  | 'NOT_FOUND'
  | 'IDEMPOTENCY_CONFLICT'
  | 'POLICY_DENIED'
  | 'APPROVAL_REQUIRED'
  | 'REVIEW_REQUIRED'
  | 'INVALID_STATE'
  | 'RATE_LIMITED'

export class SdkError extends Error {
  public readonly code: SdkErrorCode
  public readonly statusCode: number | undefined

  public constructor(
    code: SdkErrorCode,
    message: string,
    statusCode?: number,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'SdkError'
    this.code = code
    this.statusCode = statusCode
  }
}

export class AuthenticationError extends SdkError {
  public constructor(message = 'Authentication failed') {
    super('AUTHENTICATION_ERROR', message, 401)
    this.name = 'AuthenticationError'
  }
}

export class ValidationError extends SdkError {
  public constructor(message = 'Request validation failed', statusCode = 422) {
    super('VALIDATION_ERROR', message, statusCode)
    this.name = 'ValidationError'
  }
}

export class InsufficientFundsError extends SdkError {
  public constructor(message = 'Insufficient funds') {
    super('INSUFFICIENT_FUNDS', message, 409)
    this.name = 'InsufficientFundsError'
  }
}

export class RecipientError extends SdkError {
  public constructor(message = 'Recipient could not be resolved') {
    super('RECIPIENT_ERROR', message, 422)
    this.name = 'RecipientError'
  }
}

export class UnsupportedRailError extends SdkError {
  public constructor(message = 'Payment rail is unsupported') {
    super('UNSUPPORTED_RAIL', message, 422)
    this.name = 'UnsupportedRailError'
  }
}

export class ConflictError extends SdkError {
  public constructor(message = 'Request conflicts with the current resource state') {
    super('CONFLICT', message, 409)
    this.name = 'ConflictError'
  }
}

export class RefundNotSupportedError extends SdkError {
  public constructor(message = 'Refund is not supported for this payment') {
    super('REFUND_NOT_SUPPORTED', message, 422)
    this.name = 'RefundNotSupportedError'
  }
}

export class PaymentPendingError extends SdkError {
  public readonly idempotencyKey: string
  public readonly paymentId?: string
  public readonly requestId?: string

  public constructor(
    idempotencyKey: string,
    message = 'Payment outcome is pending; poll the payment or retry with the same idempotency key',
    paymentId?: string,
    requestId?: string,
  ) {
    super('PAYMENT_PENDING', message)
    this.name = 'PaymentPendingError'
    this.idempotencyKey = idempotencyKey
    if (paymentId !== undefined) this.paymentId = paymentId
    if (requestId !== undefined) this.requestId = requestId
  }
}

export class ExternalServiceError extends SdkError {
  public constructor(
    message = 'Payment service is unavailable',
    statusCode?: number,
    options?: ErrorOptions,
  ) {
    super('EXTERNAL_SERVICE_ERROR', message, statusCode, options)
    this.name = 'ExternalServiceError'
  }
}

export class AuthorizationError extends SdkError {
  public constructor(message = 'The actor is not authorized for this operation') {
    super('AUTHORIZATION_ERROR', message, 403)
    this.name = 'AuthorizationError'
  }
}

export class NotFoundError extends SdkError {
  public constructor(message = 'Resource was not found') {
    super('NOT_FOUND', message, 404)
    this.name = 'NotFoundError'
  }
}

export class IdempotencyConflictError extends SdkError {
  public constructor(message = 'Idempotency key was already used for another request') {
    super('IDEMPOTENCY_CONFLICT', message, 409)
    this.name = 'IdempotencyConflictError'
  }
}

export class PolicyDeniedError extends SdkError {
  public readonly paymentId: string | undefined

  public constructor(message = 'Payment was denied by policy', paymentId?: string) {
    super('POLICY_DENIED', message, 403)
    this.name = 'PolicyDeniedError'
    this.paymentId = paymentId
  }
}

export class ApprovalRequiredError extends SdkError {
  public constructor(message = 'Payment requires approval') {
    super('APPROVAL_REQUIRED', message, 409)
    this.name = 'ApprovalRequiredError'
  }
}

export class ReviewRequiredError extends SdkError {
  public constructor(message = 'Payment requires operational review') {
    super('REVIEW_REQUIRED', message, 409)
    this.name = 'ReviewRequiredError'
  }
}

export class InvalidStateError extends SdkError {
  public constructor(message = 'The resource is in an invalid state') {
    super('INVALID_STATE', message, 409)
    this.name = 'InvalidStateError'
  }
}

export class RateLimitedError extends SdkError {
  public constructor(message = 'Request rate limit exceeded') {
    super('RATE_LIMITED', message, 429)
    this.name = 'RateLimitedError'
  }
}

class HttpResponseExternalServiceError extends ExternalServiceError {
  public readonly fromHttpResponse = true
}

function parseContract<T>(
  value: unknown,
  schema: {
    safeParse(input: unknown): { success: true; data: T } | { success: false }
  },
  message: string,
): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new ExternalServiceError(message)
  return result.data
}

function parseBalance(value: unknown): Balance {
  const response = parseContract<BalanceResponse>(
    value,
    balanceResponseSchema,
    'API returned an invalid balance response',
  )
  return {
    currency: response.currency,
    settled: response.settled,
    pendingOutgoing: response.pending_outgoing,
    available: response.available,
  }
}

function parsePayment(value: unknown): Payment {
  const response = parseContract<PaymentResponse>(
    value,
    paymentResponseSchema,
    'API returned an invalid payment response',
  )
  return {
    id: response.id,
    recipientId: response.recipient_id,
    kind: response.kind,
    amount: response.amount,
    currency: response.currency,
    status: response.status,
    description: response.description,
    externalReference: response.external_reference,
    route: response.route,
    createdAt: response.created_at,
    updatedAt: response.updated_at,
    confirmedAt: response.confirmed_at,
    failedAt: response.failed_at,
    failureCode: response.failure_code,
    failureMessage: response.failure_message,
    originalPaymentId: response.original_payment_id,
  }
}

function parseReceive(value: unknown): ReceiveRequest {
  const response = parseContract<ReceiveResponse>(
    value,
    receiveResponseSchema,
    'API returned an invalid receive response',
  )
  return {
    id: response.id,
    accountId: response.account_id,
    amount: response.amount,
    currency: response.currency,
    reference: response.reference,
    status: response.status,
    createdAt: response.created_at,
    expiresAt: response.expires_at,
    paidAt: response.paid_at,
    destination: {
      type: response.destination.type,
      reference: response.destination.reference,
    },
    settlement: {
      owner: response.settlement.owner,
      tokenAccount: response.settlement.token_account,
      mint: response.settlement.mint,
    },
  }
}

function parseTransaction(value: unknown): Transaction {
  const response = parseContract<TransactionResponse>(
    value,
    transactionResponseSchema,
    'API returned an invalid transaction response',
  )
  return {
    id: response.id,
    direction: response.direction,
    kind: response.kind,
    amount: response.amount,
    currency: response.currency,
    status: response.status,
    counterparty: {
      recipientId: response.counterparty.recipient_id,
      displayName: response.counterparty.display_name,
      accountId: response.counterparty.account_id,
      address: response.counterparty.address,
    },
    createdAt: response.created_at,
    updatedAt: response.updated_at,
    confirmedAt: response.confirmed_at,
    signature: response.signature,
  }
}

function parseTransactionListPage(value: unknown): TransactionPage {
  const response = parseContract<TransactionListResponse>(
    value,
    transactionListResponseSchema,
    'API returned an invalid transaction list response',
  )
  return {
    transactions: response.transactions.map(parseTransaction),
    nextCursor: response.next_cursor,
  }
}

function parseV2Payment(value: unknown): V2Payment {
  const response = parseContract<V2PaymentResponse>(
    value,
    v2PaymentResponseSchema,
    'API returned an invalid V2 payment response',
  )
  return {
    id: response.id,
    kind: response.kind,
    recipientId: response.recipient_id,
    description: response.description,
    externalReference: response.external_reference,
    amount: response.amount,
    denominationId: response.denomination_id,
    denominationSymbol: response.denomination_symbol,
    status: response.status,
    policyDecision: response.policy_decision,
    policyReasonCodes: response.policy_reason_codes,
    approvalState: response.approval_state,
    attemptCount: response.attempt_count,
    reservationStatus: response.reservation_status,
    routeId: response.route_id,
    routeSelectionReason: response.route_selection_reason,
    settlementAssetId: response.settlement_asset_id,
    executionState: response.execution_state,
    settlementState: response.settlement_state,
    outcomeState: response.outcome_state,
    createdAt: response.created_at,
    updatedAt: response.updated_at,
    confirmedAt: response.confirmed_at,
    failureCode: response.failure_code,
    failureMessage: response.failure_message,
    originalPaymentId: response.original_payment_id,
  }
}

function parseV2PaymentPage(value: unknown): V2PaymentPage {
  const response = parseContract<V2PaymentListResponse>(
    value,
    v2PaymentListResponseSchema,
    'API returned an invalid V2 payment list response',
  )
  return {
    payments: response.payments.map(parseV2Payment),
    nextCursor: response.next_cursor,
  }
}

function parseV2Account(value: unknown): V2Account {
  const response = parseContract<V2AccountResponse>(
    value,
    v2AccountResponseSchema,
    'API returned an invalid V2 account response',
  )
  return {
    id: response.id,
    name: response.name,
    status: response.status,
    solanaPublicKey: response.solana_public_key,
    workspaceId: response.workspace_id,
    runtimeVersion: response.runtime_version,
    provisioningFailureCode: response.provisioning_failure_code,
    disabledAt: response.disabled_at,
    disabledReason: response.disabled_reason,
    rowVersion: response.row_version,
    createdAt: response.created_at,
    updatedAt: response.updated_at,
  }
}

function parseV2Balance(value: unknown): V2Balance {
  const response = parseContract<V2BalanceResponse>(
    value,
    v2BalanceResponseSchema,
    'API returned an invalid V2 balance response',
  )
  return {
    accountId: response.account_id,
    denominationId: response.denomination_id,
    settled: response.settled,
    reserved: response.reserved,
    spendable: response.spendable,
    observedAt: response.observed_at,
    degraded: response.degraded,
  }
}

function parseV2FundingDestination(value: unknown): V2FundingDestination {
  const response = parseContract<V2FundingDestinationResponse>(
    value,
    v2FundingDestinationResponseSchema,
    'API returned an invalid V2 funding destination response',
  )
  return {
    id: response.id,
    accountId: response.account_id,
    routeId: response.route_id,
    network: response.network,
    assetId: response.asset_id,
    destination: response.destination,
    readiness: response.readiness,
    senderConstraints: response.sender_constraints,
    lastValidatedAt: response.last_validated_at,
    lastFailureCode: response.last_failure_code,
  }
}

function parseV2Receive(value: unknown): V2ReceiveRequest {
  const response = parseContract<V2ReceiveResponse>(
    value,
    v2ReceiveResponseSchema,
    'API returned an invalid V2 receive response',
  )
  return {
    id: response.id,
    accountId: response.account_id,
    amount: response.amount,
    denominationId: response.denomination_id,
    currency: response.currency,
    reference: response.reference,
    status: response.status,
    createdAt: response.created_at,
    expiresAt: response.expires_at,
    paidAt: response.paid_at,
    destination: {
      type: 'external_transfer_target',
      reference: response.destination.reference,
    },
    settlement: {
      owner: response.settlement.owner,
      tokenAccount: response.settlement.token_account,
      mint: response.settlement.mint,
    },
  }
}

function parseV2ReceivePage(value: unknown): {
  readonly receiveRequests: readonly V2ReceiveRequest[]
  readonly nextCursor: string | null
} {
  const response = parseContract<V2ReceiveListResponse>(
    value,
    v2ReceiveListResponseSchema,
    'API returned an invalid V2 receive list response',
  )
  return {
    receiveRequests: response.receive_requests.map(parseV2Receive),
    nextCursor: response.next_cursor,
  }
}

function parseV2Recipient(value: unknown): V2Recipient {
  const response = parseContract<V2RecipientResponse>(
    value,
    v2RecipientResponseSchema,
    'API returned an invalid V2 recipient response',
  )
  return {
    id: response.id,
    displayName: response.display_name,
    type: response.type,
    managedAccountId: response.managed_account_id,
    destinations: response.destinations.map((destination) => ({
      id: destination.id,
      rail: destination.rail,
      type: destination.type,
      walletAddress: destination.wallet_address,
    })),
    createdAt: response.created_at,
    updatedAt: response.updated_at,
  }
}

function parseV2RecipientPage(value: unknown): V2RecipientPage {
  const response = parseContract<V2RecipientListResponse>(
    value,
    v2RecipientListResponseSchema,
    'API returned an invalid V2 recipient list response',
  )
  return {
    recipients: response.recipients.map(parseV2Recipient),
    nextCursor: response.next_cursor,
  }
}

function parseV2History(value: unknown): V2HistoryPage {
  const response = parseContract<V2HistoryResponse>(
    value,
    v2HistoryResponseSchema,
    'API returned an invalid V2 history response',
  )
  return {
    items: response.items.map((item) => ({
      id: item.id,
      direction: item.direction,
      kind: item.kind,
      status: item.status,
      amount: item.amount,
      denominationId: item.denomination_id,
      currency: item.currency,
      recipientId: item.recipient_id,
      externalId: item.external_id,
      occurredAt: item.occurred_at,
    })),
    nextCursor: response.next_cursor,
  }
}

function generatedIdempotencyKey(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return `sdk_${globalThis.crypto.randomUUID()}`
  }
  if (typeof globalThis.crypto?.getRandomValues !== 'function') {
    throw new ExternalServiceError(
      'Secure randomness is required to generate an idempotency key',
    )
  }
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  return `sdk_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeIdempotencyKey(value: string | undefined): string {
  const key = value?.trim() || generatedIdempotencyKey()
  if (key.length === 0 || key.length > 255) {
    throw new ValidationError('Idempotency key must contain 1 to 255 characters')
  }
  return key
}

function unwrapIdempotencyOptions(
  options: string | IdempotencyOptions | undefined,
): string {
  return normalizeIdempotencyKey(
    typeof options === 'string' ? options : options?.idempotencyKey,
  )
}

function toApiPaymentInput(input: PaymentInput) {
  return {
    recipient_id: input.recipientId,
    amount: input.amount,
    currency: input.currency ?? 'USD',
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(input.externalReference === undefined
      ? {}
      : { external_reference: input.externalReference }),
  }
}

function toApiV2PaymentInput(input: V2PaymentInput): V2PaymentCreateRequest {
  const result = v2PaymentCreateRequestSchema.safeParse({
    kind: input.kind ?? 'PAY',
    recipient_id: input.recipientId,
    amount: input.amount,
    denomination_id: input.denominationId,
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(input.externalReference === undefined
      ? {}
      : { external_reference: input.externalReference }),
    ...(input.routePreference === undefined
      ? {}
      : { route_preference: input.routePreference }),
  })
  if (!result.success) throw new ValidationError('V2 payment input is invalid')
  return result.data
}

function toApiRefundInput(input: RefundInput) {
  return {
    original_payment_id: input.originalPaymentId,
    amount: input.amount,
    currency: input.currency ?? 'USD',
  }
}

export class AgentPaymentAccount {
  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly timeoutMs: number
  private readonly retryCount: number
  private readonly fetchImpl: typeof globalThis.fetch

  public constructor(options: AgentPaymentAccountOptions) {
    if (options.apiKey.trim().length === 0) {
      throw new ValidationError('API key is required')
    }
    let baseUrl: URL
    try {
      baseUrl = new URL(options.baseUrl)
    } catch {
      throw new ValidationError('baseUrl must be a valid URL')
    }
    if (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') {
      throw new ValidationError('baseUrl must use http or https')
    }
    if (baseUrl.search.length > 0 || baseUrl.hash.length > 0) {
      throw new ValidationError('baseUrl must not contain a query or fragment')
    }
    if (
      options.timeoutMs !== undefined &&
      (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0)
    ) {
      throw new ValidationError('timeoutMs must be a positive integer')
    }
    if (
      options.retryCount !== undefined &&
      (!Number.isInteger(options.retryCount) || options.retryCount < 0)
    ) {
      throw new ValidationError('retryCount must be a non-negative integer')
    }
    const fetchImpl = options.fetch ?? globalThis.fetch
    if (typeof fetchImpl !== 'function') {
      throw new ExternalServiceError('A fetch implementation is required')
    }
    this.baseUrl = baseUrl.toString().replace(/\/+$/u, '')
    this.apiKey = options.apiKey
    this.timeoutMs = options.timeoutMs ?? 10_000
    this.retryCount = options.retryCount ?? 1
    this.fetchImpl = fetchImpl.bind(globalThis)
  }

  public async getBalance(): Promise<Balance> {
    return parseBalance(await this.request('/v1/balance', 'GET'))
  }

  public async getAccount(accountId: string): Promise<V2Account> {
    return parseV2Account(
      await this.request(`/v2/accounts/${encodeURIComponent(accountId)}`, 'GET'),
    )
  }

  public async getBalanceV2(denominationId: string): Promise<V2Balance> {
    return parseV2Balance(
      await this.request(
        `/v2/balance?denomination_id=${encodeURIComponent(denominationId)}`,
        'GET',
      ),
    )
  }

  public async getFundingDestinationV2(
    routeId?: string,
  ): Promise<V2FundingDestination> {
    const suffix =
      routeId === undefined ? '' : `?route_id=${encodeURIComponent(routeId)}`
    return parseV2FundingDestination(
      await this.request(`/v2/funding-destination${suffix}`, 'GET'),
    )
  }

  public async createRecipientV2(input: V2RecipientInput): Promise<V2Recipient> {
    return parseV2Recipient(
      await this.request('/v2/recipients', 'POST', {
        display_name: input.displayName,
        type: input.type,
        ...(input.managedAccountId === undefined
          ? {}
          : { managed_account_id: input.managedAccountId }),
        destination: {
          type: input.destination.type,
          wallet_address: input.destination.walletAddress,
        },
      }),
    )
  }

  public async listRecipientsV2Page(
    input: {
      readonly limit?: number
      readonly cursor?: string
    } = {},
  ): Promise<V2RecipientPage> {
    const query = new URLSearchParams()
    if (input.limit !== undefined) query.set('limit', String(input.limit))
    if (input.cursor !== undefined) query.set('cursor', input.cursor)
    const suffix = query.toString()
    return parseV2RecipientPage(
      await this.request(`/v2/recipients${suffix === '' ? '' : `?${suffix}`}`, 'GET'),
    )
  }

  public async getRecipientV2(recipientId: string): Promise<V2Recipient> {
    return parseV2Recipient(
      await this.request(`/v2/recipients/${encodeURIComponent(recipientId)}`, 'GET'),
    )
  }

  public async updateRecipientV2(
    recipientId: string,
    input: V2RecipientUpdateInput,
  ): Promise<V2Recipient> {
    return parseV2Recipient(
      await this.request(`/v2/recipients/${encodeURIComponent(recipientId)}`, 'PATCH', {
        ...(input.displayName === undefined ? {} : { display_name: input.displayName }),
        ...(input.type === undefined ? {} : { type: input.type }),
        ...(input.managedAccountId === undefined
          ? {}
          : { managed_account_id: input.managedAccountId }),
        row_version: input.rowVersion,
        ...(input.destination === undefined
          ? {}
          : {
              destination: {
                id: input.destination.id,
                type: input.destination.type,
                wallet_address: input.destination.walletAddress,
              },
            }),
      }),
    )
  }

  public async archiveRecipientV2(
    recipientId: string,
    rowVersion: number,
  ): Promise<void> {
    await this.request(
      `/v2/recipients/${encodeURIComponent(recipientId)}/archive`,
      'POST',
      { row_version: rowVersion },
    )
  }

  public async createReceiveV2(
    input: V2ReceiveInput,
    options?: string | IdempotencyOptions,
  ): Promise<V2ReceiveRequest> {
    const idempotencyKey = unwrapIdempotencyOptions(options)
    return parseV2Receive(
      await this.request(
        '/v2/receive-requests',
        'POST',
        {
          denomination_id: input.denominationId,
          ...(input.amount === undefined ? {} : { amount: input.amount }),
          ...(input.reference === undefined ? {} : { reference: input.reference }),
          ...(input.expiresAt === undefined ? {} : { expires_at: input.expiresAt }),
        },
        idempotencyKey,
      ),
    )
  }

  public async getReceiveV2(receiveId: string): Promise<V2ReceiveRequest> {
    return parseV2Receive(
      await this.request(
        `/v2/receive-requests/${encodeURIComponent(receiveId)}`,
        'GET',
      ),
    )
  }

  public async listReceiveV2Page(
    input: {
      readonly limit?: number
      readonly cursor?: string
    } = {},
  ): Promise<{
    readonly receiveRequests: readonly V2ReceiveRequest[]
    readonly nextCursor: string | null
  }> {
    const query = new URLSearchParams()
    if (input.limit !== undefined) query.set('limit', String(input.limit))
    if (input.cursor !== undefined) query.set('cursor', input.cursor)
    return parseV2ReceivePage(
      await this.request(
        `/v2/receive-requests${query.size === 0 ? '' : `?${query.toString()}`}`,
        'GET',
      ),
    )
  }

  public async cancelReceiveV2(receiveId: string): Promise<V2ReceiveRequest> {
    return parseV2Receive(
      await this.request(
        `/v2/receive-requests/${encodeURIComponent(receiveId)}/cancel`,
        'POST',
      ),
    )
  }

  public async listHistoryV2Page(
    input: {
      readonly limit?: number
      readonly cursor?: string
    } = {},
  ): Promise<V2HistoryPage> {
    const query = new URLSearchParams()
    if (input.limit !== undefined) query.set('limit', String(input.limit))
    if (input.cursor !== undefined) query.set('cursor', input.cursor)
    return parseV2History(
      await this.request(
        `/v2/history${query.size === 0 ? '' : `?${query.toString()}`}`,
        'GET',
      ),
    )
  }

  public async createPaymentV2(
    input: V2PaymentInput,
    options?: string | IdempotencyOptions,
  ): Promise<V2Payment> {
    const idempotencyKey = unwrapIdempotencyOptions(options)
    return this.postMoney(
      '/v2/payments',
      toApiV2PaymentInput(input),
      idempotencyKey,
      parseV2Payment,
    )
  }

  public async getPaymentV2(paymentId: string): Promise<V2Payment> {
    return parseV2Payment(
      await this.request(`/v2/payments/${encodeURIComponent(paymentId)}`, 'GET'),
    )
  }

  public async listPaymentsV2Page(
    input: {
      readonly limit?: number
      readonly cursor?: string
      readonly status?: V2PaymentStatus
      readonly outcomeState?: string
      readonly recipientId?: string
      readonly denominationId?: string
    } = {},
  ): Promise<V2PaymentPage> {
    const query = new URLSearchParams()
    if (input.limit !== undefined) query.set('limit', String(input.limit))
    if (input.cursor !== undefined) query.set('cursor', input.cursor)
    if (input.status !== undefined) query.set('status', input.status)
    if (input.outcomeState !== undefined) query.set('outcome_state', input.outcomeState)
    if (input.recipientId !== undefined) query.set('recipient_id', input.recipientId)
    if (input.denominationId !== undefined)
      query.set('denomination_id', input.denominationId)
    const suffix = query.toString()
    return parseV2PaymentPage(
      await this.request(`/v2/payments${suffix === '' ? '' : `?${suffix}`}`, 'GET'),
    )
  }

  public async listPaymentsV2(): Promise<readonly V2Payment[]> {
    const payments: V2Payment[] = []
    let cursor: string | undefined
    do {
      const page = await this.listPaymentsV2Page({
        ...(cursor === undefined ? {} : { cursor }),
      })
      payments.push(...page.payments)
      cursor = page.nextCursor ?? undefined
    } while (cursor !== undefined)
    return payments
  }

  public async refundV2(
    paymentId: string,
    input: V2RefundInput,
    options?: string | IdempotencyOptions,
  ): Promise<V2Payment> {
    const idempotencyKey = unwrapIdempotencyOptions(options)
    const body = {
      amount: input.amount,
      denomination_id: input.denominationId,
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.externalReference === undefined
        ? {}
        : { external_reference: input.externalReference }),
      ...(input.routePreference === undefined
        ? {}
        : { route_preference: input.routePreference }),
    }
    return this.postMoney(
      `/v2/payments/${encodeURIComponent(paymentId)}/refunds`,
      body,
      idempotencyKey,
      parseV2Payment,
    )
  }

  public async pay(
    input: PaymentInput,
    options?: string | IdempotencyOptions,
  ): Promise<Payment> {
    const idempotencyKey = unwrapIdempotencyOptions(options)
    return this.postMoney(
      '/v1/pay',
      toApiPaymentInput(input),
      idempotencyKey,
      parsePayment,
    )
  }

  public async send(
    input: PaymentInput,
    options?: string | IdempotencyOptions,
  ): Promise<Payment> {
    const idempotencyKey = unwrapIdempotencyOptions(options)
    return this.postMoney(
      '/v1/send',
      toApiPaymentInput(input),
      idempotencyKey,
      parsePayment,
    )
  }

  public async receive(input: ReceiveInput = {}): Promise<ReceiveRequest> {
    return parseReceive(
      await this.request('/v1/receives', 'POST', {
        currency: input.currency ?? 'USD',
        ...(input.amount === undefined ? {} : { amount: input.amount }),
        ...(input.reference === undefined ? {} : { reference: input.reference }),
        ...(input.expiresAt === undefined ? {} : { expires_at: input.expiresAt }),
      }),
    )
  }

  public async getReceive(receiveId: string): Promise<ReceiveRequest> {
    return parseReceive(
      await this.request(`/v1/receives/${encodeURIComponent(receiveId)}`, 'GET'),
    )
  }

  public async refund(
    input: RefundInput,
    options?: string | IdempotencyOptions,
  ): Promise<Payment> {
    const idempotencyKey = unwrapIdempotencyOptions(options)
    return this.postMoney(
      '/v1/refunds',
      toApiRefundInput(input),
      idempotencyKey,
      parsePayment,
    )
  }

  public async getPayment(paymentId: string): Promise<Payment> {
    return parsePayment(
      await this.request(`/v1/payments/${encodeURIComponent(paymentId)}`, 'GET'),
    )
  }

  public async listTransactionsPage(
    input: {
      readonly limit?: number
      readonly cursor?: string
    } = {},
  ): Promise<TransactionPage> {
    const query = new URLSearchParams()
    if (input.limit !== undefined) query.set('limit', String(input.limit))
    if (input.cursor !== undefined) query.set('cursor', input.cursor)
    const suffix = query.toString()
    return parseTransactionListPage(
      await this.request(`/v1/transactions${suffix === '' ? '' : `?${suffix}`}`, 'GET'),
    )
  }

  public async listTransactions(): Promise<readonly Transaction[]> {
    const transactions: Transaction[] = []
    let cursor: string | undefined
    do {
      const page = await this.listTransactionsPage({
        ...(cursor === undefined ? {} : { cursor }),
      })
      transactions.push(...page.transactions)
      cursor = page.nextCursor ?? undefined
    } while (cursor !== undefined)
    return transactions
  }

  private async postMoney<T>(
    path: string,
    body: unknown,
    idempotencyKey: string,
    parser: (value: unknown) => T,
  ): Promise<T> {
    const response = await this.request(path, 'POST', body, idempotencyKey)
    try {
      return parser(response)
    } catch {
      throw new PaymentPendingError(
        idempotencyKey,
        'Payment response could not be validated; outcome is unknown',
        undefined,
      )
    }
  }

  private async request(
    path: string,
    method: 'GET' | 'POST' | 'PATCH',
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<unknown> {
    const attempts =
      method === 'GET' || idempotencyKey !== undefined ? 1 + this.retryCount : 1
    let lastTransportError: unknown
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
        try {
          const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
            method,
            signal: controller.signal,
            headers: {
              authorization: `Bearer ${this.apiKey}`,
              ...(body === undefined ? {} : { 'content-type': 'application/json' }),
              ...(idempotencyKey === undefined
                ? {}
                : { 'idempotency-key': idempotencyKey }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          })
          const payload = await readJson(response)
          if (!response.ok) {
            throw mapHttpError(response.status, payload, idempotencyKey)
          }
          return payload
        } finally {
          clearTimeout(timeout)
        }
      } catch (error) {
        if (error instanceof SdkError) {
          if (error instanceof HttpResponseExternalServiceError) throw error
          if (
            method === 'POST' &&
            idempotencyKey !== undefined &&
            error.code === 'EXTERNAL_SERVICE_ERROR' &&
            attempt + 1 < attempts
          ) {
            lastTransportError = error
            continue
          }
          if (
            method === 'POST' &&
            idempotencyKey !== undefined &&
            error.code === 'EXTERNAL_SERVICE_ERROR'
          ) {
            throw new PaymentPendingError(
              idempotencyKey,
              'Payment response could not be read; outcome is unknown',
            )
          }
          throw error
        }
        lastTransportError = error
        if (attempt + 1 >= attempts) break
      }
    }
    if (method === 'POST' && idempotencyKey !== undefined) {
      throw new PaymentPendingError(
        idempotencyKey,
        'Payment request timed out or the network outcome is unknown',
      )
    }
    throw new ExternalServiceError('Payment service request failed', undefined, {
      cause: lastTransportError,
    })
  }
}

async function readJson(response: Response): Promise<unknown> {
  let text: string
  try {
    text = await response.text()
  } catch (error) {
    if (isRecord(error) && error.name === 'AbortError') {
      throw error
    }
    throw new ExternalServiceError(
      'Payment service response could not be read',
      response.status,
      { cause: error },
    )
  }
  if (text.length === 0) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    throw new ExternalServiceError(
      'Payment service returned invalid JSON',
      response.status,
      { cause: error },
    )
  }
}

function mapHttpError(
  statusCode: number,
  payload: unknown,
  idempotencyKey?: string,
): SdkError {
  const v2Parsed = v2ErrorEnvelopeSchema.safeParse(payload)
  if (v2Parsed.success) {
    const body = v2Parsed.data
    const paymentId = body.payment_id
    switch (body.code) {
      case 'AUTHENTICATION_ERROR':
        return new AuthenticationError(body.message)
      case 'AUTHORIZATION_ERROR':
        return new AuthorizationError(body.message)
      case 'NOT_FOUND':
        return new NotFoundError(body.message)
      case 'IDEMPOTENCY_CONFLICT':
        return new IdempotencyConflictError(body.message)
      case 'POLICY_DENIED':
        return new PolicyDeniedError(body.message, paymentId)
      case 'APPROVAL_REQUIRED':
        return new ApprovalRequiredError(body.message)
      case 'REVIEW_REQUIRED':
        return new ReviewRequiredError(body.message)
      case 'INVALID_STATE':
        return new InvalidStateError(body.message)
      case 'RATE_LIMITED':
        return new RateLimitedError(body.message)
      case 'VALIDATION_ERROR':
        return new ValidationError(body.message, statusCode)
      case 'INSUFFICIENT_FUNDS':
        return new InsufficientFundsError(body.message)
      case 'CONFLICT':
        return new ConflictError(body.message)
      case 'DEPENDENCY_UNAVAILABLE':
      case 'CUSTODY_UNAVAILABLE':
        if (idempotencyKey !== undefined && statusCode >= 500) {
          return new PaymentPendingError(
            idempotencyKey,
            body.message,
            paymentId,
            body.request_id,
          )
        }
        return new HttpResponseExternalServiceError(body.message, statusCode)
      case 'EXTERNAL_RAIL_FAILURE':
        if (idempotencyKey !== undefined && statusCode >= 500) {
          return new PaymentPendingError(
            idempotencyKey,
            body.message,
            paymentId,
            body.request_id,
          )
        }
        return new HttpResponseExternalServiceError(body.message, statusCode)
      case 'INTERNAL_ERROR':
        if (idempotencyKey !== undefined) {
          return new PaymentPendingError(
            idempotencyKey,
            body.message,
            paymentId,
            body.request_id,
          )
        }
        return new HttpResponseExternalServiceError(body.message, statusCode)
      default:
        return new HttpResponseExternalServiceError(body.message, statusCode)
    }
  }
  const parsed = apiErrorResponseSchema.safeParse(payload)
  const body: ApiErrorResponse = parsed.success ? parsed.data : {}
  const message = body.message
  const paymentId = body.details?.payment_id?.trim() || undefined
  const isAmbiguousMoneyError =
    idempotencyKey !== undefined && (paymentId !== undefined || statusCode >= 500)
  switch (body.error) {
    case 'AUTHENTICATION_ERROR':
      return new AuthenticationError(message)
    case 'VALIDATION_ERROR':
      return new ValidationError(message, statusCode)
    case 'INSUFFICIENT_FUNDS':
      return new InsufficientFundsError(message)
    case 'RECIPIENT_RESOLUTION_FAILURE':
      return new RecipientError(message)
    case 'UNSUPPORTED_RAIL':
      return new UnsupportedRailError(message)
    case 'CONFLICT':
      return new ConflictError(message)
    case 'REFUND_NOT_SUPPORTED':
      return new RefundNotSupportedError(message)
    case 'EXTERNAL_RAIL_FAILURE':
      if (idempotencyKey !== undefined && statusCode >= 500) {
        return new PaymentPendingError(
          idempotencyKey,
          'Payment rail outcome is unknown; poll the payment or retry with the same idempotency key',
          paymentId,
        )
      }
      return new HttpResponseExternalServiceError(
        'Payment rail is unavailable',
        statusCode,
      )
    default:
      if (isAmbiguousMoneyError) {
        return new PaymentPendingError(
          idempotencyKey,
          'Payment service outcome is unknown; poll the payment or retry with the same idempotency key',
          paymentId,
        )
      }
      if (statusCode === 401) return new AuthenticationError(message)
      if (statusCode === 409) return new ConflictError(message)
      if (statusCode >= 400 && statusCode < 500) {
        return new ValidationError(message, statusCode)
      }
      return new HttpResponseExternalServiceError(
        'Payment service is unavailable',
        statusCode,
      )
  }
}
