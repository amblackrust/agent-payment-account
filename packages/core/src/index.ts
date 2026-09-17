export {
  AuthenticationError,
  ApprovalRequiredError,
  AuthorizationError,
  ConflictError,
  CustodyUnavailableError,
  DependencyUnavailableError,
  DOMAIN_ERROR_CODES,
  DomainError,
  ExternalRailError,
  IdempotencyConflictError,
  InvalidStateError,
  InsufficientFundsError,
  InternalError,
  isDomainError,
  NotFoundError,
  PolicyDeniedError,
  RateLimitedError,
  RecipientResolutionError,
  ReviewRequiredError,
  RefundNotSupportedError,
  UnsupportedCurrencyError,
  UnsupportedRailError,
  ValidationError,
} from './errors.js'
export type {
  DomainErrorCode,
  RailFailureKind,
  SerializedDomainError,
} from './errors.js'

export {
  addMoney,
  compareMoney,
  createMoney,
  createPositiveMoney,
  CURRENCIES,
  formatMoney,
  moneyFromAtomicUnits,
  parseDecimalToAtomicUnits,
  subtractMoney,
  USD_DECIMAL_PLACES,
} from './money.js'
export type { AtomicUnits, Currency, Money } from './money.js'

export {
  addExactMoney,
  assertSameSettlementAsset,
  compareExactMoney,
  convertFromSettlementAtomicUnits,
  convertToSettlementAtomicUnits,
  createDenomination,
  createEconomicMapping,
  createSettlementAsset,
  DEFAULT_MAX_LOGICAL_MONEY_SCALE,
  exactMoneyFromAtomicUnits,
  formatExactMoney,
  parseExactMoney,
  subtractExactMoney,
  withAtomicUnits,
} from './exact-money.js'
export type {
  Denomination,
  DenominationInput,
  EconomicMapping,
  EconomicMappingInput,
  ExactMoney,
  LifecycleStatus,
  MoneyPrecisionConfig,
  SettlementAsset,
  SettlementAssetInput,
} from './exact-money.js'

export const MAX_REFERENCE_BYTES = 128

export {
  createAccountId,
  createCredentialId,
  createPaymentAttemptId,
  createPaymentId,
  createRecipientId,
  createReceiveId,
  parseAccountId,
  parseCredentialId,
  parsePaymentAttemptId,
  parsePaymentId,
  parseRecipientId,
  parseReceiveId,
} from './ids.js'
export type {
  AccountId,
  CredentialId,
  OpaqueId,
  PaymentAttemptId,
  PaymentId,
  RecipientId,
  ReceiveId,
} from './ids.js'

export {
  assertPaymentAttemptStatusTransition,
  assertPaymentStatusTransition,
  canTransitionPaymentAttemptStatus,
  canTransitionPaymentStatus,
  PaymentStatus,
} from './payment.js'
export type { PaymentAttemptStatus, PaymentKind, PaymentOperation } from './payment.js'

export {
  assertV2PaymentStatusTransition,
  projectPaymentStatus,
  V2PaymentStatus,
} from './payment-v2.js'
export type {
  ApprovalState,
  AttemptOutcome,
  PaymentPolicyDecision,
  PaymentStatusProjectionInput,
} from './payment-v2.js'

export {
  AGENT_CREDENTIAL_SCOPES,
  DEFAULT_AGENT_CREDENTIAL_SCOPES,
  AgentAccountLifecycleStatus,
  AgentCredentialStatus,
  assertAccountCanStartMoneyOperation,
  assertAgentAccountTransition,
  assertCredentialUsable,
  canTransitionAgentAccount,
} from './account-v2.js'
export type {
  AgentAccountLifecycleStatus as AgentAccountLifecycleStatusValue,
  AgentCredentialScope,
  AgentCredentialStatus as AgentCredentialStatusValue,
} from './account-v2.js'

export {
  evaluateSpendPolicy,
  policyDecisionFingerprint,
  SpendPolicyStatus,
  subtractHeldReservation,
} from './policy.js'
export type {
  PolicyDecision,
  SpendPolicy,
  SpendPolicyEvaluationInput,
} from './policy.js'

export { selectSettlementRoute } from './routing-v2.js'
export type {
  RouteCapability,
  SettlementRoute,
  SettlementRouteSelection,
  SettlementRouteSelectionInput,
  SettlementRouteStatus,
} from './routing-v2.js'

export {
  assertAttemptProgression,
  assertCanCreateNextAttempt,
  assertPaymentAttemptSequence,
  assertReservationCanBeReleased,
  assertReservationTransition,
  canCreateNextAttempt,
} from './payment-lifecycle-v2.js'
export type {
  PaymentAttemptOutcome,
  PaymentAttemptState,
  PaymentExecutionState,
  ReservationLifecycleStatus,
  ReservationState,
} from './payment-lifecycle-v2.js'

export { selectPaymentRail } from './router.js'
export type {
  PaymentRail,
  RailExecutionResult,
  RailExecutionStatus,
  RailDurableExecution,
  RailPaymentRequest,
  RailPreparationContext,
  RailPreparedPayment,
  RailRecoveryResult,
  RailRecipientDestination,
  RailQuote,
  RailStatusResult,
} from './rail.js'

export { classifyRailFailure, classifyWorkFailure, computeRetryAt } from './retry.js'
export type { RetryDecision, WorkRetryClass } from './retry.js'
