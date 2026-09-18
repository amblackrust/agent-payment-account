import { createHash, randomBytes } from 'node:crypto'
import {
  createDenomination,
  createEconomicMapping,
  createPaymentId,
  createPaymentAttemptId,
  createSettlementAsset,
  AuthorizationError,
  DependencyUnavailableError,
  evaluateSpendPolicy,
  exactMoneyFromAtomicUnits,
  formatExactMoney,
  IdempotencyConflictError,
  InvalidStateError,
  NotFoundError,
  parseExactMoney,
  policyDecisionFingerprint,
  selectSettlementRoute,
  ValidationError,
  type AgentCredentialScope,
  type Denomination,
  type EconomicMapping,
  type ExactMoney,
  type RouteCapability,
  type SettlementAsset,
  type SettlementRoute,
  type SpendPolicy,
} from '@agent-payment/core'
import type {
  AuthenticatedAccount,
  RecipientRepository,
  V2DatabaseRepository,
  V2PaymentCreateResult,
  V2PaymentView,
  V2SpendPolicyRecord,
} from '@agent-payment/db'

const DEFAULT_APPROVAL_TTL_SECONDS = 15 * 60
const MAX_PAGE_SIZE = 100
const MAX_PAYMENT_METADATA_BYTES = 16 * 1024

export interface V2SettledBalanceProvider {
  getSettledAtomic(input: {
    readonly account: AuthenticatedAccount
    readonly denomination: Denomination
    readonly economicMapping: EconomicMapping
    readonly settlementAsset: SettlementAsset
  }): Promise<bigint>
}

export interface V2RouteCapabilityProvider {
  getCapabilities(
    routes: readonly SettlementRoute[],
  ): Promise<readonly RouteCapability[]>
}

export interface V2PaymentServiceOptions {
  readonly repository: V2DatabaseRepository
  readonly recipientRepository: Pick<RecipientRepository, 'findRecipientForOwner'>
  readonly settledBalanceProvider: V2SettledBalanceProvider
  readonly routeCapabilityProvider?: V2RouteCapabilityProvider
  readonly configuredDefaultRouteId?: string
  readonly approvalTtlSeconds?: number
  readonly maxPageSize?: number
  readonly now?: () => Date
}

export interface V2CreatePaymentInput {
  readonly kind: 'PAY' | 'SEND' | 'REFUND'
  readonly recipientId: string | null
  readonly amount: string
  readonly denominationId: string
  readonly description?: string
  readonly externalReference?: string
  readonly metadata?: Readonly<Record<string, unknown>>
  readonly routePreference?: string
  readonly originalPaymentId?: string
  readonly target?: V2PaymentTarget
}

export interface V2PaymentTarget {
  readonly recipientId: string | null
  readonly displayName: string
  readonly managedAccountId: string | null
  readonly destination: {
    readonly id: string
    readonly rail: string
    readonly type: string
    readonly walletAddress: string
  }
}

export interface V2PaymentPage {
  readonly payments: readonly V2PaymentView[]
  readonly nextCursor: string | null
}

export class V2PaymentService {
  private readonly now: () => Date
  private readonly approvalTtlSeconds: number
  private readonly maxPageSize: number

  public constructor(private readonly options: V2PaymentServiceOptions) {
    this.now = options.now ?? (() => new Date())
    this.approvalTtlSeconds = options.approvalTtlSeconds ?? DEFAULT_APPROVAL_TTL_SECONDS
    this.maxPageSize = options.maxPageSize ?? MAX_PAGE_SIZE
    if (!Number.isInteger(this.approvalTtlSeconds) || this.approvalTtlSeconds <= 0) {
      throw new InvalidStateError('Approval TTL must be a positive integer')
    }
    if (!Number.isInteger(this.maxPageSize) || this.maxPageSize < 1) {
      throw new InvalidStateError('Maximum page size must be a positive integer')
    }
  }

