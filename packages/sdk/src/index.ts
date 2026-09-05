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
  public constructor(message = 'Request validation failed') {
    super('VALIDATION_ERROR', message, 422)
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

export class PaymentPendingError extends SdkError {
  public readonly idempotencyKey: string

  public constructor(
    idempotencyKey: string,
    message = 'Payment outcome is pending; poll the payment or retry with the same idempotency key',
  ) {
    super('PAYMENT_PENDING', message)
    this.name = 'PaymentPendingError'
    this.idempotencyKey = idempotencyKey
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

interface ApiErrorBody {
  readonly error?: unknown
  readonly message?: unknown
}

const PAYMENT_STATUSES: readonly PaymentStatus[] = [
  'CREATED',
  'ROUTING',
  'SUBMITTED',
  'RECONCILING',
  'CONFIRMED',
  'FAILED',
]
const PAYMENT_KINDS: readonly PaymentKind[] = ['PAY', 'SEND', 'REFUND']
const RECEIVE_STATUSES = ['OPEN', 'PAID', 'EXPIRED', 'CANCELLED'] as const
const MONEY_PATTERN = /^(0|[1-9][0-9]*)\.[0-9]{2}$/u

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ExternalServiceError(`API response is missing a valid ${field}`)
  }
  return value
}

function nullableString(value: unknown, field: string): string | null {
  if (value !== null && typeof value !== 'string') {
    throw new ExternalServiceError(`API response contains an invalid ${field}`)
  }
  return value
}

function moneyString(value: unknown, field: string): string {
  const result = requiredString(value, field)
  if (!MONEY_PATTERN.test(result)) {
    throw new ExternalServiceError(`API response contains a non-canonical ${field}`)
  }
  return result
}

function enumValue<T extends string>(
  value: unknown,
  values: readonly T[],
  field: string,
): T {
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw new ExternalServiceError(`API response contains an invalid ${field}`)
  }
  return value as T
}

function parseBalance(value: unknown): Balance {
  if (!isRecord(value)) {
    throw new ExternalServiceError('API returned an invalid balance response')
  }
  return {
    currency: enumValue(value.currency, ['USD'], 'currency'),
    settled: moneyString(value.settled, 'settled balance'),
    pendingOutgoing: moneyString(value.pending_outgoing, 'pending balance'),
    available: moneyString(value.available, 'available balance'),
  }
}

function parsePayment(value: unknown): Payment {
  if (!isRecord(value)) {
    throw new ExternalServiceError('API returned an invalid payment response')
  }
  return {
    id: requiredString(value.id, 'payment id'),
    recipientId: nullableString(value.recipient_id, 'recipient id'),
    kind: enumValue(value.kind, PAYMENT_KINDS, 'payment kind'),
    amount: moneyString(value.amount, 'payment amount'),
    currency: enumValue(value.currency, ['USD'], 'currency'),
    status: enumValue(value.status, PAYMENT_STATUSES, 'payment status'),
    description: nullableString(value.description, 'description'),
    externalReference: nullableString(value.external_reference, 'external reference'),
    route: nullableString(value.route, 'route'),
    createdAt: requiredString(value.created_at, 'created_at'),
    updatedAt: requiredString(value.updated_at, 'updated_at'),
    confirmedAt: nullableString(value.confirmed_at, 'confirmed_at'),
    failedAt: nullableString(value.failed_at, 'failed_at'),
    failureCode: nullableString(value.failure_code, 'failure_code'),
    failureMessage: nullableString(value.failure_message, 'failure_message'),
    originalPaymentId: nullableString(value.original_payment_id, 'original_payment_id'),
  }
}

function parseReceive(value: unknown): ReceiveRequest {
  if (!isRecord(value)) {
    throw new ExternalServiceError('API returned an invalid receive response')
  }
  const destination = value.destination
  const settlement = value.settlement
  if (!isRecord(destination) || !isRecord(settlement)) {
    throw new ExternalServiceError('API response is missing receive settlement details')
  }
  return {
    id: requiredString(value.id, 'receive id'),
    accountId: requiredString(value.account_id, 'account id'),
    amount: value.amount === null ? null : moneyString(value.amount, 'receive amount'),
    currency: enumValue(value.currency, ['USD'], 'currency'),
    reference: requiredString(value.reference, 'receive reference'),
    status: enumValue(value.status, RECEIVE_STATUSES, 'receive status'),
    createdAt: requiredString(value.created_at, 'created_at'),
    expiresAt: nullableString(value.expires_at, 'expires_at'),
    paidAt: nullableString(value.paid_at, 'paid_at'),
    destination: {
      type: enumValue(
        destination.type,
        ['external_transfer_target'],
        'destination type',
      ),
      reference: requiredString(destination.reference, 'destination reference'),
    },
    settlement: {
      owner: requiredString(settlement.owner, 'settlement owner'),
      tokenAccount: requiredString(
        settlement.token_account,
        'settlement token account',
      ),
      mint: requiredString(settlement.mint, 'settlement mint'),
    },
  }
}

