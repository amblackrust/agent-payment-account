import { createHash, randomBytes } from 'node:crypto'
import {
  createDenomination,
  createCredentialId,
  createEconomicMapping,
  createSettlementAsset,
  DependencyUnavailableError,
  exactMoneyFromAtomicUnits,
  formatExactMoney,
  IdempotencyConflictError,
  IdempotencyKeyReusedError,
  InvalidStateError,
  normalizeAgentCredentialScopes,
  NotFoundError,
  parseExactMoney,
  selectSettlementRoute,
  ValidationError,
  type AgentCredentialScope,
  type AgentAccountLifecycleStatus,
  type EconomicMapping,
  type SettlementAsset,
} from '@agent-payment/core'
import type {
  AuthenticatedAccount,
  V2AdminRepository,
  V2AccountRecord,
  V2ApprovalAdminRecord,
  V2AdminApprovedDestinationRecord,
  V2CredentialRecord,
  V2DatabaseRepository,
  V2HistoryRecord,
  V2SpendPolicyAdminRecord,
} from '@agent-payment/db'
import { generateApiCredential } from './auth.js'
import { DEFAULT_CREDENTIAL_RECOVERY_TTL_SECONDS } from './config.js'
import type { RecoveryEnvelopeCipher } from './custody.js'
import type { V2SettledBalanceProvider } from './payments-v2.js'

const DEFAULT_MAX_PAGE_SIZE = 100

export interface V2ManagementServiceOptions {
  readonly repository: V2AdminRepository
  readonly financialRepository: V2DatabaseRepository
  readonly settledBalanceProvider?: V2SettledBalanceProvider
  readonly recoveryCipher?: RecoveryEnvelopeCipher
  readonly credentialRecoveryTtlSeconds?: number
  readonly maxPageSize?: number
  readonly now?: () => Date
}

export class V2ManagementService {
  private readonly now: () => Date
  private readonly maxPageSize: number
  private readonly credentialRecoveryTtlSeconds: number

  public constructor(private readonly options: V2ManagementServiceOptions) {
    this.now = options.now ?? (() => new Date())
    this.maxPageSize = options.maxPageSize ?? DEFAULT_MAX_PAGE_SIZE
    this.credentialRecoveryTtlSeconds =
      options.credentialRecoveryTtlSeconds ?? DEFAULT_CREDENTIAL_RECOVERY_TTL_SECONDS
    if (!Number.isInteger(this.maxPageSize) || this.maxPageSize < 1) {
      throw new InvalidStateError('Maximum page size must be a positive integer')
    }
    if (
      !Number.isInteger(this.credentialRecoveryTtlSeconds) ||
      this.credentialRecoveryTtlSeconds < 1
    ) {
      throw new InvalidStateError('Credential recovery TTL must be a positive integer')
    }
  }

  public async getAccount(accountId: string) {
    const account = await this.options.repository.findAccount(accountId)
    if (account === null) throw new NotFoundError('Agent account was not found')
    return {
      id: account.id,
      name: account.name,
      status: account.status,
      solana_public_key: account.solanaPublicKey,
      workspace_id: account.workspaceId,
      runtime_version: account.runtimeVersion,
      provisioning_failure_code: account.provisioningFailureCode,
      disabled_at: account.disabledAt?.toISOString() ?? null,
      disabled_reason: account.disabledReason,
      row_version: account.rowVersion,
      created_at: account.createdAt.toISOString(),
      updated_at: account.updatedAt.toISOString(),
    }
  }

  public async transitionAccount(input: {
    readonly accountId: string
    readonly currentStatus: AgentAccountLifecycleStatus
    readonly nextStatus: AgentAccountLifecycleStatus
    readonly rowVersion: number
    readonly reason?: string
    readonly actorId?: string
  }) {
    const account = await this.options.repository.transitionAccount(input)
    return {
      id: account.id,
      status: account.status,
      row_version: account.rowVersion,
      disabled_at: account.disabledAt?.toISOString() ?? null,
      disabled_reason: account.disabledReason,
      provisioning_failure_code: account.provisioningFailureCode,
    }
  }

