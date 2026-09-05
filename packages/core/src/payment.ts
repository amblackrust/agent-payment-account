import { ConflictError } from './errors.js'

export enum PaymentStatus {
  CREATED = 'CREATED',
  ROUTING = 'ROUTING',
  SUBMITTED = 'SUBMITTED',
  CONFIRMED = 'CONFIRMED',
  FAILED = 'FAILED',
}

export type PaymentOperation = 'PAY' | 'SEND' | 'RECEIVE' | 'REFUND'

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