function parseCounterparty(value: unknown): Counterparty {
  if (!isRecord(value)) {
    throw new ExternalServiceError('API response is missing counterparty')
  }
  return {
    recipientId: nullableString(value.recipient_id, 'counterparty recipient id'),
    displayName: nullableString(value.display_name, 'counterparty display name'),
    accountId: nullableString(value.account_id, 'counterparty account id'),
    address: nullableString(value.address, 'counterparty address'),
  }
}

function parseTransaction(value: unknown): Transaction {
  if (!isRecord(value)) {
    throw new ExternalServiceError('API returned an invalid transaction response')
  }
  return {
    id: requiredString(value.id, 'transaction id'),
    direction: enumValue(
      value.direction,
      ['INCOMING', 'OUTGOING'],
      'transaction direction',
    ),
    kind: enumValue(value.kind, [...PAYMENT_KINDS, 'RECEIVE'], 'transaction kind'),
    amount: moneyString(value.amount, 'transaction amount'),
    currency: enumValue(value.currency, ['USD'], 'currency'),
    status: enumValue(
      value.status,
      [...PAYMENT_STATUSES, 'CONFIRMED'],
      'transaction status',
    ),
    counterparty: parseCounterparty(value.counterparty),
    createdAt: requiredString(value.created_at, 'created_at'),
    updatedAt: requiredString(value.updated_at, 'updated_at'),
    confirmedAt: nullableString(value.confirmed_at, 'confirmed_at'),
    signature: nullableString(value.signature, 'signature'),
  }
}

function parseList<T>(
  value: unknown,
  key: string,
  parser: (item: unknown) => T,
): readonly T[] {
  if (!isRecord(value) || !Array.isArray(value[key])) {
    throw new ExternalServiceError(`API response is missing ${key}`)
  }
  return value[key].map(parser)
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
    return parsePayment(
      await this.postMoney(
        '/v1/pay',
        toApiPaymentInput(input),
        unwrapIdempotencyOptions(options),
      ),
    )
  }

  public async send(
    input: PaymentInput,
    options?: string | IdempotencyOptions,
  ): Promise<Payment> {
    return parsePayment(
      await this.postMoney(
        '/v1/send',
        toApiPaymentInput(input),
        unwrapIdempotencyOptions(options),
      ),
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

  public async refund(
    input: RefundInput,
    options?: string | IdempotencyOptions,
  ): Promise<Payment> {
    return parsePayment(
      await this.postMoney(
        '/v1/refunds',
        toApiRefundInput(input),
        unwrapIdempotencyOptions(options),
      ),
    )
  }

  public async getPayment(paymentId: string): Promise<Payment> {
    return parsePayment(
      await this.request(`/v1/payments/${encodeURIComponent(paymentId)}`, 'GET'),
    )
  }

  public async listTransactions(): Promise<readonly Transaction[]> {
    return parseList(
      await this.request('/v1/transactions', 'GET'),
      'transactions',
      parseTransaction,
    )
  }

  private async postMoney(
    path: string,
    body: unknown,
    idempotencyKey: string,
  ): Promise<unknown> {
    return this.request(path, 'POST', body, idempotencyKey)
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
            throw mapHttpError(response.status, payload)
          }
          return payload
        } finally {
          clearTimeout(timeout)
        }
      } catch (error) {
        if (error instanceof SdkError) throw error
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

function mapHttpError(statusCode: number, payload: unknown): SdkError {
  const body = isRecord(payload) ? (payload as ApiErrorBody) : {}
  const message = typeof body.message === 'string' ? body.message : undefined
  switch (body.error) {
    case 'AUTHENTICATION_ERROR':
      return new AuthenticationError(message)
    case 'VALIDATION_ERROR':
      return new ValidationError(message)
    case 'INSUFFICIENT_FUNDS':
      return new InsufficientFundsError(message)
    case 'RECIPIENT_RESOLUTION_FAILURE':
      return new RecipientError(message)
    case 'UNSUPPORTED_RAIL':
      return new UnsupportedRailError(message)
    case 'CONFLICT':
      return new ConflictError(message)
    case 'EXTERNAL_RAIL_FAILURE':
      return new ExternalServiceError('Payment rail is unavailable', statusCode)
    default:
      if (statusCode === 401) return new AuthenticationError(message)
      if (statusCode === 409) return new ConflictError(message)
      if (statusCode >= 400 && statusCode < 500) return new ValidationError(message)
      return new ExternalServiceError('Payment service is unavailable', statusCode)
  }
}