  public async listCredentials(accountId: string) {
    await this.requireAccount(accountId)
    const credentials = await this.options.repository.listCredentials(accountId)
    return credentials.map((credential) => ({
      id: credential.id,
      account_id: credential.accountId,
      status: credential.status,
      scopes: [...credential.scopes],
      expires_at: credential.expiresAt?.toISOString() ?? null,
      rotated_from_id: credential.rotatedFromId,
      row_version: credential.rowVersion,
      created_at: credential.createdAt.toISOString(),
      revoked_at: credential.revokedAt?.toISOString() ?? null,
    }))
  }

  public async createCredential(input: {
    readonly accountId: string
    readonly scopes: readonly string[]
    readonly expiresAt?: string
    readonly idempotencyKey: string
    readonly actorId: string
  }) {
    if (this.options.recoveryCipher === undefined) {
      throw new DependencyUnavailableError('Credential recovery is unavailable')
    }
    const account = await this.requireAccount(input.accountId)
    const requestFingerprint = fingerprintCredentialRequest(
      input.scopes,
      input.expiresAt,
    )
    const existing = await this.options.repository.findCredentialIdempotency({
      accountId: input.accountId,
      idempotencyKey: input.idempotencyKey,
    })
    if (existing !== null) {
      if (
        existing.requestHash !== requestFingerprint ||
        existing.fingerprint !== requestFingerprint
      ) {
        throw new IdempotencyKeyReusedError()
      }
      const recovered = await this.recoverIssuedCredential(
        input.accountId,
        credentialRecoveryKey(input.accountId, input.idempotencyKey),
        existing.credential,
      )
      return {
        created: false,
        ...serializeIssuedCredential(existing.credential, recovered),
      }
    }
    if (account.status !== 'ACTIVE') {
      throw new InvalidStateError('Agent account is not active')
    }
    const scopes = normalizeAgentCredentialScopes(input.scopes)
    const expiresAt = parseCredentialExpiry(input.expiresAt, this.now())
    const fingerprint = requestFingerprint
    const credential = generateApiCredential()
    const recoveryIdempotencyKey = credentialRecoveryKey(
      input.accountId,
      input.idempotencyKey,
    )
    const recovery = this.options.recoveryCipher.encrypt(
      new TextEncoder().encode(credential.rawKey),
    )
    const stored = await this.options.repository.createCredential({
      accountId: input.accountId,
      idempotencyKey: input.idempotencyKey,
      requestHash: fingerprint,
      fingerprint,
      credentialId: createCredentialId(),
      keyHash: credential.keyHash,
      keyPrefix: credential.keyPrefix,
      scopes,
      ...(expiresAt === undefined ? {} : { expiresAt }),
      recoveryCiphertext: recovery.ciphertext,
      recoveryNonce: recovery.nonce,
      recoveryAuthTag: recovery.authTag,
      recoveryIdempotencyKey,
      recoveryExpiresAt: new Date(
        this.now().getTime() + this.credentialRecoveryTtlSeconds * 1000,
      ),
      actorId: input.actorId,
    })
    if (stored.created) {
      return {
        created: true,
        ...serializeIssuedCredential(stored.credential, credential.rawKey),
      }
    }

    const recovered = await this.recoverIssuedCredential(
      input.accountId,
      recoveryIdempotencyKey,
      stored.credential,
    )
    return {
      created: false,
      ...serializeIssuedCredential(stored.credential, recovered),
    }
  }

  public async acknowledgeCredentialRecovery(
    accountId: string,
    idempotencyKey: string,
  ): Promise<void> {
    await this.requireAccount(accountId)
    await this.options.repository.acknowledgeRecoveryEnvelope(
      accountId,
      credentialRecoveryKey(accountId, idempotencyKey),
    )
  }

