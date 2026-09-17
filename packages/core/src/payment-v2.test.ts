import { describe, expect, it } from 'vitest'
import { projectPaymentStatus, V2PaymentStatus } from './payment-v2.js'

const base = {
  policyDecision: 'ALLOW' as const,
  approvalState: 'NOT_REQUIRED' as const,
  attemptOutcomes: [] as const,
  planExhausted: false,
}

describe('V2 payment status projection', () => {
  it('gives policy denial precedence over execution facts', () => {
    expect(
      projectPaymentStatus({
        ...base,
        policyDecision: 'DENY',
        attemptOutcomes: ['CONFIRMED'],
      }),
    ).toBe(V2PaymentStatus.REJECTED_BY_POLICY)
  })

  it('keeps approval pending before an attempt exists', () => {
    expect(projectPaymentStatus({ ...base, approvalState: 'PENDING' })).toBe(
      V2PaymentStatus.AWAITING_APPROVAL,
    )
  })

  it('holds review and unresolved states above ordinary failure', () => {
    expect(
      projectPaymentStatus({
        ...base,
        attemptOutcomes: ['UNKNOWN', 'FAILED'],
        reviewRequired: true,
      }),
    ).toBe(V2PaymentStatus.REVIEW_REQUIRED)
    expect(
      projectPaymentStatus({
        ...base,
        attemptOutcomes: ['UNKNOWN'],
        closedUnresolved: true,
      }),
    ).toBe(V2PaymentStatus.CLOSED_UNRESOLVED)
  })

  it('reports no effect only after the plan is exhausted', () => {
    expect(
      projectPaymentStatus({
        ...base,
        attemptOutcomes: ['PROVED_NO_EFFECT'],
        planExhausted: false,
      }),
    ).toBe(V2PaymentStatus.CREATED)
    expect(
      projectPaymentStatus({
        ...base,
        attemptOutcomes: ['PROVED_NO_EFFECT'],
        planExhausted: true,
      }),
    ).toBe(V2PaymentStatus.PROVED_NO_EFFECT)
  })
})
