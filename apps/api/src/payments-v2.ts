import { createHash, randomBytes } from 'node:crypto'
import {
  createDenomination,
  createPaymentId,
  createPaymentAttemptId,
  AuthorizationError,
  DependencyUnavailableError,
  evaluateSpendPolicy,
  exactMoneyFromAtomicUnits,
  formatExactMoney,
  InvalidStateError,
  NotFoundError,
  parseExactMoney,
  policyDecisionFingerprint,
  selectSettlementRoute,
  ValidationError,
  type AgentCredentialScope,
  type Denomination,
  type ExactMoney,
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

export interface V2SettledBalanceProvider {
  getSettledAtomic(input: {
    readonly account: AuthenticatedAccount
    readonly denomination: Denomination
  }): Promise<bigint>
}

export interface V2PaymentServiceOptions {
  readonly repository: V2DatabaseRepository
  readonly recipientRepository: Pick<RecipientRepository, 'findRecipientForOwner'>
  readonly settledBalanceProvider: V2SettledBalanceProvider
  readonly configuredDefaultRouteId?: string
  readonly approvalTtlSeconds?: number
  readonly now?: () => Date
}

export interface V2CreatePaymentInput {
  readonly kind: 'PAY' | 'SEND' | 'REFUND'
  readonly recipientId: string | null
  readonly amount: string
  readonly denominationId: string
  readonly description?: string
  readonly externalReference?: string
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

  public constructor(private readonly options: V2PaymentServiceOptions) {
    this.now = options.now ?? (() => new Date())
    this.approvalTtlSeconds = options.approvalTtlSeconds ?? DEFAULT_APPROVAL_TTL_SECONDS
    if (!Number.isInteger(this.approvalTtlSeconds) || this.approvalTtlSeconds <= 0) {
      throw new InvalidStateError('Approval TTL must be a positive integer')
    }
  }

  public async createPayment(
    account: AuthenticatedAccount,
    input: V2CreatePaymentInput,
    idempotencyKey: string,
    requestId: string,
  ): Promise<{ readonly view: V2PaymentView; readonly created: boolean }> {
    const denomination = await this.loadDenomination(input.denominationId)
    const amount = parseAmount(input.amount, denomination)
    if (amount.atomicUnits <= 0n) {
      throw new ValidationError('Payment amount must be positive')
    }
    const target =
      input.target ??
      (input.recipientId === null
        ? (() => {
            throw new ValidationError('Recipient is required for a payment')
          })()
        : await this.loadPaymentTarget(account.account.id, input.recipientId))
    const destination = target.destination

    const routes = await this.options.repository.listActiveSettlementRoutes()
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
    )
    const route = routeSelection.route
    const settlementAsset = await this.options.repository.findSettlementAsset(
      route.settlementAssetId,
    )
    if (settlementAsset === null) {
      throw new DependencyUnavailableError(
        'Settlement asset configuration is unavailable',
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
          })
        : 0n
    if (settledAtomic < 0n) {
      throw new InvalidStateError('Settlement balance cannot be negative')
    }

    const fingerprint = hashJson({
      kind: input.kind,
      recipient_id: target.recipientId,
      amount: amount.amount,
      denomination_id: denomination.id,
      description: input.description ?? null,
      external_reference: input.externalReference ?? null,
      route_preference: input.routePreference ?? null,
      original_payment_id: input.originalPaymentId ?? null,
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
        route: policyDecision.decision === 'DENY' ? null : route,
        routeSelectionReason:
          policyDecision.decision === 'DENY' ? null : routeSelection.reason,
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
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
      throw new InvalidStateError(
        `Payment limit must be an integer from 1 to ${MAX_PAGE_SIZE}`,
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
  ): Promise<V2PaymentTarget> {
    const recipient = await this.options.recipientRepository.findRecipientForOwner(
      accountId,
      recipientId,
    )
    if (recipient === null) throw new NotFoundError('Recipient was not found')
    if (recipient.archivedAt !== undefined && recipient.archivedAt !== null) {
      throw new InvalidStateError('Recipient is archived')
    }
    const destination = recipient.destinations[0]
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

function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')
}

function createId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString('hex')}`
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