  public async rotateCredential(
    accountId: string,
    oldCredentialId: string,
    idempotencyKey: string,
    scopes?: readonly string[],
    actorId?: string,
  ) {
    if (this.options.recoveryCipher === undefined) {
      throw new DependencyUnavailableError('Credential recovery is unavailable')
    }
    await this.requireAccount(accountId)
    const recoveryIdempotencyKey = `CREDENTIAL_ROTATION:${accountId}:${idempotencyKey}`
    const recovered = await this.recoverRotatedCredential(
      accountId,
      oldCredentialId,
      recoveryIdempotencyKey,
      scopes,
    )
    if (recovered !== null) return recovered
    const existingCredential = (
      await this.options.repository.listCredentials(accountId)
    ).find((candidate) => candidate.id === oldCredentialId)
    if (existingCredential === undefined || existingCredential.status !== 'ACTIVE') {
      throw new NotFoundError('Credential was not found or already revoked')
    }
    const credential = generateApiCredential()
    const recovery = this.options.recoveryCipher.encrypt(
      new TextEncoder().encode(credential.rawKey),
    )
    try {
      const stored = await this.options.repository.rotateCredential({
        accountId,
        oldCredentialId,
        newCredentialId: createCredentialId(),
        keyHash: credential.keyHash,
        keyPrefix: credential.keyPrefix,
        scopes: scopes ?? existingCredential.scopes,
        recoveryCiphertext: recovery.ciphertext,
        recoveryNonce: recovery.nonce,
        recoveryAuthTag: recovery.authTag,
        recoveryIdempotencyKey,
        recoveryExpiresAt: new Date(
          this.now().getTime() + this.credentialRecoveryTtlSeconds * 1000,
        ),
        ...(actorId === undefined ? {} : { actorId }),
      })
      return serializeRotatedCredential(stored, credential.rawKey, credential.keyPrefix)
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error
      const concurrentRecovery = await this.recoverRotatedCredential(
        accountId,
        oldCredentialId,
        recoveryIdempotencyKey,
        scopes,
      )
      if (concurrentRecovery !== null) return concurrentRecovery
      throw error
    }
  }

  private async recoverRotatedCredential(
    accountId: string,
    oldCredentialId: string,
    recoveryIdempotencyKey: string,
    scopes: readonly string[] | undefined,
  ) {
    const envelope = await this.options.repository.consumeRecoveryEnvelope(
      accountId,
      recoveryIdempotencyKey,
      this.now(),
    )
    if (envelope === null) return null
    const recoveredCredential = (
      await this.options.repository.listCredentials(accountId)
    ).find((candidate) => candidate.id === envelope.credentialId)
    if (recoveredCredential === undefined) {
      throw new InvalidStateError('Recovered credential is unavailable')
    }
    if (recoveredCredential.rotatedFromId !== oldCredentialId) {
      throw new IdempotencyConflictError()
    }
    if (scopes !== undefined && !sameScopes(scopes, recoveredCredential.scopes)) {
      throw new IdempotencyConflictError()
    }
    const secret = this.options.recoveryCipher!.decrypt({
      ciphertext: envelope.ciphertext,
      nonce: envelope.nonce,
      authTag: envelope.authTag,
    })
    const rawKey = decodeOneTimeSecret(secret)
    return serializeRotatedCredential(recoveredCredential, rawKey, rawKey.slice(0, 12))
  }

  private async recoverIssuedCredential(
    accountId: string,
    recoveryIdempotencyKey: string,
    credential: V2CredentialRecord,
  ): Promise<string | null> {
    const envelope = await this.options.repository.consumeRecoveryEnvelope(
      accountId,
      recoveryIdempotencyKey,
      this.now(),
    )
    if (envelope === null) return null
    if (envelope.credentialId !== credential.id) {
      throw new InvalidStateError('Recovered credential does not match request')
    }
    const secret = this.options.recoveryCipher!.decrypt({
      ciphertext: envelope.ciphertext,
      nonce: envelope.nonce,
      authTag: envelope.authTag,
    })
    return decodeOneTimeSecret(secret)
  }

  public async revokeCredential(
    accountId: string,
    credentialId: string,
    actorId?: string,
  ): Promise<void> {
    await this.requireAccount(accountId)
    await this.options.repository.revokeCredential(accountId, credentialId, actorId)
  }

