import { ExternalRailError, isDomainError, type RailFailureKind } from './errors.js'

export type WorkRetryClass =
  | 'TRANSIENT'
  | 'RETRY_AFTER'
  | 'NO_RETRY'
  | 'AMBIGUOUS_RECONCILIATION'
  | 'CUSTODY_BOUNDED'

export interface RetryDecision {
  readonly classification: WorkRetryClass
  readonly reasonCode: string
  readonly retryable: boolean
}

export function classifyWorkFailure(
  error: unknown,
  dependency: 'DB' | 'RPC' | 'CUSTODY' | 'RAIL' | 'WEBHOOK',
): RetryDecision {
  if (error instanceof ExternalRailError) return classifyRailFailure(error.kind)
  if (isDomainError(error)) {
    if (error.code === 'CUSTODY_UNAVAILABLE') {
      return { classification: 'CUSTODY_BOUNDED', reasonCode: error.code, retryable: true }
    }
    if (
      error.code === 'VALIDATION_ERROR' ||
      error.code === 'AUTHORIZATION_ERROR' ||
      error.code === 'INSUFFICIENT_FUNDS' ||
      error.code === 'NOT_FOUND' ||
      error.code === 'UNSUPPORTED_RAIL'
    ) {
      return { classification: 'NO_RETRY', reasonCode: error.code, retryable: false }
    }
  }
  if (dependency === 'RAIL' || dependency === 'RPC') {
    return {
      classification: 'AMBIGUOUS_RECONCILIATION',
      reasonCode: 'DEPENDENCY_RESPONSE_UNKNOWN',
      retryable: false,
    }
  }
  return {
    classification: dependency === 'CUSTODY' ? 'CUSTODY_BOUNDED' : 'TRANSIENT',
    reasonCode: 'DEPENDENCY_TEMPORARY_FAILURE',
    retryable: true,
  }
}

export function classifyRailFailure(kind: RailFailureKind): RetryDecision {
  switch (kind) {
    case 'DETERMINISTIC':
      return { classification: 'NO_RETRY', reasonCode: 'RAIL_DETERMINISTIC_FAILURE', retryable: false }
    case 'AMBIGUOUS':
      return { classification: 'AMBIGUOUS_RECONCILIATION', reasonCode: 'RAIL_OUTCOME_UNKNOWN', retryable: false }
    case 'RETRYABLE':
      return { classification: 'TRANSIENT', reasonCode: 'RAIL_TRANSIENT_FAILURE', retryable: true }
  }
}

export function computeRetryAt(input: {
  readonly now: Date
  readonly attemptCount: number
  readonly baseDelayMs?: number
  readonly maxDelayMs?: number
  readonly retryAfterMs?: number
  readonly jitterRatio?: number
  readonly random?: () => number
}): Date {
  const baseDelayMs = input.baseDelayMs ?? 500
  const maxDelayMs = input.maxDelayMs ?? 60_000
  const exponential = Math.min(
    maxDelayMs,
    baseDelayMs * 2 ** Math.max(0, input.attemptCount - 1),
  )
  const jitterRatio = input.jitterRatio ?? 0.2
  const random = input.random ?? Math.random
  const jitter = exponential * jitterRatio * (random() * 2 - 1)
  const delay = Math.max(
    input.retryAfterMs ?? 0,
    Math.max(0, Math.round(exponential + jitter)),
  )
  return new Date(input.now.getTime() + delay)
}
