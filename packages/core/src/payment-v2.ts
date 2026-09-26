import { ConflictError } from './errors.js'

export const V2PaymentStatus = {
  CREATED: 'CREATED',
  ROUTING: 'ROUTING',
  AWAITING_APPROVAL: 'AWAITING_APPROVAL',
  REJECTED_BY_POLICY: 'REJECTED_BY_POLICY',
  REJECTED: 'REJECTED',
  SUBMITTED: 'SUBMITTED',
  RECONCILING: 'RECONCILING',
  CONFIRMED: 'CONFIRMED',
  PROVED_NO_EFFECT: 'PROVED_NO_EFFECT',
  REVIEW_REQUIRED: 'REVIEW_REQUIRED',
  CLOSED_UNRESOLVED: 'CLOSED_UNRESOLVED',
  FAILED: 'FAILED',
  EXPIRED: 'EXPIRED',
} as const

export type V2PaymentStatus = (typeof V2PaymentStatus)[keyof typeof V2PaymentStatus]

export type PaymentPolicyDecision = 'ALLOW' | 'REQUIRE_APPROVAL' | 'DENY'
export type ApprovalState =
  'NOT_REQUIRED' | 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED'
export type AttemptOutcome =
  | 'NOT_STARTED'
  | 'PRE_EFFECT_ABORTED'
  | 'PROVED_NO_EFFECT'
  | 'SUBMITTED'
  | 'CONFIRMED'
  | 'UNKNOWN'
  | 'FAILED'

export interface PaymentStatusProjectionInput {
  readonly policyDecision: PaymentPolicyDecision
  readonly approvalState: ApprovalState
  readonly attemptOutcomes: readonly AttemptOutcome[]
  readonly planExhausted: boolean
  readonly reviewRequired?: boolean
  readonly closedUnresolved?: boolean
  readonly executionStarted?: boolean
}

/**
 * Payment.status is a read projection.  Durable policy, approval, attempt and
 * evidence facts remain the source of truth and are never overwritten by this
 * mapping.
 */
export function projectPaymentStatus(
  input: PaymentStatusProjectionInput,
): V2PaymentStatus {
  if (input.policyDecision === 'DENY') return V2PaymentStatus.REJECTED_BY_POLICY
  if (input.approvalState === 'REJECTED') return V2PaymentStatus.REJECTED
  if (input.approvalState === 'EXPIRED') return V2PaymentStatus.EXPIRED
  if (input.approvalState === 'PENDING') return V2PaymentStatus.AWAITING_APPROVAL
  if (input.closedUnresolved === true) return V2PaymentStatus.CLOSED_UNRESOLVED
  if (input.reviewRequired === true) return V2PaymentStatus.REVIEW_REQUIRED

  const outcomes = input.attemptOutcomes
  if (outcomes.some((outcome) => outcome === 'CONFIRMED')) {
    return V2PaymentStatus.CONFIRMED
  }
  if (outcomes.some((outcome) => outcome === 'UNKNOWN')) {
    return V2PaymentStatus.RECONCILING
  }
  if (outcomes.some((outcome) => outcome === 'SUBMITTED')) {
    return V2PaymentStatus.SUBMITTED
  }
  if (
    input.planExhausted &&
    outcomes.length > 0 &&
    outcomes.every(
      (outcome) => outcome === 'PROVED_NO_EFFECT' || outcome === 'PRE_EFFECT_ABORTED',
    )
  ) {
    return V2PaymentStatus.PROVED_NO_EFFECT
  }
  if (outcomes.some((outcome) => outcome === 'FAILED')) {
    return V2PaymentStatus.FAILED
  }
  if (input.executionStarted === true) return V2PaymentStatus.ROUTING
  return V2PaymentStatus.CREATED
}

export function assertV2PaymentStatusTransition(
  current: V2PaymentStatus,
  next: V2PaymentStatus,
): void {
  const terminal = new Set<V2PaymentStatus>([
    V2PaymentStatus.CONFIRMED,
    V2PaymentStatus.REJECTED_BY_POLICY,
    V2PaymentStatus.REJECTED,
    V2PaymentStatus.PROVED_NO_EFFECT,
    V2PaymentStatus.CLOSED_UNRESOLVED,
    V2PaymentStatus.FAILED,
    V2PaymentStatus.EXPIRED,
  ])
  if (terminal.has(current) && current !== next) {
    throw new ConflictError(`Cannot transition terminal V2 payment from ${current}`)
  }
}