  public async listPolicies(accountId: string) {
    await this.requireAccount(accountId)
    return Promise.all(
      (await this.options.repository.listSpendPolicies(accountId)).map((policy) =>
        this.serializePolicy(policy),
      ),
    )
  }

  public async getPolicy(accountId: string) {
    const policies = await this.listPolicies(accountId)
    const active = policies.find((policy) => policy.status === 'ACTIVE')
    if (active === undefined)
      throw new NotFoundError('No active spend policy is configured')
    return active
  }

  public async createPolicy(input: {
    readonly accountId: string
    readonly denominationId: string
    readonly maxPerPayment?: string | null
    readonly rollingBudget?: string | null
    readonly rollingWindowSeconds?: number | null
    readonly transactionCountCap?: number | null
    readonly approvalThreshold?: string | null
    readonly rollingBudgetEscalatable?: boolean
    readonly transactionCountEscalatable?: boolean
    readonly actorId?: string
  }) {
    await this.requireAccount(input.accountId)
    const denomination = await this.loadDenomination(input.denominationId)
    const parseOptional = (value: string | null | undefined) =>
      value === undefined || value === null
        ? null
        : parseExactMoney(value, denomination).atomicUnits
    const policy = await this.options.repository.createSpendPolicy({
      id: createId('policy'),
      accountId: input.accountId,
      denominationId: denomination.id,
      maxPerPaymentAtomic: parseOptional(input.maxPerPayment),
      rollingBudgetAtomic: parseOptional(input.rollingBudget),
      rollingWindowSeconds: input.rollingWindowSeconds ?? null,
      transactionCountCap: input.transactionCountCap ?? null,
      approvalThresholdAtomic: parseOptional(input.approvalThreshold),
      rollingBudgetEscalatable: input.rollingBudgetEscalatable ?? false,
      transactionCountEscalatable: input.transactionCountEscalatable ?? false,
      rulesJson: '{}',
      ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
    })
    return this.serializePolicy(policy)
  }

  public async replacePolicy(input: {
    readonly accountId: string
    readonly denominationId: string
    readonly maxPerPayment?: string | null
    readonly rollingBudget?: string | null
    readonly rollingWindowSeconds?: number | null
    readonly transactionCountCap?: number | null
    readonly approvalThreshold?: string | null
    readonly rollingBudgetEscalatable?: boolean
    readonly transactionCountEscalatable?: boolean
    readonly expectedVersion?: number
    readonly actorId: string
  }) {
    await this.requireAccount(input.accountId)
    const denomination = await this.loadDenomination(input.denominationId)
    const parseOptional = (value: string | null | undefined) =>
      value === undefined || value === null
        ? null
        : parseExactMoney(value, denomination).atomicUnits
    const policy = await this.options.repository.replaceSpendPolicy({
      id: createId('policy'),
      accountId: input.accountId,
      denominationId: denomination.id,
      maxPerPaymentAtomic: parseOptional(input.maxPerPayment),
      rollingBudgetAtomic: parseOptional(input.rollingBudget),
      rollingWindowSeconds: input.rollingWindowSeconds ?? null,
      transactionCountCap: input.transactionCountCap ?? null,
      approvalThresholdAtomic: parseOptional(input.approvalThreshold),
      rollingBudgetEscalatable: input.rollingBudgetEscalatable ?? false,
      transactionCountEscalatable: input.transactionCountEscalatable ?? false,
      rulesJson: '{}',
      ...(input.expectedVersion === undefined
        ? {}
        : { expectedVersion: input.expectedVersion }),
      actorId: input.actorId,
    })
    return this.serializePolicy(policy)
  }

  public async activatePolicy(
    accountId: string,
    policyId: string,
    version?: number,
    actorId?: string,
  ) {
    await this.requireAccount(accountId)
    return this.serializePolicy(
      await this.options.repository.activateSpendPolicy(
        accountId,
        policyId,
        version,
        actorId,
      ),
    )
  }