  public async createPayment(
    account: AuthenticatedAccount,
    input: V2CreatePaymentInput,
    idempotencyKey: string,
    requestId: string,
    correlationId?: string,
  ): Promise<{ readonly view: V2PaymentView; readonly created: boolean }> {
    const denomination = await this.loadDenomination(input.denominationId)
    const fingerprintAmount = parseAmount(
      input.amount,
      denomination.status === 'ACTIVE'
        ? denomination
        : { ...denomination, status: 'ACTIVE' },
    )
    if (fingerprintAmount.atomicUnits <= 0n) {
      throw new ValidationError('Payment amount must be positive')
    }
    const metadataJson = serializePaymentMetadata(input.metadata)
    const fingerprint = hashJson({
      kind: input.kind,
      recipient_id: input.recipientId,
      amount: fingerprintAmount.amount,
      denomination_id: denomination.id,
      description: input.description ?? null,
      external_reference: input.externalReference ?? null,
      metadata_json: metadataJson ?? null,
      route_preference: input.routePreference ?? null,
      original_payment_id: input.originalPaymentId ?? null,
    })
    const existingIdempotency = await this.options.repository.findV2Idempotency(
      account.account.id,
      idempotencyKey,
    )
    if (existingIdempotency !== null) {
      if (
        existingIdempotency.requestHash !== fingerprint ||
        existingIdempotency.fingerprint !== fingerprint
      ) {
        throw new IdempotencyConflictError()
      }
      const existingView = await this.options.repository.findPaymentView(
        account.account.id,
        existingIdempotency.resourceId,
      )
      if (existingView === null) {
        throw new InvalidStateError(
          'Idempotency record points to an unreadable payment projection',
        )
      }
      return { view: existingView, created: false }
    }
    const amount = parseAmount(input.amount, denomination)
    const routes = await this.options.repository.listActiveSettlementRoutes()
    const capabilities =
      this.options.routeCapabilityProvider === undefined
        ? []
        : await this.options.routeCapabilityProvider.getCapabilities(routes)
    if (
      this.options.routeCapabilityProvider !== undefined &&
      routes.some(
        (route) => !capabilities.some((capability) => capability.routeId === route.id),
      )
    ) {
      throw new DependencyUnavailableError(
        'Settlement route capabilities are unavailable',
      )
    }
    const routeSelection = selectSettlementRoute(
      {
        ...(input.routePreference === undefined
          ? {}
          : { explicitRouteId: input.routePreference }),
        ...(this.options.configuredDefaultRouteId === undefined
          ? {}
          : { configuredDefaultRouteId: this.options.configuredDefaultRouteId }),
      },
      routes,
      capabilities,
    )
    const route = routeSelection.route
    const routeCapabilitySnapshotJson = serializeRouteCapabilitySnapshot(
      routeSelection,
      capabilities,
    )
    const target =
      input.target ??
      (input.recipientId === null
        ? (() => {
            throw new ValidationError('Recipient is required for a payment')
          })()
        : await this.loadPaymentTarget(account.account.id, input.recipientId, route))
    const destination = target.destination
    if (destination.rail !== route.rail) {
      throw new ValidationError(
        'Recipient destination is incompatible with the settlement route',
      )
    }
    const settlementAsset = await this.options.repository.findSettlementAsset(
      route.settlementAssetId,
    )
    if (settlementAsset === null) {
      throw new DependencyUnavailableError(
        'Settlement asset configuration is unavailable',
      )
    }
    const mappingRecord = await this.options.repository.findEconomicMapping(
      route.economicMappingId,
    )
    if (mappingRecord === null) {
      throw new DependencyUnavailableError(
        'Economic mapping configuration is unavailable',
      )
    }
    const settlementAssetModel = createSettlementAsset({
      id: settlementAsset.id,
      rail: settlementAsset.rail,
      network: settlementAsset.network,
      assetReference: settlementAsset.assetReference,
      decimals: settlementAsset.decimals,
      status: asLifecycleStatus(settlementAsset.status),
      version: settlementAsset.version,
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
      economicMapping.settlementAssetId !== settlementAssetModel.id
    ) {
      throw new InvalidStateError(
        'Settlement route mapping does not match the selected denomination and asset',
      )
    }
    const destinationFingerprint = fingerprintDestination({
      rail: route.rail,
      network: route.network,
      assetReference: settlementAsset.assetReference,
      destination: destination.walletAddress,
    })
    const approvedDestination = await this.options.repository.findApprovedDestination(
      account.account.id,
      destinationFingerprint,
    )
    const policyRecord = await this.options.repository.findActiveSpendPolicy(
      account.account.id,
      denomination.id,
    )
    if (policyRecord === null) {
      throw new DependencyUnavailableError('No active spend policy is configured')
    }
    const context = await this.options.repository.getSpendContext(
      account.account.id,
      denomination.id,
      this.now(),
      policyRecord.rollingWindowSeconds,
    )
    const policy = toSpendPolicy(policyRecord, denomination)
    const policyDecision = evaluateSpendPolicy({
      policy,
      amount,
      destinationApproved: approvedDestination !== null,
      confirmedSpend: exactMoneyFromAtomicUnits(
        context.confirmedSpendAtomic,
        denomination,
      ),
      heldReservations: exactMoneyFromAtomicUnits(
        context.heldReservationAtomic,
        denomination,
      ),
      unresolvedSpend: exactMoneyFromAtomicUnits(
        context.unresolvedSpendAtomic,
        denomination,
      ),
      transactionCount: context.transactionCount,
    })
    const settledAtomic =
      policyDecision.decision === 'ALLOW'
        ? await this.options.settledBalanceProvider.getSettledAtomic({
            account,
            denomination,
            economicMapping,
            settlementAsset: settlementAssetModel,
          })
        : 0n
    if (settledAtomic < 0n) {
      throw new InvalidStateError('Settlement balance cannot be negative')
    }
    const intentFingerprint = hashJson({
      request_fingerprint: fingerprint,
      amount_atomic: amount.atomicUnits.toString(),
      amount_scale: amount.scale,
      denomination_id: denomination.id,
      destination: {
        id: destination.id,
        rail: destination.rail,
        type: destination.type,
        wallet_address: destination.walletAddress,
        recipient_id: target.recipientId,
        managed_account_id: target.managedAccountId,
      },
      route:
        policyDecision.decision === 'DENY'
          ? null
          : {
              id: route.id,
              rail: route.rail,
              rail_version: route.railVersion,
              network: route.network,
              settlement_asset_id: route.settlementAssetId,
              economic_mapping_id: route.economicMappingId,
              priority: route.priority,
              config_version: route.configVersion,
            },
      settlement_asset:
        policyDecision.decision === 'DENY'
          ? null
          : {
              id: settlementAsset.id,
              rail: settlementAsset.rail,
              network: settlementAsset.network,
              asset_reference: settlementAsset.assetReference,
              decimals: settlementAsset.decimals,
              version: settlementAsset.version,
            },
      economic_mapping:
        policyDecision.decision === 'DENY'
          ? null
          : {
              id: mappingRecord.id,
              denomination_id: mappingRecord.denominationId,
              settlement_asset_id: mappingRecord.settlementAssetId,
              numerator: mappingRecord.numerator.toString(),
              denominator: mappingRecord.denominator.toString(),
              version: mappingRecord.version,
            },
    })

    const paymentId = createPaymentId()
    const decisionInput = {
      id: createId('pdec'),
      paymentId,
      accountId: account.account.id,
      policyId: policy.id,
      policyVersion: policy.version,
      decision: policyDecision.decision,
      reasonCodes: policyDecision.reasonCodes,
      contextJson: JSON.stringify({
        confirmed_spend_atomic: context.confirmedSpendAtomic.toString(),
        held_reservation_atomic: context.heldReservationAtomic.toString(),
        unresolved_spend_atomic: context.unresolvedSpendAtomic.toString(),
        transaction_count: context.transactionCount,
      }),
      fingerprint: hashJson(policyDecisionFingerprint(policyDecision)),
    } satisfies Parameters<V2DatabaseRepository['createV2Payment']>[0]['policyDecision']
    const createResult: V2PaymentCreateResult =
      await this.options.repository.createV2Payment({
        paymentId,
        reservationId: createId('resv'),
        attemptId: createPaymentAttemptId(),
        workItemId: createId('work'),
        idempotencyId: createId('idem'),
        timelineEventId: createId('timeline'),
        accountId: account.account.id,
        operation: input.kind,
        idempotencyKey,
        requestHash: fingerprint,
        fingerprint,
        requestId,
        ...(correlationId === undefined ? {} : { correlationId }),
        payerPublicKey: account.account.solanaPublicKey,
        recipientId: target.recipientId,
        recipientManagedAccountId: target.managedAccountId,
        amountAtomic: amount.atomicUnits,
        amountScale: amount.scale,
        denominationId: denomination.id,
        currency: denomination.symbol,
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.externalReference === undefined
          ? {}
          : { externalReference: input.externalReference }),
        ...(metadataJson === undefined ? {} : { metadataJson }),
        route: policyDecision.decision === 'DENY' ? null : route,
        routeSelectionReason:
          policyDecision.decision === 'DENY' ? null : routeSelection.reason,
        ...(policyDecision.decision === 'DENY' ||
        routeCapabilitySnapshotJson === undefined
          ? {}
          : { routeCapabilitySnapshotJson }),
        destinationSnapshotJson: JSON.stringify({
          recipient_id: target.recipientId,
          display_name: target.displayName,
          destination_id: destination.id,
          rail: destination.rail,
          destination_type: destination.type,
          wallet_address: destination.walletAddress,
          managed_account_id: target.managedAccountId,
          network: policyDecision.decision === 'DENY' ? null : route.network,
          asset_reference:
            policyDecision.decision === 'DENY' ? null : settlementAsset.assetReference,
        }),
        settlementAssetId:
          policyDecision.decision === 'DENY' ? null : settlementAsset.id,
        economicMappingId: policyDecision.decision === 'DENY' ? null : mappingRecord.id,
        destinationFingerprint,
        intentFingerprint,
        policyDecision: decisionInput,
        ...(policyDecision.decision === 'REQUIRE_APPROVAL'
          ? {
              approval: {
                id: createId('appr'),
                expiresAt: new Date(
                  this.now().getTime() + this.approvalTtlSeconds * 1000,
                ),
              },
            }
          : {}),
        settledAtomic,
      })
    const view =
      (await this.options.repository.findPaymentView(
        account.account.id,
        createResult.payment.id,
      )) ??
      (await this.options.repository.findPaymentView(account.account.id, paymentId))
    if (view === null) {
      throw new InvalidStateError('Payment was committed without a readable projection')
    }
    return { view, created: createResult.created }
  }

