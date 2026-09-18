export const DOMAIN_ERROR_CODES = {
  VALIDATION: 'VALIDATION_ERROR',
  AUTHENTICATION: 'AUTHENTICATION_ERROR',
  INSUFFICIENT_FUNDS: 'INSUFFICIENT_FUNDS',
  UNSUPPORTED_CURRENCY: 'UNSUPPORTED_CURRENCY',
  RECIPIENT_RESOLUTION: 'RECIPIENT_RESOLUTION_FAILURE',
  UNSUPPORTED_RAIL: 'UNSUPPORTED_RAIL',
  CONFLICT: 'CONFLICT',
  EXTERNAL_RAIL: 'EXTERNAL_RAIL_FAILURE',
  REFUND_NOT_SUPPORTED: 'REFUND_NOT_SUPPORTED',
  INTERNAL: 'INTERNAL_ERROR',
  AUTHORIZATION: 'AUTHORIZATION_ERROR',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
  POLICY_DENIED: 'POLICY_DENIED',
  APPROVAL_REQUIRED: 'APPROVAL_REQUIRED',
  REVIEW_REQUIRED: 'REVIEW_REQUIRED',
  DEPENDENCY_UNAVAILABLE: 'DEPENDENCY_UNAVAILABLE',
  CUSTODY_UNAVAILABLE: 'CUSTODY_UNAVAILABLE',
  INVALID_STATE: 'INVALID_STATE',
  RATE_LIMITED: 'RATE_LIMITED',
  NOT_FOUND: 'NOT_FOUND',
} as const

export type DomainErrorCode =
  (typeof DOMAIN_ERROR_CODES)[keyof typeof DOMAIN_ERROR_CODES]

export interface SerializedDomainError {
  code: DomainErrorCode
  message: string
  details?: Readonly<Record<string, string>>
}

export type RailFailureKind = 'DETERMINISTIC' | 'RETRYABLE' | 'AMBIGUOUS'

export abstract class DomainError extends Error {
  public readonly code: DomainErrorCode
  public readonly details?: Readonly<Record<string, string>>

  protected constructor(
    code: DomainErrorCode,
    message: string,
    details?: Readonly<Record<string, string>>,
    cause?: unknown,
  ) {
    super(message)
    this.name = new.target.name
    this.code = code
    if (details !== undefined) {
      this.details = details
    }
    if (cause !== undefined) {
      this.cause = cause
    }
  }

  public toJSON(): SerializedDomainError {
    const serialized: SerializedDomainError = {
      code: this.code,
      message: this.message,
    }
    if (this.details !== undefined) {
      serialized.details = this.details
    }
    return serialized
  }
}

export class ValidationError extends DomainError {
  public constructor(message: string, details?: Readonly<Record<string, string>>) {
    super(DOMAIN_ERROR_CODES.VALIDATION, message, details)
  }
}

export class AuthenticationError extends DomainError {
  public constructor(message = 'Authentication failed') {
    super(DOMAIN_ERROR_CODES.AUTHENTICATION, message)
  }
}

export class AuthorizationError extends DomainError {
  public constructor(message = 'The actor is not authorized for this operation') {
    super(DOMAIN_ERROR_CODES.AUTHORIZATION, message)
  }
}

export class IdempotencyConflictError extends DomainError {
  public constructor(message = 'Idempotency key was already used for another request') {
    super(DOMAIN_ERROR_CODES.IDEMPOTENCY_CONFLICT, message)
  }
}

export class IdempotencyKeyReusedError extends DomainError {
  public constructor(message = 'Idempotency key was already used for another request') {
    super(DOMAIN_ERROR_CODES.IDEMPOTENCY_KEY_REUSED, message)
  }
}

export class PolicyDeniedError extends DomainError {
  public constructor(
    message = 'Payment was denied by policy',
    details?: Readonly<Record<string, string>>,
  ) {
    super(DOMAIN_ERROR_CODES.POLICY_DENIED, message, details)
  }
}

export class ApprovalRequiredError extends DomainError {
  public constructor(
    message = 'Payment requires approval',
    details?: Readonly<Record<string, string>>,
  ) {
    super(DOMAIN_ERROR_CODES.APPROVAL_REQUIRED, message, details)
  }
}

export class ReviewRequiredError extends DomainError {
  public constructor(
    message = 'Payment requires operational review',
    details?: Readonly<Record<string, string>>,
  ) {
    super(DOMAIN_ERROR_CODES.REVIEW_REQUIRED, message, details)
  }
}

export class DependencyUnavailableError extends DomainError {
  public constructor(message = 'A required dependency is unavailable') {
    super(DOMAIN_ERROR_CODES.DEPENDENCY_UNAVAILABLE, message)
  }
}

export class CustodyUnavailableError extends DomainError {
  public constructor(message = 'Signing custody is unavailable') {
    super(DOMAIN_ERROR_CODES.CUSTODY_UNAVAILABLE, message)
  }
}

export class InvalidStateError extends DomainError {
  public constructor(
    message = 'The resource is in an invalid state for this operation',
  ) {
    super(DOMAIN_ERROR_CODES.INVALID_STATE, message)
  }
}

export class RateLimitedError extends DomainError {
  public constructor(message = 'Request rate limit exceeded') {
    super(DOMAIN_ERROR_CODES.RATE_LIMITED, message)
  }
}

export class NotFoundError extends DomainError {
  public constructor(message = 'Resource was not found') {
    super(DOMAIN_ERROR_CODES.NOT_FOUND, message)
  }
}

export class InsufficientFundsError extends DomainError {
  public constructor(
    message = 'Insufficient funds',
    details?: Readonly<Record<string, string>>,
  ) {
    super(DOMAIN_ERROR_CODES.INSUFFICIENT_FUNDS, message, details)
  }
}

export class UnsupportedCurrencyError extends DomainError {
  public constructor(currency: string) {
    super(DOMAIN_ERROR_CODES.UNSUPPORTED_CURRENCY, `Unsupported currency: ${currency}`)
  }
}

export class RecipientResolutionError extends DomainError {
  public constructor(message = 'Recipient could not be resolved') {
    super(DOMAIN_ERROR_CODES.RECIPIENT_RESOLUTION, message)
  }
}

export class UnsupportedRailError extends DomainError {
  public constructor(rail: string) {
    super(DOMAIN_ERROR_CODES.UNSUPPORTED_RAIL, `Unsupported payment rail: ${rail}`)
  }
}

export class ConflictError extends DomainError {
  public constructor(message = 'Request conflicts with the current resource state') {
    super(DOMAIN_ERROR_CODES.CONFLICT, message)
  }
}

export class ExternalRailError extends DomainError {
  public readonly kind: RailFailureKind

  public constructor(
    message = 'External payment rail failed',
    cause?: unknown,
    kind: RailFailureKind = 'DETERMINISTIC',
    details?: Readonly<Record<string, string>>,
  ) {
    super(DOMAIN_ERROR_CODES.EXTERNAL_RAIL, message, details, cause)
    this.kind = kind
  }
}

export class RefundNotSupportedError extends DomainError {
  public constructor(message = 'Refund is not supported for this payment') {
    super(DOMAIN_ERROR_CODES.REFUND_NOT_SUPPORTED, message)
  }
}

export class InternalError extends DomainError {
  public constructor(message = 'Internal error', cause?: unknown) {
    super(DOMAIN_ERROR_CODES.INTERNAL, message, undefined, cause)
  }
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError
}