  public async listApprovals(accountId: string) {
    await this.requireAccount(accountId)
    return (await this.options.repository.listApprovals(accountId)).map(
      serializeApproval,
    )
  }

  public async decideApproval(input: {
    readonly accountId: string
    readonly approvalId: string
    readonly action: 'APPROVE' | 'REJECT' | 'EXPIRE'
    readonly actorId: string
    readonly comment?: string
    readonly rowVersion: number
  }) {
    const approval = await this.findApproval(input.accountId, input.approvalId)
    let settledAtomic: bigint | undefined
    if (input.action === 'APPROVE') {
      if (this.options.settledBalanceProvider === undefined) {
        throw new DependencyUnavailableError(
          'Settlement balance provider is unavailable',
        )
      }
      const view = await this.options.financialRepository.findPaymentView(
        input.accountId,
        approval.paymentId,
      )
      if (view === null || view.payment.denominationId === null) {
        throw new InvalidStateError('Approval payment is missing its denomination')
      }
      const denomination = await this.loadDenomination(view.payment.denominationId)
      const account = await this.requireAccount(input.accountId)
      const settlementContext = await this.loadSettlementContext(
        denomination,
        view.payment.routeId,
      )
      settledAtomic = await this.options.settledBalanceProvider.getSettledAtomic({
        account: toAuthenticatedAccount(account),
        denomination,
        ...settlementContext,
      })
    }
    return serializeApproval(
      await this.options.repository.decideApproval({
        ...input,
        ...(settledAtomic === undefined ? {} : { settledAtomic }),
        now: this.now(),
      }),
    )
  }

  public async listApprovedDestinations(accountId: string) {
    await this.requireAccount(accountId)
    return (await this.options.repository.listApprovedDestinations(accountId)).map(
      serializeApprovedDestination,
    )
  }

  public async createApprovedDestination(input: {
    readonly accountId: string
    readonly fingerprint: string
    readonly rail: string
    readonly network: string
    readonly assetReference: string
    readonly destination: string
    readonly actorId: string
    readonly reason?: string
  }) {
    await this.requireAccount(input.accountId)
    return serializeApprovedDestination(
      await this.options.repository.createApprovedDestination({
        id: createId('approved'),
        ...input,
      }),
    )
  }

  public async revokeApprovedDestination(input: {
    readonly accountId: string
    readonly id: string
    readonly actorId: string
    readonly reason: string
  }): Promise<void> {
    await this.requireAccount(input.accountId)
    await this.options.repository.revokeApprovedDestination(input)
  }

  public async archiveRecipient(input: {
    readonly ownerAccountId: string
    readonly recipientId: string
    readonly rowVersion: number
  }): Promise<void> {
    await this.options.financialRepository.archiveRecipient(input)
  }

  public async getFundingDestination(accountId: string, routeId?: string) {
    await this.requireAccount(accountId)
    const destination = await this.options.repository.findFundingDestination(
      accountId,
      routeId,
    )
    if (destination === null) {
      return {
        id: null,
        account_id: accountId,
        route_id: routeId ?? null,
        network: null,
        asset_id: null,
        destination: null,
        readiness: 'UNAVAILABLE' as const,
        sender_constraints: {},
        last_validated_at: null,
        last_failure_code: 'FUNDING_DESTINATION_UNAVAILABLE',
      }
    }
    return {
      id: destination.id,
      account_id: destination.accountId,
      route_id: destination.routeId,
      network: destination.network,
      asset_id: destination.assetId,
      destination: destination.destination,
      readiness: destination.readiness,
      sender_constraints: parseJsonObject(destination.senderConstraintsJson),
      last_validated_at: destination.lastValidatedAt?.toISOString() ?? null,
      last_failure_code: destination.lastFailureCode,
    }
  }

