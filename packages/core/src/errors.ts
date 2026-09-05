export const DOMAIN_ERROR_CODES = {
  VALIDATION: 'VALIDATION_ERROR',
  AUTHENTICATION: 'AUTHENTICATION_ERROR',
  INSUFFICIENT_FUNDS: 'INSUFFICIENT_FUNDS',
  UNSUPPORTED_CURRENCY: 'UNSUPPORTED_CURRENCY',
  RECIPIENT_RESOLUTION: 'RECIPIENT_RESOLUTION_FAILURE',
  UNSUPPORTED_RAIL: 'UNSUPPORTED_RAIL',
  CONFLICT: 'CONFLICT',
  EXTERNAL_RAIL: 'EXTERNAL_RAIL_FAILURE',
  INTERNAL: 'INTERNAL_ERROR',
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

export class InsufficientFundsError extends DomainError {
  public constructor(message = 'Insufficient funds') {
    super(DOMAIN_ERROR_CODES.INSUFFICIENT_FUNDS, message)
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

export class InternalError extends DomainError {
  public constructor(message = 'Internal error', cause?: unknown) {
    super(DOMAIN_ERROR_CODES.INTERNAL, message, undefined, cause)
  }
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError
}
