import { describe, expect, it } from 'vitest'

import {
  assertPaymentStatusTransition,
  assertPaymentAttemptStatusTransition,
  canTransitionPaymentAttemptStatus,
  canTransitionPaymentStatus,
  ConflictError,
  createAccountId,
  PaymentStatus,
} from './index.js'

describe('domain contracts', () => {
  it('generates opaque identifiers with stable prefixes', () => {
    const accountId = createAccountId()

    expect(accountId).toMatch(/^acct_[a-f0-9]{32}$/)
  })

  it('allows only declared payment transitions', () => {
    expect(
      canTransitionPaymentStatus(PaymentStatus.CREATED, PaymentStatus.ROUTING),
    ).toBe(true)
    expect(
      canTransitionPaymentStatus(PaymentStatus.CONFIRMED, PaymentStatus.SUBMITTED),
    ).toBe(false)
    expect(() =>
      assertPaymentStatusTransition(PaymentStatus.CONFIRMED, PaymentStatus.FAILED),
    ).toThrow(ConflictError)
  })

  it('does not allow payment attempts to leave terminal states', () => {
    expect(canTransitionPaymentAttemptStatus('SUBMITTED', 'CONFIRMED')).toBe(true)
    expect(canTransitionPaymentAttemptStatus('CONFIRMED', 'FAILED')).toBe(false)
    expect(() => assertPaymentAttemptStatusTransition('FAILED', 'SUBMITTED')).toThrow(
      ConflictError,
    )
  })
})