  public async getPayment(
    accountId: string,
    paymentId: string,
  ): Promise<V2PaymentView> {
    const view = await this.options.repository.findPaymentView(accountId, paymentId)
    if (view === null) throw new NotFoundError('Payment was not found')
    return view
  }

  public async serialize(view: V2PaymentView): Promise<Record<string, unknown>> {
    if (view.payment.denominationId === null) {
      throw new InvalidStateError('Payment is missing its denomination')
    }
    return serializeV2PaymentView(
      view,
      await this.loadDenomination(view.payment.denominationId),
    )
  }

  public async listPayments(
    accountId: string,
    input: {
      readonly limit?: number
      readonly cursor?: string
      readonly status?: string
      readonly outcomeState?: string
      readonly recipientId?: string
      readonly denominationId?: string
    } = {},
  ): Promise<V2PaymentPage> {
    const limit = input.limit ?? 50
    if (!Number.isInteger(limit) || limit < 1 || limit > this.maxPageSize) {
      throw new InvalidStateError(
        `Payment limit must be an integer from 1 to ${this.maxPageSize}`,
      )
    }
    const cursor = decodeCursor(input.cursor)
    const payments = await this.options.repository.listPaymentViews({
      accountId,
      limit: limit + 1,
      ...(cursor === undefined ? {} : { cursor }),
      ...(input.status === undefined ? {} : { status: input.status }),
      ...(input.outcomeState === undefined ? {} : { outcomeState: input.outcomeState }),
      ...(input.recipientId === undefined ? {} : { recipientId: input.recipientId }),
      ...(input.denominationId === undefined
        ? {}
        : { denominationId: input.denominationId }),
    })
    const visible = payments.slice(0, limit)
    const last = visible.at(-1)?.payment
    return {
      payments: visible,
      nextCursor:
        payments.length > limit && last !== undefined
          ? encodeCursor(last.createdAt, last.id)
          : null,
    }
  }

