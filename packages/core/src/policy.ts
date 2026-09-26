import {
  compareExactMoney,
  subtractExactMoney,
  withAtomicUnits,
  type ExactMoney,
} from './exact-money.js'
import { ConflictError, ValidationError } from './errors.js'

export const SpendPolicyStatus = {
  DRAFT: 'DRAFT',
  ACTIVE: 'ACTIVE',
  RETIRED: 'RETIRED',
} as const

export type SpendPolicyStatus =
  (typeof SpendPolicyStatus)[keyof typeof SpendPolicyStatus]

export interface SpendPolicy {
  readonly id: string
  readonly accountId: string
  readonly version: number
  readonly status: SpendPolicyStatus
  readonly maxPerPayment: ExactMoney | null
  readonly rollingBudget: ExactMoney | null
  readonly rollingWindowSeconds: number | null
  readonly transactionCountCap: number | null
  readonly approvalThreshold: ExactMoney | null
  readonly rollingBudgetEscalatable: boolean
  readonly transactionCountEscalatable: boolean
}

export interface SpendPolicyEvaluationInput {
  readonly policy: SpendPolicy
  readonly amount: ExactMoney
  readonly destinationApproved: boolean
  readonly confirmedSpend: ExactMoney
  readonly heldReservations: ExactMoney
  readonly unresolvedSpend: ExactMoney
  readonly transactionCount: number
}

export interface PolicyDecision {
  readonly decision: 'ALLOW' | 'REQUIRE_APPROVAL' | 'DENY'
  readonly reasonCodes: readonly string[]
  readonly policyId: string
  readonly policyVersion: number
  readonly evaluatedAmount: ExactMoney
  readonly context: Readonly<{
    confirmedSpend: ExactMoney
    heldReservations: ExactMoney
    unresolvedSpend: ExactMoney
    transactionCount: number
  }>
  readonly escalatable: boolean
}

export function evaluateSpendPolicy(input: SpendPolicyEvaluationInput): PolicyDecision {
  assertMoneyCompatibility(input)
  if (input.policy.status !== SpendPolicyStatus.ACTIVE) {
    throw new ValidationError('Only an ACTIVE spend policy can be evaluated')
  }
  if (input.transactionCount < 0 || !Number.isInteger(input.transactionCount)) {
    throw new ValidationError('Transaction count must be a non-negative integer')
  }

  const denied: string[] = []
  let escalatable = true
  if (!input.destinationApproved) {
    denied.push('DESTINATION_NOT_APPROVED')
    escalatable = false
  }
  if (
    input.policy.maxPerPayment !== null &&
    compareExactMoney(input.amount, input.policy.maxPerPayment) > 0
  ) {
    denied.push('PER_PAYMENT_LIMIT_EXCEEDED')
    escalatable = false
  }

  const budgetUsed = addPolicyAmounts(input)
  if (
    input.policy.rollingBudget !== null &&
    compareExactMoney(budgetUsed, input.policy.rollingBudget) > 0
  ) {
    denied.push('ROLLING_BUDGET_EXCEEDED')
    if (!input.policy.rollingBudgetEscalatable) escalatable = false
  }
  if (
    input.policy.transactionCountCap !== null &&
    input.transactionCount + 1 > input.policy.transactionCountCap
  ) {
    denied.push('TRANSACTION_COUNT_CAP_EXCEEDED')
    if (!input.policy.transactionCountEscalatable) escalatable = false
  }

  if (denied.length > 0) {
    return decision(input, 'DENY', denied, escalatable)
  }

  if (
    input.policy.approvalThreshold !== null &&
    compareExactMoney(input.amount, input.policy.approvalThreshold) >= 0
  ) {
    return decision(input, 'REQUIRE_APPROVAL', ['APPROVAL_THRESHOLD'], true)
  }
  return decision(input, 'ALLOW', [], true)
}

export function policyDecisionFingerprint(decision: PolicyDecision): string {
  return JSON.stringify({
    decision: decision.decision,
    reason_codes: [...decision.reasonCodes],
    policy_id: decision.policyId,
    policy_version: decision.policyVersion,
    amount: {
      denomination_id: decision.evaluatedAmount.denominationId,
      atomic_units: decision.evaluatedAmount.atomicUnits.toString(),
      scale: decision.evaluatedAmount.scale,
    },
    context: {
      confirmed_spend: decision.context.confirmedSpend.atomicUnits.toString(),
      held_reservations: decision.context.heldReservations.atomicUnits.toString(),
      unresolved_spend: decision.context.unresolvedSpend.atomicUnits.toString(),
      transaction_count: decision.context.transactionCount,
    },
  })
}

function addPolicyAmounts(input: SpendPolicyEvaluationInput): ExactMoney {
  const current = input.confirmedSpend.atomicUnits + input.heldReservations.atomicUnits
  const total = current + input.unresolvedSpend.atomicUnits + input.amount.atomicUnits
  return withAtomicUnits(input.amount, total)
}

function decision(
  input: SpendPolicyEvaluationInput,
  value: PolicyDecision['decision'],
  reasonCodes: readonly string[],
  escalatable: boolean,
): PolicyDecision {
  return {
    decision: value,
    reasonCodes,
    policyId: input.policy.id,
    policyVersion: input.policy.version,
    evaluatedAmount: input.amount,
    context: {
      confirmedSpend: input.confirmedSpend,
      heldReservations: input.heldReservations,
      unresolvedSpend: input.unresolvedSpend,
      transactionCount: input.transactionCount,
    },
    escalatable,
  }
}

function assertMoneyCompatibility(input: SpendPolicyEvaluationInput): void {
  const values = [
    input.amount,
    input.confirmedSpend,
    input.heldReservations,
    input.unresolvedSpend,
    input.policy.maxPerPayment,
    input.policy.rollingBudget,
    input.policy.approvalThreshold,
  ].filter((value): value is ExactMoney => value !== null)
  const first = values[0]
  if (first === undefined) throw new ValidationError('Policy amount is missing')
  for (const value of values.slice(1)) {
    if (value.denominationId !== first.denominationId || value.scale !== first.scale) {
      throw new ConflictError('Policy amounts must use one denomination and scale')
    }
  }
}

// Keep the import visible at the boundary: this prevents policy callers from
// accidentally implementing their own underflow behavior.
export const subtractHeldReservation = subtractExactMoney
