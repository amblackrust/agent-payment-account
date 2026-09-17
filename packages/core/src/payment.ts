import { ConflictError } from './errors.js'

export const PaymentStatus = {
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

export type PaymentStatus = (typeof PaymentStatus)[keyof typeof PaymentStatus]

export type PaymentOperation = 'PAY' | 'SEND' | 'RECEIVE' | 'REFUND'
export type PaymentKind = Extract<PaymentOperation, 'PAY' | 'SEND' | 'REFUND'>

export type PaymentAttemptStatus =
  | 'CREATED'
  | 'PREPARED'
  | 'EXECUTING'
  | 'SUBMITTED'
  | 'RECONCILING'
  | 'CONFIRMED'
  | 'FAILED'

const PAYMENT_ATTEMPT_TRANSITIONS: Readonly<
  Record<PaymentAttemptStatus, readonly PaymentAttemptStatus[]>
> = {
  CREATED: ['PREPARED', 'FAILED'],
  PREPARED: ['EXECUTING', 'SUBMITTED', 'RECONCILING', 'FAILED'],
  EXECUTING: ['SUBMITTED', 'RECONCILING', 'FAILED'],
  SUBMITTED: ['CONFIRMED', 'RECONCILING', 'FAILED'],
  RECONCILING: ['CONFIRMED', 'FAILED'],
  CONFIRMED: [],
  FAILED: [],
}

const PAYMENT_TRANSITIONS: Readonly<Record<PaymentStatus, readonly PaymentStatus[]>> = {
  [PaymentStatus.CREATED]: [PaymentStatus.ROUTING, PaymentStatus.FAILED],
  [PaymentStatus.ROUTING]: [
    PaymentStatus.AWAITING_APPROVAL,
    PaymentStatus.SUBMITTED,
    PaymentStatus.RECONCILING,
    PaymentStatus.FAILED,
  ],
  [PaymentStatus.AWAITING_APPROVAL]: [
    PaymentStatus.ROUTING,
    PaymentStatus.REJECTED,
    PaymentStatus.EXPIRED,
  ],
  [PaymentStatus.REJECTED_BY_POLICY]: [],
  [PaymentStatus.REJECTED]: [],
  [PaymentStatus.SUBMITTED]: [
    PaymentStatus.CONFIRMED,
    PaymentStatus.RECONCILING,
    PaymentStatus.FAILED,
  ],
  [PaymentStatus.RECONCILING]: [PaymentStatus.CONFIRMED, PaymentStatus.FAILED],
  [PaymentStatus.PROVED_NO_EFFECT]: [],
  [PaymentStatus.REVIEW_REQUIRED]: [
    PaymentStatus.CONFIRMED,
    PaymentStatus.PROVED_NO_EFFECT,
    PaymentStatus.CLOSED_UNRESOLVED,
  ],
  [PaymentStatus.CLOSED_UNRESOLVED]: [],
  [PaymentStatus.CONFIRMED]: [],
  [PaymentStatus.FAILED]: [],
  [PaymentStatus.EXPIRED]: [],
}

export function canTransitionPaymentStatus(
  current: PaymentStatus,
  next: PaymentStatus,
): boolean {
  return PAYMENT_TRANSITIONS[current].includes(next)
}

export function assertPaymentStatusTransition(
  current: PaymentStatus,
  next: PaymentStatus,
): void {
  if (!canTransitionPaymentStatus(current, next)) {
    throw new ConflictError(`Cannot transition payment from ${current} to ${next}`)
  }
}

export function canTransitionPaymentAttemptStatus(
  current: PaymentAttemptStatus,
  next: PaymentAttemptStatus,
): boolean {
  return PAYMENT_ATTEMPT_TRANSITIONS[current].includes(next)
}

export function assertPaymentAttemptStatusTransition(
  current: PaymentAttemptStatus,
  next: PaymentAttemptStatus,
): void {
  if (!canTransitionPaymentAttemptStatus(current, next)) {
    throw new ConflictError(
      `Cannot transition payment attempt from ${current} to ${next}`,
    )
  }
}