  public async createRefund(
    account: AuthenticatedAccount,
    originalPaymentId: string,
    input: Omit<V2CreatePaymentInput, 'kind' | 'recipientId'>,
    idempotencyKey: string,
    requestId: string,
    correlationId?: string,
  ): Promise<{ readonly view: V2PaymentView; readonly created: boolean }> {
    const original = await this.getPayment(account.account.id, originalPaymentId)
    if (original.payment.status !== 'CONFIRMED') {
      throw new InvalidStateError('Only confirmed payments can be refunded')
    }
    if (original.payment.recipientManagedAccountId !== account.account.id) {
      throw new AuthorizationError(
        'The authenticated account is not the refund authority',
      )
    }
    if (original.payment.denominationId !== input.denominationId) {
      throw new ValidationError('Refund denomination must match the original payment')
    }
    const denomination = await this.loadDenomination(input.denominationId)
    const amount = parseAmount(input.amount, denomination)
    if (
      input.routePreference !== undefined &&
      input.routePreference !== original.payment.routeId
    ) {
      throw new ValidationError('Refund route must match the original payment')
    }
    const refundedAtomic =
      await this.options.repository.getRefundedAtomic(originalPaymentId)
    if (amount.atomicUnits + refundedAtomic > original.payment.amountAtomic) {
      throw new ValidationError('Refund amount exceeds the original payment amount')
    }
    const payerPublicKey = await this.options.repository.findAccountPublicKey(
      original.payment.payerAccountId,
    )
    if (payerPublicKey === null) {
      throw new DependencyUnavailableError('Original payer account is unavailable')
    }
    return this.createPayment(
      account,
      {
        ...input,
        kind: 'REFUND',
        recipientId: null,
        originalPaymentId,
        target: {
          recipientId: null,
          displayName: 'Original payer',
          managedAccountId: original.payment.payerAccountId,
          destination: {
            id: `payer_${original.payment.payerAccountId}`,
            rail: 'SOLANA_SPL',
            type: 'SOLANA_SPL',
            walletAddress: payerPublicKey,
          },
        },
        ...(original.payment.routeId === null
          ? {}
          : { routePreference: original.payment.routeId }),
      },
      idempotencyKey,
      requestId,
      correlationId,
    )
  }