  public async getBalance(accountId: string, denominationId: string) {
    if (this.options.settledBalanceProvider === undefined) {
      throw new DependencyUnavailableError('Settlement balance provider is unavailable')
    }
    const account = await this.requireAccount(accountId)
    if (account.status !== 'ACTIVE') {
      throw new InvalidStateError('Account is not active')
    }
    const denomination = await this.loadDenomination(denominationId)
    const settlementContext = await this.loadSettlementContext(denomination)
    const context = await this.options.financialRepository.getSpendContext(
      accountId,
      denominationId,
      this.now(),
    )
    const settledAtomic = await this.options.settledBalanceProvider.getSettledAtomic({
      account: toAuthenticatedAccount(account),
      denomination,
      ...settlementContext,
    })
    if (settledAtomic < 0n)
      throw new InvalidStateError('Settlement balance cannot be negative')
    const reservedAtomic = context.heldReservationAtomic
    const spendableAtomic =
      settledAtomic > reservedAtomic ? settledAtomic - reservedAtomic : 0n
    return {
      account_id: accountId,
      denomination_id: denominationId,
      settled: formatExactMoney(exactMoneyFromAtomicUnits(settledAtomic, denomination)),
      reserved: formatExactMoney(
        exactMoneyFromAtomicUnits(reservedAtomic, denomination),
      ),
      spendable: formatExactMoney(
        exactMoneyFromAtomicUnits(spendableAtomic, denomination),
      ),
      observed_at: this.now().toISOString(),
      degraded: false,
    }
  }

  public async listHistory(
    accountId: string,
    input: { readonly limit?: number; readonly cursor?: string } = {},
  ) {
    const limit = input.limit ?? 50
    if (!Number.isInteger(limit) || limit < 1 || limit > this.maxPageSize) {
      throw new ValidationError(
        `History limit must be an integer from 1 to ${this.maxPageSize}`,
      )
    }
    const cursor = decodeCursor(input.cursor)
    const records = await this.options.repository.listHistory({
      accountId,
      limit: limit + 1,
      ...(cursor === undefined ? {} : { cursor }),
    })
    const visible = records.slice(0, limit)
    return {
      items: await Promise.all(visible.map((record) => this.serializeHistory(record))),
      next_cursor:
        records.length > limit && visible.at(-1) !== undefined
          ? encodeCursor(visible.at(-1)!.occurredAt, visible.at(-1)!.id)
          : null,
    }
  }

  private async serializeHistory(record: V2HistoryRecord) {
    const denomination =
      record.denominationId === null
        ? null
        : await this.loadDenomination(record.denominationId)
    return {
      id: record.id,
      direction: record.direction,
      kind: record.kind,
      status: record.status,
      amount:
        denomination === null
          ? record.amountAtomic.toString()
          : formatExactMoney(
              exactMoneyFromAtomicUnits(record.amountAtomic, denomination),
            ),
      denomination_id: record.denominationId,
      currency: record.currency,
      recipient_id: record.recipientId,
      external_id: record.externalId,
      occurred_at: record.occurredAt.toISOString(),
    }
  }

  private async serializePolicy(policy: V2SpendPolicyAdminRecord) {
    const denomination = await this.loadDenomination(policy.denominationId)
    const format = (value: bigint | null) =>
      value === null
        ? null
        : formatExactMoney(exactMoneyFromAtomicUnits(value, denomination))
    return {
      id: policy.id,
      account_id: policy.accountId,
      version: policy.version,
      status: policy.status,
      denomination_id: policy.denominationId,
      max_per_payment: format(policy.maxPerPaymentAtomic),
      rolling_budget: format(policy.rollingBudgetAtomic),
      rolling_window_seconds: policy.rollingWindowSeconds,
      transaction_count_cap: policy.transactionCountCap,
      approval_threshold: format(policy.approvalThresholdAtomic),
      rolling_budget_escalatable: policy.rollingBudgetEscalatable,
      transaction_count_escalatable: policy.transactionCountEscalatable,
      created_at: policy.createdAt.toISOString(),
      activated_at: policy.activatedAt?.toISOString() ?? null,
      retired_at: policy.retiredAt?.toISOString() ?? null,
    }
  }

  private async loadDenomination(id: string) {
    const record = await this.options.financialRepository.findDenomination(id)
    if (record === null) throw new NotFoundError('Denomination was not found')
    return createDenomination({
      id: record.id,
      symbol: record.symbol,
      maxScale: record.maxScale,
      status: record.status as 'ACTIVE' | 'RETIRED',
      version: record.version,
    })
  }

