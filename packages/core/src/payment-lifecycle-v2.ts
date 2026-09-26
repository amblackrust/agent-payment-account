import { ConflictError, InvalidStateError, ValidationError } from './errors.js'

export type PaymentExecutionState =
  | 'NOT_STARTED'
  | 'QUEUED'
  | 'PREPARING'
  | 'SIGNING'
  | 'SUBMITTING'
  | 'RECONCILING'
  | 'TERMINAL'

export type PaymentAttemptOutcome =
  | 'NOT_STARTED'
  | 'PRE_EFFECT_ABORTED'
  | 'PROVED_NO_EFFECT'
  | 'SUBMITTED'
  | 'CONFIRMED'
  | 'UNKNOWN'
  | 'FAILED'

export type ReservationLifecycleStatus = 'HELD' | 'CONSUMED' | 'RELEASED'

export interface PaymentAttemptState {
  readonly id: string
  readonly sequence: number
  readonly routeId: string
  readonly executionState: PaymentExecutionState
  readonly outcome: PaymentAttemptOutcome
  readonly preparedEffectHash: string | null
  readonly signedPayloadHash: string | null
  readonly expectedExternalId: string | null
  readonly validity: Readonly<{ expiresAt: Date | null; slot: bigint | null }>
}

export interface ReservationState {
  readonly status: ReservationLifecycleStatus
  readonly amountAtomic: bigint
  readonly reason: string | null
}

export function assertPaymentAttemptSequence(sequence: number): void {
  if (!Number.isInteger(sequence) || sequence < 1) {
    throw new ValidationError('Payment attempt sequence must start at one')
  }
}

export function canCreateNextAttempt(
  attempts: readonly PaymentAttemptState[],
): boolean {
  if (attempts.length === 0) return true
  return attempts.every(
    (attempt) =>
      attempt.outcome === 'PROVED_NO_EFFECT' ||
      attempt.outcome === 'PRE_EFFECT_ABORTED',
  )
}

export function assertCanCreateNextAttempt(
  attempts: readonly PaymentAttemptState[],
): void {
  if (!canCreateNextAttempt(attempts)) {
    throw new ConflictError(
      'A replacement attempt is unsafe until every earlier attempt is proved no-effect',
    )
  }
}

export function assertAttemptProgression(
  current: PaymentAttemptOutcome,
  next: PaymentAttemptOutcome,
): void {
  const allowed: Readonly<
    Record<PaymentAttemptOutcome, readonly PaymentAttemptOutcome[]>
  > = {
    NOT_STARTED: [
      'PRE_EFFECT_ABORTED',
      'PROVED_NO_EFFECT',
      'SUBMITTED',
      // A rail can observe a confirmed transaction before the worker persists
      // the intermediate SUBMITTED observation. The authoritative confirmation
      // is still safe to terminalize directly.
      'CONFIRMED',
      'UNKNOWN',
      'FAILED',
    ],
    PRE_EFFECT_ABORTED: [],
    PROVED_NO_EFFECT: [],
    SUBMITTED: ['CONFIRMED', 'UNKNOWN'],
    CONFIRMED: [],
    UNKNOWN: ['CONFIRMED', 'PROVED_NO_EFFECT'],
    FAILED: [],
  }
  if (!allowed[current].includes(next)) {
    throw new ConflictError(
      `Cannot transition attempt outcome from ${current} to ${next}`,
    )
  }
}

export function assertReservationTransition(
  current: ReservationLifecycleStatus,
  next: ReservationLifecycleStatus,
): void {
  const allowed: Readonly<
    Record<ReservationLifecycleStatus, readonly ReservationLifecycleStatus[]>
  > = {
    HELD: ['CONSUMED', 'RELEASED'],
    CONSUMED: [],
    RELEASED: [],
  }
  if (!allowed[current].includes(next)) {
    throw new ConflictError(`Cannot transition reservation from ${current} to ${next}`)
  }
}

export function assertReservationCanBeReleased(
  paymentOutcome: PaymentAttemptOutcome,
): void {
  if (paymentOutcome === 'UNKNOWN' || paymentOutcome === 'SUBMITTED') {
    throw new InvalidStateError(
      'Reservation cannot be released while an effect may exist',
    )
  }
}