  private async loadDenomination(id: string): Promise<Denomination> {
    const record = await this.options.repository.findDenomination(id)
    if (record === null) throw new NotFoundError('Denomination was not found')
    return createDenomination({
      id: record.id,
      symbol: record.symbol,
      maxScale: record.maxScale,
      status: record.status as Denomination['status'],
      version: record.version,
    })
  }

  private async loadPaymentTarget(
    accountId: string,
    recipientId: string,
    route: SettlementRoute,
  ): Promise<V2PaymentTarget> {
    const recipient = await this.options.recipientRepository.findRecipientForOwner(
      accountId,
      recipientId,
    )
    if (recipient === null) throw new NotFoundError('Recipient was not found')
    if (recipient.archivedAt !== undefined && recipient.archivedAt !== null) {
      throw new InvalidStateError('Recipient is archived')
    }
    const destination = recipient.destinations.find(
      (candidate) =>
        candidate.status !== 'REVOKED' &&
        candidate.status !== 'DISABLED' &&
        candidate.rail === route.rail &&
        (candidate.network === undefined ||
          candidate.network === null ||
          candidate.network === route.network),
    )
    if (destination === undefined) {
      throw new InvalidStateError('Recipient has no active destination')
    }
    return {
      recipientId: recipient.id,
      displayName: recipient.displayName,
      managedAccountId: recipient.managedAccountId,
      destination,
    }
  }
}

function serializeRouteCapabilitySnapshot(
  routeSelection: ReturnType<typeof selectSettlementRoute>,
  capabilities: readonly RouteCapability[],
): string | undefined {
  const capability = capabilities.find(
    (candidate) => candidate.routeId === routeSelection.route.id,
  )
  if (capability === undefined) return undefined
  return JSON.stringify({
    route_id: capability.routeId,
    eligible: capability.eligible,
    reason: capability.reason ?? null,
    observed_at: capability.observedAt.toISOString(),
    identity_version: capability.identityVersion,
  })
}

function parseAmount(value: string, denomination: Denomination): ExactMoney {
  return parseExactMoney(value, denomination)
}

function toSpendPolicy(
  record: V2SpendPolicyRecord,
  denomination: Denomination,
): SpendPolicy {
  return {
    id: record.id,
    accountId: record.accountId,
    version: record.version,
    status: record.status as SpendPolicy['status'],
    maxPerPayment:
      record.maxPerPaymentAtomic === null
        ? null
        : exactMoneyFromAtomicUnits(record.maxPerPaymentAtomic, denomination),
    rollingBudget:
      record.rollingBudgetAtomic === null
        ? null
        : exactMoneyFromAtomicUnits(record.rollingBudgetAtomic, denomination),
    rollingWindowSeconds: record.rollingWindowSeconds,
    transactionCountCap: record.transactionCountCap,
    approvalThreshold:
      record.approvalThresholdAtomic === null
        ? null
        : exactMoneyFromAtomicUnits(record.approvalThresholdAtomic, denomination),
    rollingBudgetEscalatable: record.rollingBudgetEscalatable,
    transactionCountEscalatable: record.transactionCountEscalatable,
  }
}

function fingerprintDestination(input: {
  readonly rail: string
  readonly network: string
  readonly assetReference: string
  readonly destination: string
}): string {
  return hashJson(input)
}