  private async requireAccount(accountId: string) {
    const account = await this.options.repository.findAccount(accountId)
    if (account === null) throw new NotFoundError('Agent account was not found')
    return account
  }

  private async findApproval(
    accountId: string,
    approvalId: string,
  ): Promise<V2ApprovalAdminRecord> {
    const approval = (await this.options.repository.listApprovals(accountId)).find(
      (candidate) => candidate.id === approvalId,
    )
    if (approval === undefined) throw new NotFoundError('Approval was not found')
    return approval
  }

  private async loadSettlementContext(
    denomination: ReturnType<typeof createDenomination>,
    routeId?: string | null,
  ): Promise<{
    readonly economicMapping: EconomicMapping
    readonly settlementAsset: SettlementAsset
  }> {
    const route =
      routeId === undefined || routeId === null
        ? selectSettlementRoute(
            {},
            await this.options.financialRepository.listActiveSettlementRoutes(),
          ).route
        : await this.options.financialRepository.findSettlementRoute(routeId)
    if (route === null || route === undefined) {
      throw new DependencyUnavailableError(
        'Settlement route configuration is unavailable',
      )
    }
    const [assetRecord, mappingRecord] = await Promise.all([
      this.options.financialRepository.findSettlementAsset(route.settlementAssetId),
      this.options.financialRepository.findEconomicMapping(route.economicMappingId),
    ])
    if (assetRecord === null || mappingRecord === null) {
      throw new DependencyUnavailableError(
        'Settlement route financial configuration is unavailable',
      )
    }
    const settlementAsset = createSettlementAsset({
      id: assetRecord.id,
      rail: assetRecord.rail,
      network: assetRecord.network,
      assetReference: assetRecord.assetReference,
      decimals: assetRecord.decimals,
      status: asLifecycleStatus(assetRecord.status),
      version: assetRecord.version,
    })
    const economicMapping = createEconomicMapping({
      id: mappingRecord.id,
      denominationId: mappingRecord.denominationId,
      settlementAssetId: mappingRecord.settlementAssetId,
      numerator: mappingRecord.numerator,
      denominator: mappingRecord.denominator,
      status: asLifecycleStatus(mappingRecord.status),
      version: mappingRecord.version,
    })
    if (
      economicMapping.denominationId !== denomination.id ||
      economicMapping.settlementAssetId !== settlementAsset.id
    ) {
      throw new InvalidStateError(
        'Settlement route mapping does not match the requested denomination',
      )
    }
    return { economicMapping, settlementAsset }
  }
}

function serializeRotatedCredential(
  credential: V2CredentialRecord,
  rawKey: string,
  keyPrefix: string,
) {
  return {
    credential_id: credential.id,
    account_id: credential.accountId,
    api_key: rawKey,
    key_prefix: keyPrefix,
    scopes: [...credential.scopes],
    expires_at: credential.expiresAt?.toISOString() ?? null,
  }
}

function serializeIssuedCredential(
  credential: V2CredentialRecord,
  rawKey: string | null,
) {
  return {
    credential_id: credential.id,
    account_id: credential.accountId,
    api_key: rawKey,
    key_prefix: credential.keyPrefix,
    scopes: [...credential.scopes],
    expires_at: credential.expiresAt?.toISOString() ?? null,
  }
}

function parseCredentialExpiry(value: string | undefined, now: Date): Date | undefined {
  if (value === undefined) return undefined
  const expiresAt = new Date(value)
  if (Number.isNaN(expiresAt.getTime())) {
    throw new ValidationError('Credential expires_at must be a valid timestamp')
  }
  if (expiresAt <= now) {
    throw new ValidationError('Credential expires_at must be in the future')
  }
  return expiresAt
}

function hashCredentialRequest(input: {
  readonly scopes: readonly string[]
  readonly expires_at: string | null
}): string {
  return createHash('sha256').update(JSON.stringify(input), 'utf8').digest('hex')
}

