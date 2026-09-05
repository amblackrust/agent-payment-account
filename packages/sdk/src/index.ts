import {
  apiErrorResponseSchema,
  balanceResponseSchema,
  paymentResponseSchema,
  receiveResponseSchema,
  transactionListResponseSchema,
  transactionResponseSchema,
  type ApiErrorResponse,
  type BalanceResponse,
  type PaymentResponse,
  type ReceiveResponse,
  type TransactionListResponse,
  type TransactionResponse,
} from '@agent-payment/contracts'

export type Currency = 'USD'

export type PaymentKind = 'PAY' | 'SEND' | 'REFUND'
export type TransactionKind = PaymentKind | 'RECEIVE'
export type PaymentStatus =
  'CREATED' | 'ROUTING' | 'SUBMITTED' | 'RECONCILING' | 'CONFIRMED' | 'FAILED'

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

  public constructor(
    idempotencyKey: string,
    message = 'Payment outcome is pending; poll the payment or retry with the same idempotency key',
    paymentId?: string,
  ) {
    super('PAYMENT_PENDING', message)
    this.name = 'PaymentPendingError'
    this.idempotencyKey = idempotencyKey
    if (paymentId !== undefined) this.paymentId = paymentId
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
    method: 'GET' | 'POST',
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