function serializePaymentMetadata(
  metadata: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  if (metadata === undefined) return undefined
  let normalized: unknown
  try {
    normalized = normalizeJsonValue(metadata, new WeakSet<object>())
  } catch (error: unknown) {
    if (error instanceof ValidationError) throw error
    throw new ValidationError('Payment metadata must be valid JSON')
  }
  const serialized = JSON.stringify(normalized)
  if (serialized === undefined) {
    throw new ValidationError('Payment metadata must be a JSON object')
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_PAYMENT_METADATA_BYTES) {
    throw new ValidationError(
      `Payment metadata must not exceed ${MAX_PAYMENT_METADATA_BYTES} bytes`,
    )
  }
  return serialized
}

function normalizeJsonValue(value: unknown, ancestors: WeakSet<object>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new ValidationError('Payment metadata has an invalid number')
    return value
  }
  if (typeof value !== 'object') {
    throw new ValidationError('Payment metadata must contain only JSON values')
  }
  if (ancestors.has(value)) {
    throw new ValidationError('Payment metadata must not contain circular references')
  }
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      return value.map((item) => normalizeJsonValue(item, ancestors))
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new ValidationError('Payment metadata must contain only JSON values')
    }
    const normalized: Record<string, unknown> = {}
    for (const key of Object.keys(value)) {
      normalized[key] = normalizeJsonValue(
        (value as Record<string, unknown>)[key],
        ancestors,
      )
    }
    return Object.fromEntries(
      Object.entries(normalized).sort(([left], [right]) => left.localeCompare(right)),
    )
  } finally {
    ancestors.delete(value)
  }
}

function parsePaymentMetadata(serialized: string | undefined): Record<string, unknown> {
  if (serialized === undefined) return {}
  try {
    const parsed: unknown = JSON.parse(serialized)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('metadata is not an object')
    }
    return parsed as Record<string, unknown>
  } catch {
    throw new InvalidStateError('Payment metadata is corrupt')
  }
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')
}

function createId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString('hex')}`
}

function asLifecycleStatus(status: string): 'ACTIVE' | 'RETIRED' {
  if (status === 'ACTIVE' || status === 'RETIRED') return status
  throw new InvalidStateError('Financial configuration has an invalid lifecycle status')
}

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(
    JSON.stringify({ created_at: createdAt.toISOString(), id }),
    'utf8',
  ).toString('base64url')
}

function decodeCursor(
  value: string | undefined,
): { readonly createdAt: Date; readonly id: string } | undefined {
  if (value === undefined) return undefined
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as {
      created_at?: unknown
      id?: unknown
    }
    if (typeof decoded.created_at !== 'string' || typeof decoded.id !== 'string') {
      throw new Error('invalid cursor')
    }
    const createdAt = new Date(decoded.created_at)
    if (Number.isNaN(createdAt.getTime()) || decoded.id.length === 0) {
      throw new Error('invalid cursor')
    }
    return { createdAt, id: decoded.id }
  } catch {
    throw new InvalidStateError('Payment cursor is invalid')
  }
}

export function serializeV2PaymentView(
  view: V2PaymentView,
  denomination: Denomination,
): Record<string, unknown> {
  return {
    id: view.payment.id,
    kind: view.payment.kind,
    recipient_id: view.payment.recipientId,
    description: view.payment.description,
    external_reference: view.payment.externalReference,
    metadata: parsePaymentMetadata(view.payment.metadataJson),
    amount: formatExactMoney(
      exactMoneyFromAtomicUnits(view.payment.amountAtomic, denomination),
    ),
    denomination_id: view.payment.denominationId,
    denomination_symbol: denomination.symbol,
    status: view.payment.status,
    policy_decision: view.policyDecision,
    policy_reason_codes: [...view.reasonCodes],
    approval_state: view.approvalState,
    attempt_count: view.attempts.length,
    reservation_status: view.reservationStatus,
    route_id: view.payment.routeId,
    route_selection_reason: view.payment.routeSelectionReason,
    settlement_asset_id: view.payment.settlementAssetId,
    execution_state: view.payment.executionState,
    settlement_state: view.payment.settlementState,
    outcome_state: view.payment.outcomeState,
    created_at: view.payment.createdAt.toISOString(),
    updated_at: view.payment.updatedAt.toISOString(),
    confirmed_at: view.payment.confirmedAt?.toISOString() ?? null,
    failure_code: view.payment.failureCode,
    failure_message: view.payment.failureMessageSafe,
    original_payment_id: view.payment.originalPaymentId,
  }
}

export function getV2RequiredScopes(): readonly AgentCredentialScope[] {
  return ['payments:create', 'payments:read']
}
