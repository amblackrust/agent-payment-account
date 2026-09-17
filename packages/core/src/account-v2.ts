import { ConflictError, InvalidStateError, ValidationError } from './errors.js'

export const AgentAccountLifecycleStatus = {
  PROVISIONING: 'PROVISIONING',
  ACTIVE: 'ACTIVE',
  DISABLED: 'DISABLED',
  PROVISIONING_FAILED: 'PROVISIONING_FAILED',
} as const

export type AgentAccountLifecycleStatus =
  (typeof AgentAccountLifecycleStatus)[keyof typeof AgentAccountLifecycleStatus]

export const AgentCredentialStatus = {
  ACTIVE: 'ACTIVE',
  EXPIRED: 'EXPIRED',
  REVOKED: 'REVOKED',
  ROTATING: 'ROTATING',
} as const

export type AgentCredentialStatus =
  (typeof AgentCredentialStatus)[keyof typeof AgentCredentialStatus]

export const AGENT_CREDENTIAL_SCOPES = {
  PAYMENTS_CREATE: 'payments:create',
  PAYMENTS_READ: 'payments:read',
  RECIPIENTS_MANAGE: 'contacts:manage',
  RECEIVE_MANAGE: 'receive:manage',
  BALANCE_READ: 'balance:read',
  HISTORY_READ: 'history:read',
} as const

export type AgentCredentialScope =
  (typeof AGENT_CREDENTIAL_SCOPES)[keyof typeof AGENT_CREDENTIAL_SCOPES]

export const DEFAULT_AGENT_CREDENTIAL_SCOPES: readonly AgentCredentialScope[] = [
  AGENT_CREDENTIAL_SCOPES.PAYMENTS_CREATE,
  AGENT_CREDENTIAL_SCOPES.PAYMENTS_READ,
  AGENT_CREDENTIAL_SCOPES.RECIPIENTS_MANAGE,
  AGENT_CREDENTIAL_SCOPES.RECEIVE_MANAGE,
  AGENT_CREDENTIAL_SCOPES.BALANCE_READ,
  AGENT_CREDENTIAL_SCOPES.HISTORY_READ,
]

export function canTransitionAgentAccount(
  current: AgentAccountLifecycleStatus,
  next: AgentAccountLifecycleStatus,
): boolean {
  const transitions: Readonly<
    Record<AgentAccountLifecycleStatus, readonly AgentAccountLifecycleStatus[]>
  > = {
    PROVISIONING: ['ACTIVE', 'PROVISIONING_FAILED', 'DISABLED'],
    ACTIVE: ['DISABLED'],
    DISABLED: ['ACTIVE'],
    PROVISIONING_FAILED: ['PROVISIONING', 'DISABLED'],
  }
  return transitions[current].includes(next)
}

export function assertAgentAccountTransition(
  current: AgentAccountLifecycleStatus,
  next: AgentAccountLifecycleStatus,
): void {
  if (!canTransitionAgentAccount(current, next)) {
    throw new ConflictError(`Cannot transition account from ${current} to ${next}`)
  }
}

export function assertAccountCanStartMoneyOperation(
  status: AgentAccountLifecycleStatus,
): void {
  if (status !== AgentAccountLifecycleStatus.ACTIVE) {
    throw new InvalidStateError('Account must be ACTIVE for a money-changing operation')
  }
}

export function assertCredentialUsable(input: {
  readonly status: AgentCredentialStatus
  readonly expiresAt: Date | null
  readonly now?: Date
  readonly requiredScope: AgentCredentialScope
  readonly scopes: readonly AgentCredentialScope[]
}): void {
  const now = input.now ?? new Date()
  if (input.status !== AgentCredentialStatus.ACTIVE) {
    throw new InvalidStateError('Credential is not active')
  }
  if (input.expiresAt !== null && input.expiresAt <= now) {
    throw new InvalidStateError('Credential has expired')
  }
  if (!input.scopes.includes(input.requiredScope)) {
    throw new ValidationError(`Credential is missing scope ${input.requiredScope}`)
  }
}
