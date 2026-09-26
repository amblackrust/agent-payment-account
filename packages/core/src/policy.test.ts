import { describe, expect, it } from 'vitest'
import { createDenomination, parseExactMoney } from './exact-money.js'
import { evaluateSpendPolicy } from './policy.js'

const denomination = createDenomination({ id: 'denom_usd', symbol: 'USD', maxScale: 2 })
const money = (value: string) => parseExactMoney(value, denomination)

const policy = {
  id: 'policy_1',
  accountId: 'acct_1',
  version: 1,
  status: 'ACTIVE' as const,
  maxPerPayment: money('10'),
  rollingBudget: money('20'),
  rollingWindowSeconds: 3_600,
  transactionCountCap: 3,
  approvalThreshold: money('5'),
  rollingBudgetEscalatable: true,
  transactionCountEscalatable: true,
}

describe('spend policy', () => {
  it('evaluates hard denials before approval escalation', () => {
    const result = evaluateSpendPolicy({
      policy,
      amount: money('11'),
      destinationApproved: true,
      confirmedSpend: money('0'),
      heldReservations: money('0'),
      unresolvedSpend: money('0'),
      transactionCount: 0,
    })
    expect(result.decision).toBe('DENY')
    expect(result.reasonCodes).toContain('PER_PAYMENT_LIMIT_EXCEEDED')
  })

  it('counts held and unresolved reservations in the rolling budget', () => {
    const result = evaluateSpendPolicy({
      policy,
      amount: money('2'),
      destinationApproved: true,
      confirmedSpend: money('10'),
      heldReservations: money('5'),
      unresolvedSpend: money('4'),
      transactionCount: 0,
    })
    expect(result.decision).toBe('DENY')
    expect(result.reasonCodes).toContain('ROLLING_BUDGET_EXCEEDED')
  })

  it('requires approval only for an explicitly escalatable threshold', () => {
    const result = evaluateSpendPolicy({
      policy,
      amount: money('5'),
      destinationApproved: true,
      confirmedSpend: money('0'),
      heldReservations: money('0'),
      unresolvedSpend: money('0'),
      transactionCount: 0,
    })
    expect(result.decision).toBe('REQUIRE_APPROVAL')
  })
})
