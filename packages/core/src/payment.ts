import { ConflictError } from './errors.js'

export const PaymentStatus = {
  CREATED: 'CREATED',
  ROUTING: 'ROUTING',
  SUBMITTED: 'SUBMITTED',
  CONFIRMED: 'CONFIRMED',
  FAILED: 'FAILED',
} as const

export type PaymentStatus = (typeof PaymentStatus)[keyof typeof PaymentStatus]

export type PaymentOperation = 'PAY' | 'SEND' | 'RECEIVE' | 'REFUND'
export type PaymentKind = Extract<PaymentOperation, 'PAY' | 'SEND'>

export type PaymentAttemptStatus =
  'CREATED' | 'PREPARED' | 'SUBMITTED' | 'CONFIRMED' | 'FAILED'

const PAYMENT_ATTEMPT_TRANSITIONS: Readonly<
  Record<PaymentAttemptStatus, readonly PaymentAttemptStatus[]>
> = {
  CREATED: ['PREPARED', 'FAILED'],
  PREPARED: ['SUBMITTED', 'FAILED'],
  SUBMITTED: ['CONFIRMED', 'FAILED'],
  CONFIRMED: [],
  FAILED: [],
}

const PAYMENT_TRANSITIONS: Readonly<Record<PaymentStatus, readonly PaymentStatus[]>> = {
  [PaymentStatus.CREATED]: [PaymentStatus.ROUTING, PaymentStatus.FAILED],
  [PaymentStatus.ROUTING]: [PaymentStatus.SUBMITTED, PaymentStatus.FAILED],
  [PaymentStatus.SUBMITTED]: [PaymentStatus.CONFIRMED, PaymentStatus.FAILED],
  [PaymentStatus.CONFIRMED]: [],
  [PaymentStatus.FAILED]: [],
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