function fingerprintCredentialRequest(
  scopes: readonly string[],
  expiresAt: string | undefined,
): string {
  const parsedExpiry = expiresAt === undefined ? undefined : new Date(expiresAt)
  return hashCredentialRequest({
    scopes: [...scopes].sort(),
    expires_at:
      parsedExpiry === undefined
        ? null
        : Number.isNaN(parsedExpiry.getTime())
          ? (expiresAt ?? null)
          : parsedExpiry.toISOString(),
  })
}

function credentialRecoveryKey(accountId: string, idempotencyKey: string): string {
  const keyHash = createHash('sha256').update(idempotencyKey, 'utf8').digest('hex')
  return `CREDENTIAL_CREATE:${accountId}:${keyHash}`
}

function sameScopes(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length && left.every((scope, index) => scope === right[index])
  )
}

function decodeOneTimeSecret(secret: Uint8Array): string {
  try {
    const value = new TextDecoder().decode(secret)
    if (value.length === 0) throw new InvalidStateError('Recovered credential is empty')
    return value
  } finally {
    secret.fill(0)
  }
}

function asLifecycleStatus(status: string): 'ACTIVE' | 'RETIRED' {
  if (status === 'ACTIVE' || status === 'RETIRED') return status
  throw new InvalidStateError('Financial configuration has an invalid lifecycle status')
}

function serializeApproval(approval: V2ApprovalAdminRecord) {
  return {
    id: approval.id,
    payment_id: approval.paymentId,
    account_id: approval.accountId,
    status: approval.status,
    expires_at: approval.expiresAt.toISOString(),
    actor_id: approval.actorId,
    comment: approval.comment,
    row_version: approval.rowVersion,
    created_at: approval.createdAt.toISOString(),
    decided_at: approval.decidedAt?.toISOString() ?? null,
  }
}

function serializeApprovedDestination(destination: V2AdminApprovedDestinationRecord) {
  return {
    id: destination.id,
    account_id: destination.accountId,
    fingerprint: destination.fingerprint,
    rail: destination.rail,
    network: destination.network,
    asset_reference: destination.assetReference,
    destination: destination.destination,
    status: destination.status,
    actor_id: destination.actorId,
    reason: destination.reason,
    created_at: destination.createdAt.toISOString(),
    revoked_at: destination.revokedAt?.toISOString() ?? null,
  }
}

function toAuthenticatedAccount(account: V2AccountRecord): AuthenticatedAccount {
  return {
    account: {
      id: account.id,
      name: account.name,
      status: account.status,
      solanaPublicKey: account.solanaPublicKey,
    },
    credential: {
      id: 'operator',
      accountId: account.id,
      keyHash: 'operator',
      keyPrefix: 'operator',
      status: 'ACTIVE',
      scopes: [] as readonly AgentCredentialScope[],
      expiresAt: null,
      revokedAt: null,
      lastUsedAt: null,
    },
  }
}

function parseJsonObject(value: string): Readonly<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(value)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('not an object')
    }
    return parsed as Readonly<Record<string, unknown>>
  } catch {
    throw new InvalidStateError('Funding destination metadata is corrupt')
  }
}

function createId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString('hex')}`
}

function encodeCursor(occurredAt: Date, id: string): string {
  return Buffer.from(
    JSON.stringify({ occurred_at: occurredAt.toISOString(), id }),
    'utf8',
  ).toString('base64url')
}

function decodeCursor(
  value: string | undefined,
): { readonly occurredAt: Date; readonly id: string } | undefined {
  if (value === undefined) return undefined
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as {
      occurred_at?: unknown
      id?: unknown
    }
    if (typeof parsed.occurred_at !== 'string' || typeof parsed.id !== 'string') {
      throw new Error('invalid cursor')
    }
    const occurredAt = new Date(parsed.occurred_at)
    if (Number.isNaN(occurredAt.getTime())) throw new Error('invalid cursor')
    return { occurredAt, id: parsed.id }
  } catch {
    throw new ValidationError('History cursor is invalid')
  }
}
