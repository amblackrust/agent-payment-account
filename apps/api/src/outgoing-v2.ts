import { createHash, randomUUID } from 'node:crypto'
import {
  classifyWorkFailure,
  computeRetryAt,
  CustodyUnavailableError,
  ExternalRailError,
  InvalidStateError,
  type AgentAccountLifecycleStatus,
} from '@agent-payment/core'
import type {
  V2DatabaseRepository,
  V2PaymentAttemptSnapshot,
  V2PaymentView,
  V2WorkItemClaim,
} from '@agent-payment/db'
import type { V2AdminRepository, V2OperationsRepository } from '@agent-payment/db'
import type {
  ConstrainedEffectSigningRequest,
  ConstrainedSignedEffect,
  WalletSecretCipher,
} from './custody.js'
import type { CapacityDependency, CapacityResult } from './capacity.js'
import { retryAtAfter } from './capacity.js'
import type { MetricsRegistry } from './observability.js'

const DEFAULT_LEASE_SECONDS = 30
const DEFAULT_BATCH_SIZE = 10

export interface V2PlatformCostObservation {
  readonly assetId: string
  readonly amountAtomic: bigint
}

export interface V2PreparedEffect extends ConstrainedEffectSigningRequest {
  readonly paymentId: string
  readonly attemptId: string
  readonly routeId: string
  readonly payloadHash: string
  readonly preparedPayload: string
  readonly platformCostEstimate?: V2PlatformCostObservation
  readonly validityExpiresAt?: Date
  readonly validitySlot?: bigint
}

export interface V2OutgoingExecutor {
  prepare(input: {
    readonly view: V2PaymentView
    readonly attempt: V2PaymentAttemptSnapshot
  }): Promise<V2PreparedEffect>
  sign(input: ConstrainedEffectSigningRequest): Promise<ConstrainedSignedEffect>
  submit(input: {
    readonly prepared: V2PreparedEffect
    readonly signed: ConstrainedSignedEffect
  }): Promise<{
    readonly status: 'SUBMITTED' | 'CONFIRMED' | 'FAILED' | 'UNKNOWN'
    readonly externalId?: string
    readonly failureCode?: string
    readonly failureMessageSafe?: string
    readonly platformCostActual?: V2PlatformCostObservation
    readonly evidenceMetadataJson?: string
  }>
  reconcile?(input: {
    readonly view: V2PaymentView
    readonly attempt: V2PaymentAttemptSnapshot
    readonly signedPayload?: Uint8Array
  }): Promise<{
    readonly status: 'CONFIRMED' | 'PROVED_NO_EFFECT' | 'UNKNOWN'
    readonly externalId?: string
    readonly platformCostActual?: V2PlatformCostObservation
    readonly evidenceMetadataJson?: string
  }>
}

export interface V2OutgoingWorkerOptions {
  readonly repository: V2DatabaseRepository
  readonly accountStatusProvider: {
    getStatus(accountId: string): Promise<AgentAccountLifecycleStatus>
  }
  readonly executor: V2OutgoingExecutor
  readonly custody?: Pick<
    V2AdminRepository,
    | 'findActiveCustodyKeyVersion'
    | 'findSigningRequest'
    | 'createSigningRequest'
    | 'completeSigningRequest'
  >
  readonly platformCosts?: Pick<
    V2OperationsRepository,
    'createPlatformCostEstimate' | 'reconcilePlatformCost'
  >
  readonly signedPayloadCipher?: WalletSecretCipher
  readonly serviceIdentity?: string
  readonly capacity?: {
    acquire(dependency: CapacityDependency, now?: Date): Promise<CapacityResult>
  }
  readonly mode?: 'outgoing' | 'reconcile'
  readonly owner: string
  readonly leaseSeconds?: number
  readonly batchSize?: number
  readonly now?: () => Date
  readonly logger?: V2OutgoingLogger
  readonly metrics?: MetricsRegistry
}

export interface V2OutgoingLogger {
  info(data: Readonly<Record<string, unknown>>, message: string): void
  error?(data: Readonly<Record<string, unknown>>, message: string): void
}

export class V2OutgoingWorker {
  private stopped = false
  private currentRun: Promise<void> | undefined
  private readonly now: () => Date
  private logger: V2OutgoingLogger | undefined

  public constructor(private readonly options: V2OutgoingWorkerOptions) {
    this.now = options.now ?? (() => new Date())
    this.logger = options.logger
  }

  public setLogger(logger: V2OutgoingLogger): void {
    this.logger = logger
  }

  public runOnce(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    if (this.currentRun !== undefined) return this.currentRun
    const run = this.processBatch()
    let tracked: Promise<void>
    tracked = run.finally(() => {
      if (this.currentRun === tracked) this.currentRun = undefined
    })
    this.currentRun = tracked
    return tracked
  }

  public stop(): void {
    this.stopped = true
  }

  public async drain(): Promise<void> {
    await this.currentRun
  }

  private async processBatch(): Promise<void> {
    const batchSize = this.options.batchSize ?? DEFAULT_BATCH_SIZE
    const kinds =
      this.options.mode === 'reconcile'
        ? (['RECONCILE_PAYMENT_ATTEMPT'] as const)
        : ([
            'OUTGOING_PAYMENT_ATTEMPT',
            'OUTGOING_PAYMENT',
            'RECONCILE_PAYMENT_ATTEMPT',
          ] as const)
    for (let index = 0; index < batchSize; index += 1) {
      if (!(await this.acquireBatchCapacity())) break
      let claim: V2WorkItemClaim | null = null
      for (const kind of kinds) {
        claim = await this.options.repository.claimWorkItem({
          kind,
          owner: this.options.owner,
          leaseSeconds: this.options.leaseSeconds ?? DEFAULT_LEASE_SECONDS,
          now: this.now(),
        })
        if (claim !== null) break
      }
      if (claim === null) break
      await this.processClaim(claim)
    }
  }

  private async acquireBatchCapacity(): Promise<boolean> {
    if (this.options.capacity === undefined) return true
    const result = await this.options.capacity.acquire('database', this.now())
    return result.allowed
  }

  private async processClaim(claim: V2WorkItemClaim): Promise<void> {
    const heartbeat = this.startLeaseHeartbeat(claim)
    try {
      await this.processClaimWithLease(claim)
    } finally {
      heartbeat.stop()
    }
  }

  private async processClaimWithLease(claim: V2WorkItemClaim): Promise<void> {
    try {
      if (claim.accountId === undefined) {
        throw new InvalidStateError('Outgoing work item has no owning account')
      }
      const paymentId = paymentIdFromClaim(claim)
      const view = await this.options.repository.findPaymentView(
        claim.accountId,
        paymentId,
      )
      if (view === null) {
        await this.options.repository.completeWorkItem(claim.id, this.options.owner)
        return
      }
      this.options.metrics?.incrementCounter('mux_worker_claims_total', {
        operation: claim.kind,
      })
      this.logger?.info(
        {
          worker: this.options.owner,
          workItemId: claim.id,
          resourceType: claim.resourceType,
          resourceId: claim.resourceId,
          paymentId,
          ...(view.payment.correlationId === undefined ||
          view.payment.correlationId === null
            ? {}
            : { correlationId: view.payment.correlationId }),
          state: view.payment.status,
        },
        'Outgoing work item claimed',
      )
      const attempt = view.attempts.at(-1)
      if (
        claim.resourceType === 'PAYMENT_ATTEMPT' &&
        (attempt === undefined || attempt.id !== claim.resourceId)
      ) {
        await this.options.repository.completeWorkItem(claim.id, this.options.owner)
        return
      }
      if (attempt === undefined) {
        if (this.options.mode === 'reconcile') {
          await this.requeueForOutgoing(claim)
          return
        }
        await this.options.repository.completeWorkItem(claim.id, this.options.owner)
        return
      }
      if (attempt.outcome === 'SUBMITTED' || attempt.outcome === 'UNKNOWN') {
        await this.processReconciliation(claim, view, attempt)
        return
      }
      if (this.options.mode === 'reconcile') {
        await this.requeueForOutgoing(claim)
        return
      }
      if (
        view.payment.status === 'PROVED_NO_EFFECT' ||
        view.payment.status === 'CONFIRMED'
      ) {
        await this.options.repository.completeWorkItem(claim.id, this.options.owner)
        return
      }
      if (!(await this.ensureActiveBeforeEffect(claim, view, attempt))) return
      if (
        this.options.custody === undefined ||
        this.options.signedPayloadCipher === undefined
      ) {
        throw new CustodyUnavailableError(
          'Outgoing worker requires durable custody and signed-payload encryption',
        )
      }
      const restoredPrepared = restorePreparedEffect(attempt)
      if (!(await this.acquireCapacity(claim, 'rail'))) return
      const prepared =
        restoredPrepared ?? (await this.options.executor.prepare({ view, attempt }))
      if (
        attempt.preparedEffectHash !== null &&
        attempt.preparedEffectHash !== prepared.effectHash
      ) {
        throw new InvalidStateError('Prepared effect changed after durable persistence')
      }
      const preparedAttempt =
        restoredPrepared === undefined
          ? await this.options.repository.updateAttemptOutcome({
              attemptId: attempt.id,
              currentOutcome: attempt.outcome,
              nextOutcome: attempt.outcome,
              currentRowVersion: attempt.rowVersion,
              status: 'PREPARED',
              preparedEffectHash: prepared.effectHash,
              preparedEffectJson: serializePreparedEffect(prepared),
              ...(prepared.validityExpiresAt === undefined
                ? {}
                : { validityExpiresAt: prepared.validityExpiresAt }),
              ...(prepared.validitySlot === undefined
                ? {}
                : { validitySlot: prepared.validitySlot }),
            })
          : attempt
      await this.persistPlatformCostEstimate(prepared)
      const activeKey = await this.options.custody.findActiveCustodyKeyVersion(
        prepared.accountId,
      )
      if (activeKey === null || activeKey.keyVersion !== prepared.keyVersion) {
        throw new CustodyUnavailableError('Active custody key version is unavailable')
      }
      const existingSigningRequest = await this.options.custody.findSigningRequest(
        prepared.attemptId,
      )
      const signingRequest =
        existingSigningRequest ??
        (await this.options.custody.createSigningRequest({
          id: `signing_${prepared.attemptId}`,
          paymentId: prepared.paymentId,
          attemptId: prepared.attemptId,
          effectHash: prepared.effectHash,
          routeId: prepared.routeId,
          network: prepared.network,
          assetReference: prepared.assetReference,
          destination: prepared.destination,
          amountAtomic: prepared.amountAtomic,
          feePayerIdentity: prepared.feePayerIdentity,
          keyVersion: prepared.keyVersion,
          serviceIdentity: this.options.serviceIdentity ?? this.options.owner,
        }))
      if (
        signingRequest.effectHash !== prepared.effectHash ||
        (signingRequest.status !== 'PENDING' && signingRequest.status !== 'SIGNED')
      ) {
        throw new CustodyUnavailableError(
          'Signing request is not usable for this effect',
        )
      }
      let signed: ConstrainedSignedEffect
      const signedPayloadIsDurable =
        preparedAttempt.signedPayloadEncrypted !== undefined &&
        preparedAttempt.signedPayloadEncrypted !== null
      if (signedPayloadIsDurable) {
        signed = restoreSignedEffect(
          this.options.signedPayloadCipher,
          preparedAttempt.signedPayloadEncrypted,
          prepared,
          preparedAttempt.expectedExternalId,
          preparedAttempt.signedPayloadHash,
        )
      } else {
        try {
          if (!(await this.ensureActiveBeforeEffect(claim, view, attempt))) return
          if (!(await this.ensurePreparedAttemptIsCurrent(claim, prepared))) return
          if (!(await this.acquireCapacity(claim, 'custody'))) return
          signed = await this.options.executor.sign(prepared)
        } catch (error) {
          if (signingRequest.status === 'PENDING') {
            await this.options.custody.completeSigningRequest(
              signingRequest.id,
              prepared.effectHash,
              'REJECTED',
            )
          }
          throw error
        }
      }
      try {
        if (!signedPayloadIsDurable) {
          await this.options.repository.updateAttemptOutcome({
            attemptId: attempt.id,
            currentOutcome: attempt.outcome,
            nextOutcome: attempt.outcome,
            currentRowVersion: preparedAttempt.rowVersion,
            status: 'EXECUTING',
            signedPayloadHash: hashBytes(signed.signedPayload),
            expectedExternalId: signed.externalId,
            signedPayloadEncrypted: serializeEncryptedPayload(
              this.options.signedPayloadCipher.encrypt(signed.signedPayload),
            ),
          })
        }
        if (signingRequest.status === 'PENDING') {
          await this.options.custody.completeSigningRequest(
            signingRequest.id,
            prepared.effectHash,
            'SIGNED',
          )
        }
        const currentView = await this.options.repository.findPaymentView(
          claim.accountId,
          paymentId,
        )
        if (currentView === null) {
          await this.options.repository.failWorkItem({
            id: claim.id,
            owner: this.options.owner,
            errorCode: 'PAYMENT_NOT_FOUND_AFTER_SIGNING',
            errorSafe: 'Payment disappeared after signing',
          })
          return
        }
        const currentAttempt = currentView.attempts.at(-1)
        if (currentAttempt === undefined) {
          await this.options.repository.failWorkItem({
            id: claim.id,
            owner: this.options.owner,
            errorCode: 'PAYMENT_ATTEMPT_NOT_FOUND_AFTER_SIGNING',
            errorSafe: 'Payment attempt disappeared after signing',
          })
          return
        }
        if (
          currentAttempt.id !== prepared.attemptId ||
          currentAttempt.preparedEffectHash !== prepared.effectHash
        ) {
          await this.options.repository.completeWorkItem(claim.id, this.options.owner)
          return
        }
        if (!(await this.ensureActiveBeforeEffect(claim, currentView, currentAttempt)))
          return
        if (!(await this.acquireCapacity(claim, 'rail'))) return
        const result = await this.options.executor.submit({ prepared, signed })
        this.logger?.info(
          {
            worker: this.options.owner,
            paymentId: view.payment.id,
            attemptId: attempt.id,
            dependency: 'rail',
            state: result.status,
            ...(view.payment.correlationId === undefined ||
            view.payment.correlationId === null
              ? {}
              : { correlationId: view.payment.correlationId }),
          },
          'Settlement rail submission observed',
        )
        await this.handleSubmissionResult(
          claim,
          currentView,
          currentAttempt,
          prepared,
          result,
        )
      } finally {
        signed.signedPayload.fill(0)
      }
    } catch (error) {
      await this.handleFailure(claim, error)
    }
  }

  private async ensureActiveBeforeEffect(
    claim: V2WorkItemClaim,
    view: V2PaymentView,
    attempt: V2PaymentAttemptSnapshot,
  ): Promise<boolean> {
    const currentView =
      claim.accountId === undefined
        ? view
        : ((await this.options.repository.findPaymentView(
            claim.accountId,
            view.payment.id,
          )) ?? view)
    const currentAttempt = currentView.attempts.at(-1) ?? attempt
    const status = await this.options.accountStatusProvider.getStatus(
      currentView.payment.payerAccountId,
    )
    if (status === 'ACTIVE') return true
    if (
      currentAttempt.outcome === 'NOT_STARTED' &&
      currentAttempt.signedPayloadHash === null
    ) {
      await this.options.repository.abortPreEffectPayment({
        paymentId: currentView.payment.id,
        attemptId: currentAttempt.id,
        paymentRowVersion: currentView.payment.rowVersion,
        attemptRowVersion: currentAttempt.rowVersion,
        reason: 'ACCOUNT_DISABLED_PRE_EFFECT',
      })
      await this.options.repository.completeWorkItem(claim.id, this.options.owner)
      return false
    }
    if (
      currentAttempt.outcome === 'NOT_STARTED' &&
      currentAttempt.signedPayloadHash !== null
    ) {
      await this.markPossibleEffect(claim, currentView, currentAttempt)
      return false
    }
    throw new CustodyUnavailableError(
      'Account is not active for a possible-effect attempt',
    )
  }

  private async ensurePreparedAttemptIsCurrent(
    claim: V2WorkItemClaim,
    prepared: V2PreparedEffect,
  ): Promise<boolean> {
    const currentView =
      claim.accountId === undefined
        ? null
        : await this.options.repository.findPaymentView(
            claim.accountId,
            prepared.paymentId,
          )
    const currentAttempt = currentView?.attempts.at(-1)
    if (
      currentAttempt === undefined ||
      currentAttempt.id !== prepared.attemptId ||
      currentAttempt.preparedEffectHash !== prepared.effectHash
    ) {
      await this.options.repository.completeWorkItem(claim.id, this.options.owner)
      return false
    }
    return true
  }

  private async handleSubmissionResult(
    claim: V2WorkItemClaim,
    view: V2PaymentView,
    attempt: V2PaymentAttemptSnapshot,
    prepared: V2PreparedEffect,
    result: Awaited<ReturnType<V2OutgoingExecutor['submit']>>,
  ): Promise<void> {
    if (result.status === 'CONFIRMED') {
      await this.options.repository.finalizeV2Payment({
        paymentId: view.payment.id,
        attemptId: attempt.id,
        paymentRowVersion: view.payment.rowVersion,
        attemptRowVersion: attempt.rowVersion,
        currentOutcome: attempt.outcome,
        nextOutcome: 'CONFIRMED',
        attemptStatus: 'CONFIRMED',
        paymentStatus: 'CONFIRMED',
        settlementState: 'CONFIRMED',
        outcomeState: 'CONFIRMED',
        ...(result.externalId === undefined ? {} : { externalId: result.externalId }),
        ...evidenceFields(attempt, prepared, attempt.expectedExternalId ?? undefined),
        ...(result.evidenceMetadataJson === undefined
          ? {}
          : {
              metadataJson: mergeEvidenceMetadata(
                evidenceFields(
                  attempt,
                  prepared,
                  attempt.expectedExternalId ?? undefined,
                ).metadataJson,
                result.evidenceMetadataJson,
              ),
            }),
        confirmedAt: this.now(),
        reservation: 'CONSUME',
        evidenceOutcome: 'CONFIRMED',
        source: 'V2_OUTGOING_WORKER',
      })
      await this.reconcilePlatformCost(prepared, result.platformCostActual)
      await this.options.repository.completeWorkItem(claim.id, this.options.owner)
      return
    }
    if (result.status === 'SUBMITTED') {
      await this.options.repository.updateAttemptOutcome({
        attemptId: attempt.id,
        currentOutcome: attempt.outcome,
        nextOutcome: 'SUBMITTED',
        currentRowVersion: attempt.rowVersion,
        status: 'SUBMITTED',
        ...(result.externalId === undefined ? {} : { externalId: result.externalId }),
      })
      await this.options.repository.updatePaymentExecution({
        paymentId: view.payment.id,
        currentRowVersion: view.payment.rowVersion,
        status: 'SUBMITTED',
        executionState: 'RECONCILING',
        settlementState: 'SUBMITTED',
      })
      await this.recordObservation({
        paymentId: view.payment.id,
        attemptId: attempt.id,
        outcome: 'SUBMITTED',
        ...(result.externalId === undefined ? {} : { externalId: result.externalId }),
        ...evidenceFields(attempt, prepared, attempt.expectedExternalId ?? undefined),
        ...(result.evidenceMetadataJson === undefined
          ? {}
          : {
              metadataJson: mergeEvidenceMetadata(
                evidenceFields(
                  attempt,
                  prepared,
                  attempt.expectedExternalId ?? undefined,
                ).metadataJson,
                result.evidenceMetadataJson,
              ),
            }),
        source: 'V2_OUTGOING_WORKER',
      })
      await this.options.repository.retryWorkItem({
        id: claim.id,
        owner: this.options.owner,
        retryAt: computeRetryAt({ now: this.now(), attemptCount: claim.attemptCount }),
        errorCode: 'SUBMISSION_OBSERVED',
        errorSafe: 'Submitted settlement awaits authoritative confirmation',
        ...this.reconciliationKindInput(claim),
      })
      return
    }
    if (result.status === 'UNKNOWN') {
      await this.options.repository.updateAttemptOutcome({
        attemptId: attempt.id,
        currentOutcome: attempt.outcome,
        nextOutcome: 'UNKNOWN',
        currentRowVersion: attempt.rowVersion,
        status: 'RECONCILING',
        ...(result.externalId === undefined ? {} : { externalId: result.externalId }),
      })
      await this.options.repository.updatePaymentExecution({
        paymentId: view.payment.id,
        currentRowVersion: view.payment.rowVersion,
        status: 'RECONCILING',
        executionState: 'RECONCILING',
        settlementState: 'UNKNOWN',
        outcomeState: 'UNDETERMINED',
      })
      await this.recordObservation({
        paymentId: view.payment.id,
        attemptId: attempt.id,
        outcome: 'UNKNOWN',
        ...(result.externalId === undefined ? {} : { externalId: result.externalId }),
        ...evidenceFields(attempt, prepared, attempt.expectedExternalId ?? undefined),
        ...(result.evidenceMetadataJson === undefined
          ? {}
          : {
              metadataJson: mergeEvidenceMetadata(
                evidenceFields(
                  attempt,
                  prepared,
                  attempt.expectedExternalId ?? undefined,
                ).metadataJson,
                result.evidenceMetadataJson,
              ),
            }),
        source: 'V2_OUTGOING_WORKER',
      })
      await this.options.repository.retryWorkItem({
        id: claim.id,
        owner: this.options.owner,
        retryAt: computeRetryAt({ now: this.now(), attemptCount: claim.attemptCount }),
        errorCode: 'OUTCOME_UNKNOWN',
        errorSafe: 'Settlement outcome requires reconciliation',
        ...this.reconciliationKindInput(claim),
      })
      return
    }
    await this.options.repository.finalizeV2Payment({
      paymentId: view.payment.id,
      attemptId: attempt.id,
      paymentRowVersion: view.payment.rowVersion,
      attemptRowVersion: attempt.rowVersion,
      currentOutcome: attempt.outcome,
      nextOutcome: 'FAILED',
      attemptStatus: 'FAILED',
      paymentStatus: 'FAILED',
      settlementState: 'NOT_SUBMITTED',
      outcomeState: 'PROVED_NO_EFFECT',
      ...(result.failureCode === undefined ? {} : { failureCode: result.failureCode }),
      ...(result.failureMessageSafe === undefined
        ? {}
        : { failureMessageSafe: result.failureMessageSafe }),
      ...evidenceFields(attempt, prepared),
      reservation: 'RELEASE',
      evidenceOutcome: 'PROVED_NO_EFFECT',
      source: 'V2_OUTGOING_WORKER',
    })
    await this.options.repository.completeWorkItem(claim.id, this.options.owner)
  }

  private async processReconciliation(
    claim: V2WorkItemClaim,
    view: V2PaymentView,
    attempt: V2PaymentAttemptSnapshot,
  ): Promise<void> {
    if (this.options.executor.reconcile === undefined) {
      await this.options.repository.retryWorkItem({
        id: claim.id,
        owner: this.options.owner,
        retryAt: computeRetryAt({ now: this.now(), attemptCount: claim.attemptCount }),
        errorCode: 'RECONCILIATION_UNAVAILABLE',
        errorSafe: 'Settlement reconciliation is unavailable',
      })
      return
    }
    if (!(await this.acquireCapacity(claim, 'rpc'))) return
    const prepared = restorePreparedEffect(attempt)
    let signedPayload: Uint8Array | undefined
    if (
      prepared !== undefined &&
      this.options.signedPayloadCipher !== undefined &&
      attempt.signedPayloadEncrypted !== undefined &&
      attempt.signedPayloadEncrypted !== null
    ) {
      signedPayload = restoreSignedEffect(
        this.options.signedPayloadCipher,
        attempt.signedPayloadEncrypted,
        prepared,
        attempt.expectedExternalId,
        attempt.signedPayloadHash,
      ).signedPayload
    }
    let result: Awaited<ReturnType<NonNullable<V2OutgoingExecutor['reconcile']>>>
    try {
      result = await this.options.executor.reconcile({
        view,
        attempt,
        ...(signedPayload === undefined ? {} : { signedPayload }),
      })
    } finally {
      signedPayload?.fill(0)
    }
    if (result.status === 'CONFIRMED') {
      await this.options.repository.finalizeV2Payment({
        paymentId: view.payment.id,
        attemptId: attempt.id,
        paymentRowVersion: view.payment.rowVersion,
        attemptRowVersion: attempt.rowVersion,
        currentOutcome: attempt.outcome,
        nextOutcome: 'CONFIRMED',
        attemptStatus: 'CONFIRMED',
        paymentStatus: 'CONFIRMED',
        settlementState: 'CONFIRMED',
        outcomeState: 'CONFIRMED',
        ...(result.externalId === undefined ? {} : { externalId: result.externalId }),
        ...evidenceFields(attempt, undefined, attempt.expectedExternalId ?? undefined),
        ...(result.evidenceMetadataJson === undefined
          ? {}
          : {
              metadataJson: mergeEvidenceMetadata(
                evidenceFields(
                  attempt,
                  undefined,
                  attempt.expectedExternalId ?? undefined,
                ).metadataJson,
                result.evidenceMetadataJson,
              ),
            }),
        confirmedAt: this.now(),
        reservation: 'CONSUME',
        evidenceOutcome: 'CONFIRMED',
        source: 'V2_RECONCILIATION_WORKER',
      })
      await this.reconcilePlatformCostFromAttempt(attempt, result.platformCostActual)
      await this.options.repository.completeWorkItem(claim.id, this.options.owner)
      return
    }
    if (result.status === 'PROVED_NO_EFFECT') {
      const replacement = await this.findReplacementAttempt(view)
      await this.options.repository.finalizeV2Payment({
        paymentId: view.payment.id,
        attemptId: attempt.id,
        paymentRowVersion: view.payment.rowVersion,
        attemptRowVersion: attempt.rowVersion,
        currentOutcome: attempt.outcome,
        nextOutcome: 'PROVED_NO_EFFECT',
        attemptStatus: 'FAILED',
        paymentStatus: replacement === undefined ? 'PROVED_NO_EFFECT' : 'ROUTING',
        settlementState: 'NOT_SUBMITTED',
        outcomeState: replacement === undefined ? 'PROVED_NO_EFFECT' : 'NONE',
        ...evidenceFields(attempt),
        reservation: replacement === undefined ? 'RELEASE' : 'NONE',
        evidenceOutcome: 'PROVED_NO_EFFECT',
        source: 'V2_RECONCILIATION_WORKER',
        ...(replacement === undefined ? {} : { replacement }),
      })
      await this.options.repository.completeWorkItem(claim.id, this.options.owner)
      return
    }
    if (
      result.externalId !== undefined &&
      result.externalId !== attempt.expectedExternalId
    ) {
      await this.options.repository.updateAttemptOutcome({
        attemptId: attempt.id,
        currentOutcome: attempt.outcome,
        nextOutcome: attempt.outcome,
        currentRowVersion: attempt.rowVersion,
        status: 'RECONCILING',
        externalId: result.externalId,
      })
    }
    await this.recordObservation({
      paymentId: view.payment.id,
      attemptId: attempt.id,
      outcome: 'UNKNOWN',
      ...(result.externalId === undefined ? {} : { externalId: result.externalId }),
      ...evidenceFields(attempt, undefined, attempt.expectedExternalId ?? undefined),
      ...(result.evidenceMetadataJson === undefined
        ? {}
        : {
            metadataJson: mergeEvidenceMetadata(
              evidenceFields(
                attempt,
                undefined,
                attempt.expectedExternalId ?? undefined,
              ).metadataJson,
              result.evidenceMetadataJson,
            ),
          }),
      source: 'V2_RECONCILIATION_WORKER',
    })
    await this.options.repository.retryWorkItem({
      id: claim.id,
      owner: this.options.owner,
      retryAt: computeRetryAt({ now: this.now(), attemptCount: claim.attemptCount }),
      errorCode: 'OUTCOME_UNKNOWN',
      errorSafe: 'Settlement outcome remains unknown',
      ...this.reconciliationKindInput(claim),
    })
  }

  private async findReplacementAttempt(view: V2PaymentView): Promise<
    | {
        readonly attemptId: string
        readonly workItemId: string
        readonly route: Awaited<
          ReturnType<V2DatabaseRepository['listActiveSettlementRoutes']>
        >[number]
        readonly economicMappingId: string
        readonly destinationSnapshotJson: string
      }
    | undefined
  > {
    const attemptedRouteIds = new Set(
      view.attempts.flatMap((attempt) =>
        attempt.routeId === null ? [] : [attempt.routeId],
      ),
    )
    const routes = [...(await this.options.repository.listActiveSettlementRoutes())]
      .filter((route) => !attemptedRouteIds.has(route.id))
      .sort(
        (left, right) =>
          left.priority - right.priority || left.id.localeCompare(right.id),
      )
    const route = routes[0]
    if (route === undefined) return undefined
    const asset = await this.options.repository.findSettlementAsset(
      route.settlementAssetId,
    )
    const mapping = await this.options.repository.findEconomicMapping(
      route.economicMappingId,
    )
    if (
      asset === null ||
      asset.status !== 'ACTIVE' ||
      asset.rail !== route.rail ||
      asset.network !== route.network ||
      mapping === null ||
      mapping.status !== 'ACTIVE' ||
      mapping.denominationId !== view.payment.denominationId ||
      mapping.settlementAssetId !== asset.id
    ) {
      throw new InvalidStateError('Replacement settlement asset is unavailable')
    }
    let destination: unknown
    try {
      destination = JSON.parse(view.payment.destinationSnapshotJson ?? '') as unknown
    } catch {
      throw new InvalidStateError('Payment destination snapshot is invalid JSON')
    }
    if (
      !isRecord(destination) ||
      typeof destination.wallet_address !== 'string' ||
      destination.wallet_address.length === 0
    ) {
      throw new InvalidStateError('Payment destination snapshot is incomplete')
    }
    return {
      attemptId: `attempt_${randomUUID()}`,
      workItemId: `work_${randomUUID()}`,
      route,
      economicMappingId: mapping.id,
      destinationSnapshotJson: JSON.stringify({
        ...destination,
        rail: route.rail,
        network: route.network,
        asset_reference: asset.assetReference,
      }),
    }
  }

  private async handleFailure(claim: V2WorkItemClaim, error: unknown): Promise<void> {
    const decision = classifyWorkFailure(error, 'RAIL')
    const view = await this.loadClaimView(claim)
    const errorDetail = errorDetailSafe(error)
    this.options.metrics?.incrementCounter('mux_worker_failures_total', {
      result: decision.classification,
    })
    this.logger?.error?.(
      {
        worker: this.options.owner,
        workItemId: claim.id,
        resourceType: claim.resourceType,
        resourceId: claim.resourceId,
        dependency: 'rail',
        errorCode: decision.reasonCode,
        ...(view?.payment.correlationId === undefined ||
        view?.payment.correlationId === null
          ? {}
          : { correlationId: view.payment.correlationId }),
        ...(errorDetail === undefined ? {} : { errorDetail }),
      },
      'Outgoing work item failed',
    )
    const attempt = view?.attempts.at(-1)
    if (
      attempt !== undefined &&
      attempt.outcome === 'NOT_STARTED' &&
      attempt.signedPayloadHash !== null
    ) {
      await this.markPossibleEffect(claim, view as V2PaymentView, attempt)
      return
    }
    if (decision.classification === 'NO_RETRY') {
      if (view !== null && attempt !== undefined && attempt.outcome === 'NOT_STARTED') {
        await this.options.repository.finalizeV2Payment({
          paymentId: view.payment.id,
          attemptId: attempt.id,
          paymentRowVersion: view.payment.rowVersion,
          attemptRowVersion: attempt.rowVersion,
          currentOutcome: attempt.outcome,
          nextOutcome: 'FAILED',
          attemptStatus: 'FAILED',
          paymentStatus: 'FAILED',
          settlementState: 'NOT_SUBMITTED',
          outcomeState: 'PROVED_NO_EFFECT',
          failureCode: decision.reasonCode,
          failureMessageSafe: failureMessageSafe(error),
          ...evidenceFields(attempt),
          reservation: 'RELEASE',
          evidenceOutcome: 'PROVED_NO_EFFECT',
          source: 'V2_OUTGOING_WORKER',
        })
        await this.options.repository.completeWorkItem(claim.id, this.options.owner)
        return
      }
      await this.options.repository.failWorkItem({
        id: claim.id,
        owner: this.options.owner,
        errorCode: decision.reasonCode,
        errorSafe: 'Outgoing execution failed without a safe retry',
      })
      return
    }
    await this.options.repository.retryWorkItem({
      id: claim.id,
      owner: this.options.owner,
      retryAt: computeRetryAt({ now: this.now(), attemptCount: claim.attemptCount }),
      errorCode: decision.reasonCode,
      errorSafe: 'Outgoing execution requires a safe retry or reconciliation',
    })
  }

  private async acquireCapacity(
    claim: V2WorkItemClaim,
    dependency: CapacityDependency,
  ): Promise<boolean> {
    if (this.options.capacity === undefined) return true
    const result = await this.options.capacity.acquire(dependency, this.now())
    if (result.allowed) return true
    this.options.metrics?.incrementCounter('mux_dependency_backpressure_total', {
      dependency,
    })
    await this.options.repository.deferWorkItem({
      id: claim.id,
      owner: this.options.owner,
      retryAt: retryAtAfter(
        result.retryAt,
        computeRetryAt({ now: this.now(), attemptCount: claim.attemptCount }),
      ),
      errorCode: 'CAPACITY_BACKPRESSURE',
      errorSafe: `${dependency} capacity is temporarily exhausted`,
    })
    return false
  }

  private startLeaseHeartbeat(claim: V2WorkItemClaim): { stop(): void } {
    const repository = this.options.repository as V2DatabaseRepository & {
      readonly renewWorkItemLease?: V2DatabaseRepository['renewWorkItemLease']
    }
    if (typeof repository.renewWorkItemLease !== 'function') {
      return { stop: () => undefined }
    }
    const intervalMs = Math.max(
      1_000,
      Math.floor(((this.options.leaseSeconds ?? DEFAULT_LEASE_SECONDS) * 1_000) / 3),
    )
    const timer = setInterval(() => {
      void repository
        .renewWorkItemLease({
          id: claim.id,
          owner: this.options.owner,
          leaseSeconds: this.options.leaseSeconds ?? DEFAULT_LEASE_SECONDS,
          now: this.now(),
        })
        .catch((error: unknown) => {
          this.logger?.info(
            { errorCode: error instanceof Error ? error.name : 'UNKNOWN' },
            'Outgoing work-item lease renewal failed',
          )
        })
    }, intervalMs)
    return { stop: () => clearInterval(timer) }
  }

  private async loadClaimView(claim: V2WorkItemClaim): Promise<V2PaymentView | null> {
    if (claim.accountId === undefined) return null
    return this.options.repository.findPaymentView(
      claim.accountId,
      paymentIdFromClaim(claim),
    )
  }

  private async markPossibleEffect(
    claim: V2WorkItemClaim,
    view: V2PaymentView,
    attempt: V2PaymentAttemptSnapshot,
  ): Promise<void> {
    if (attempt.outcome !== 'NOT_STARTED') return
    await this.options.repository.updateAttemptOutcome({
      attemptId: attempt.id,
      currentOutcome: attempt.outcome,
      nextOutcome: 'UNKNOWN',
      currentRowVersion: attempt.rowVersion,
      status: 'RECONCILING',
    })
    await this.options.repository.updatePaymentExecution({
      paymentId: view.payment.id,
      currentRowVersion: view.payment.rowVersion,
      status: 'RECONCILING',
      executionState: 'RECONCILING',
      settlementState: 'UNKNOWN',
      outcomeState: 'UNDETERMINED',
    })
    await this.recordObservation({
      paymentId: view.payment.id,
      attemptId: attempt.id,
      outcome: 'UNKNOWN',
      ...evidenceFields(attempt),
      source: 'V2_OUTGOING_WORKER',
    })
    await this.options.repository.retryWorkItem({
      id: claim.id,
      owner: this.options.owner,
      retryAt: computeRetryAt({ now: this.now(), attemptCount: claim.attemptCount }),
      errorCode: 'OUTCOME_UNKNOWN',
      errorSafe: 'Submission outcome requires reconciliation',
      ...this.reconciliationKindInput(claim),
    })
  }

  private reconciliationKindFor(claim: V2WorkItemClaim): string | undefined {
    return claim.kind === 'OUTGOING_PAYMENT_ATTEMPT' ||
      claim.kind === 'OUTGOING_PAYMENT'
      ? 'RECONCILE_PAYMENT_ATTEMPT'
      : undefined
  }

  private reconciliationKindInput(claim: V2WorkItemClaim): {
    readonly nextKind?: string
  } {
    const nextKind = this.reconciliationKindFor(claim)
    return nextKind === undefined ? {} : { nextKind }
  }

  private async requeueForOutgoing(claim: V2WorkItemClaim): Promise<void> {
    await this.options.repository.retryWorkItem({
      id: claim.id,
      owner: this.options.owner,
      retryAt: this.now(),
      errorCode: 'OUTGOING_WORK_ITEM_ROUTED_TO_EXECUTOR',
      errorSafe: 'Work item requires the outgoing execution role',
      nextKind: 'OUTGOING_PAYMENT_ATTEMPT',
    })
  }

  private async recordObservation(input: {
    readonly paymentId: string
    readonly attemptId: string
    readonly outcome: string
    readonly externalId?: string
    readonly expectedExternalId?: string
    readonly payloadHash?: string
    readonly metadataJson?: string
    readonly source: string
  }): Promise<void> {
    await this.options.repository.recordEvidence?.({
      id: `evidence_${randomUUID()}`,
      paymentId: input.paymentId,
      attemptId: input.attemptId,
      authority: 'RAIL',
      source: input.source,
      outcome: input.outcome,
      observedAt: this.now(),
      ...(input.externalId === undefined ? {} : { externalId: input.externalId }),
      ...(input.expectedExternalId === undefined
        ? {}
        : { expectedExternalId: input.expectedExternalId }),
      ...(input.payloadHash === undefined ? {} : { payloadHash: input.payloadHash }),
      ...(input.metadataJson === undefined ? {} : { metadataJson: input.metadataJson }),
    })
  }

  private async persistPlatformCostEstimate(prepared: V2PreparedEffect): Promise<void> {
    const estimate = prepared.platformCostEstimate
    if (estimate === undefined) return
    if (this.options.platformCosts === undefined) {
      throw new InvalidStateError(
        'Platform cost persistence is unavailable for a prepared effect',
      )
    }
    await this.options.platformCosts.createPlatformCostEstimate({
      id: platformCostRecordId(prepared.attemptId, prepared.effectHash),
      accountId: prepared.accountId,
      paymentId: prepared.paymentId,
      attemptId: prepared.attemptId,
      assetId: estimate.assetId,
      estimatedAmount: estimate.amountAtomic,
    })
  }

  private async reconcilePlatformCostFromAttempt(
    attempt: V2PaymentAttemptSnapshot,
    actual: V2PlatformCostObservation | undefined,
  ): Promise<void> {
    if (actual === undefined || attempt.preparedEffectJson === null) return
    const prepared = restorePreparedEffect(attempt)
    if (prepared === undefined) return
    await this.reconcilePlatformCost(prepared, actual)
  }

  private async reconcilePlatformCost(
    prepared: V2PreparedEffect,
    actual: V2PlatformCostObservation | undefined,
  ): Promise<void> {
    const estimate = prepared.platformCostEstimate
    if (estimate === undefined || actual === undefined) return
    if (actual.assetId !== estimate.assetId || actual.amountAtomic < 0n) {
      this.logger?.error?.(
        {
          attemptId: prepared.attemptId,
          errorCode: 'PLATFORM_COST_IDENTITY_MISMATCH',
        },
        'Observed platform cost did not match the prepared cost asset',
      )
      return
    }
    if (this.options.platformCosts === undefined) {
      this.logger?.error?.(
        {
          attemptId: prepared.attemptId,
          errorCode: 'PLATFORM_COST_PERSISTENCE_UNAVAILABLE',
        },
        'Observed platform cost could not be persisted',
      )
      return
    }
    try {
      await this.options.platformCosts.reconcilePlatformCost({
        id: platformCostRecordId(prepared.attemptId, prepared.effectHash),
        actualAmount: actual.amountAtomic,
        observedAt: this.now(),
      })
    } catch (error) {
      this.logger?.error?.(
        {
          attemptId: prepared.attemptId,
          errorCode: error instanceof Error ? error.name : 'UNKNOWN',
        },
        'Observed platform cost reconciliation failed',
      )
    }
  }
}

function hashBytes(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function evidenceFields(
  attempt: V2PaymentAttemptSnapshot,
  prepared?: V2PreparedEffect,
  expectedExternalId?: string,
): {
  readonly expectedExternalId?: string
  readonly payloadHash?: string
  readonly metadataJson: string
} {
  const metadata = {
    ...(attempt.preparedEffectHash === null
      ? {}
      : { prepared_effect_hash: attempt.preparedEffectHash }),
    ...(prepared === undefined ? {} : { prepared_payload_hash: prepared.payloadHash }),
    ...(attempt.signedPayloadHash === null
      ? {}
      : { signed_payload_hash: attempt.signedPayloadHash }),
    ...(attempt.validityExpiresAt === null
      ? {}
      : { validity_expires_at: attempt.validityExpiresAt.toISOString() }),
    ...(attempt.validitySlot === null
      ? {}
      : { validity_slot: attempt.validitySlot.toString() }),
  }
  const payloadHash = attempt.signedPayloadHash ?? prepared?.payloadHash
  return {
    ...(expectedExternalId === undefined ? {} : { expectedExternalId }),
    ...(payloadHash === undefined ? {} : { payloadHash }),
    metadataJson: JSON.stringify(metadata),
  }
}

function mergeEvidenceMetadata(baseJson: string, additionalJson: string): string {
  let base: unknown
  let additional: unknown
  try {
    base = JSON.parse(baseJson) as unknown
    additional = JSON.parse(additionalJson) as unknown
  } catch {
    throw new InvalidStateError('Settlement evidence metadata is invalid JSON')
  }
  if (!isRecord(base) || !isRecord(additional)) {
    throw new InvalidStateError('Settlement evidence metadata must be objects')
  }
  return JSON.stringify({ ...base, ...additional })
}

function serializeEncryptedPayload(value: {
  readonly ciphertext: string
  readonly nonce: string
  readonly authTag: string
}): string {
  return JSON.stringify(value)
}

function serializePreparedEffect(prepared: V2PreparedEffect): string {
  return JSON.stringify({
    ...prepared,
    amountAtomic: prepared.amountAtomic.toString(),
    ...(prepared.platformCostEstimate === undefined
      ? {}
      : {
          platformCostEstimate: {
            assetId: prepared.platformCostEstimate.assetId,
            amountAtomic: prepared.platformCostEstimate.amountAtomic.toString(),
          },
        }),
    ...(prepared.validityExpiresAt === undefined
      ? {}
      : { validityExpiresAt: prepared.validityExpiresAt.toISOString() }),
    ...(prepared.validitySlot === undefined
      ? {}
      : { validitySlot: prepared.validitySlot.toString() }),
  })
}

function restorePreparedEffect(
  attempt: V2PaymentAttemptSnapshot,
): V2PreparedEffect | undefined {
  const serialized = attempt.preparedEffectJson
  if (serialized === undefined || serialized === null) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(serialized) as unknown
  } catch {
    throw new InvalidStateError('Durable prepared effect metadata is invalid JSON')
  }
  if (!isRecord(parsed)) {
    throw new InvalidStateError('Durable prepared effect metadata is incomplete')
  }
  const accountId = readRequiredString(parsed, 'accountId')
  const paymentId = readRequiredString(parsed, 'paymentId')
  const attemptId = readRequiredString(parsed, 'attemptId')
  const correlationId = parseOptionalString(parsed.correlationId)
  const effectHash = readRequiredString(parsed, 'effectHash')
  const network = readRequiredString(parsed, 'network')
  const assetReference = readRequiredString(parsed, 'assetReference')
  const destination = readRequiredString(parsed, 'destination')
  const feePayerIdentity = readRequiredString(parsed, 'feePayerIdentity')
  const preparedPayload = readRequiredString(parsed, 'preparedPayload')
  const routeId = readRequiredString(parsed, 'routeId')
  const payloadHash = readRequiredString(parsed, 'payloadHash')
  const amountAtomic = readRequiredString(parsed, 'amountAtomic')
  const keyVersion = parsed.keyVersion
  if (
    !/^\d+$/u.test(amountAtomic) ||
    typeof keyVersion !== 'number' ||
    !Number.isInteger(keyVersion) ||
    keyVersion <= 0
  ) {
    throw new InvalidStateError(
      'Durable prepared effect amount or key version is invalid',
    )
  }
  const validityExpiresAt = parseOptionalDate(parsed.validityExpiresAt)
  const validitySlot = parseOptionalBigInt(parsed.validitySlot)
  const platformCostEstimate = parseOptionalPlatformCost(parsed.platformCostEstimate)
  return {
    accountId,
    paymentId,
    attemptId,
    ...(correlationId === undefined ? {} : { correlationId }),
    effectHash,
    network,
    assetReference,
    destination,
    amountAtomic: BigInt(amountAtomic),
    feePayerIdentity,
    keyVersion,
    preparedPayload,
    routeId,
    payloadHash,
    ...(platformCostEstimate === undefined ? {} : { platformCostEstimate }),
    ...(validityExpiresAt === undefined ? {} : { validityExpiresAt }),
    ...(validitySlot === undefined ? {} : { validitySlot }),
  }
}

function parseOptionalPlatformCost(
  value: unknown,
): V2PlatformCostObservation | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) {
    throw new InvalidStateError('Durable platform cost estimate is invalid')
  }
  const assetId = readRequiredString(value, 'assetId')
  const amountAtomic = readRequiredString(value, 'amountAtomic')
  if (!/^\d+$/u.test(amountAtomic)) {
    throw new InvalidStateError('Durable platform cost estimate is invalid')
  }
  return { assetId, amountAtomic: BigInt(amountAtomic) }
}

function readRequiredString(value: Record<string, unknown>, field: string): string {
  const result = value[field]
  if (typeof result !== 'string' || result.length === 0) {
    throw new InvalidStateError('Durable prepared effect metadata is incomplete')
  }
  return result
}

function parseOptionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    throw new InvalidStateError('Durable trace context is invalid')
  }
  return value
}

function parseOptionalDate(value: unknown): Date | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    throw new InvalidStateError('Durable prepared effect validity is invalid')
  }
  const result = new Date(value)
  if (Number.isNaN(result.getTime())) {
    throw new InvalidStateError('Durable prepared effect validity is invalid')
  }
  return result
}

function parseOptionalBigInt(value: unknown): bigint | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !/^\d+$/u.test(value)) {
    throw new InvalidStateError('Durable prepared effect slot is invalid')
  }
  return BigInt(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function restoreSignedEffect(
  cipher: WalletSecretCipher,
  serialized: string,
  prepared: V2PreparedEffect,
  expectedExternalId: string | null,
  expectedPayloadHash: string | null,
): ConstrainedSignedEffect {
  if (expectedExternalId === null || expectedPayloadHash === null) {
    throw new InvalidStateError('Durable signed effect is missing its identity')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(serialized) as unknown
  } catch {
    throw new InvalidStateError('Durable signed effect metadata is invalid JSON')
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('ciphertext' in parsed) ||
    !('nonce' in parsed) ||
    !('authTag' in parsed) ||
    typeof parsed.ciphertext !== 'string' ||
    typeof parsed.nonce !== 'string' ||
    typeof parsed.authTag !== 'string'
  ) {
    throw new InvalidStateError('Durable signed effect metadata is incomplete')
  }
  const signedPayload = cipher.decrypt({
    ciphertext: parsed.ciphertext,
    nonce: parsed.nonce,
    authTag: parsed.authTag,
  })
  try {
    if (hashBytes(signedPayload) !== expectedPayloadHash) {
      throw new InvalidStateError(
        'Durable signed effect hash does not match its payload',
      )
    }
    return {
      effectHash: prepared.effectHash,
      keyVersion: prepared.keyVersion,
      signedPayload,
      externalId: expectedExternalId,
    }
  } catch (error) {
    signedPayload.fill(0)
    throw error
  }
}

function paymentIdFromClaim(claim: V2WorkItemClaim): string {
  if (claim.resourceType === 'PAYMENT') return claim.resourceId
  let payload: unknown
  try {
    payload = JSON.parse(claim.payloadJson) as unknown
  } catch {
    throw new InvalidStateError('Outgoing work item payload is invalid JSON')
  }
  if (
    typeof payload !== 'object' ||
    payload === null ||
    !('payment_id' in payload) ||
    typeof payload.payment_id !== 'string' ||
    payload.payment_id.length === 0
  ) {
    throw new InvalidStateError('Outgoing work item payload has no payment id')
  }
  return payload.payment_id
}

function failureMessageSafe(error: unknown): string {
  if (!(error instanceof ExternalRailError)) {
    return 'Outgoing execution failed before submission'
  }
  const detail = error.message.trim().slice(0, 256)
  return detail.length === 0
    ? 'Outgoing execution failed before submission'
    : `Outgoing execution failed before submission: ${detail}`
}

function errorDetailSafe(error: unknown): string | undefined {
  if (error instanceof ExternalRailError) return redactErrorDetail(error.message)
  if (!(error instanceof Error)) return undefined
  const detail = error.message.trim()
  if (detail.length === 0) return error.name.slice(0, 256)
  return redactErrorDetail(`${error.name}: ${detail}`)
}

function redactErrorDetail(detail: string): string {
  return detail
    .replace(
      /(authorization|api[-_ ]?key|secret|private[-_ ]?key|password|token)(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/giu,
      '$1$2[REDACTED]',
    )
    .replace(/\bhttps?:\/\/[^\s/@]+:[^\s/@]+@/giu, 'https://[REDACTED]@')
    .replace(/\b[0-9a-f]{128}\b/giu, '[REDACTED_HEX_SECRET]')
    .slice(0, 256)
}

function platformCostRecordId(attemptId: string, effectHash: string): string {
  return `cost_${createHash('sha256')
    .update(`${attemptId}:${effectHash}`, 'utf8')
    .digest('hex')
    .slice(0, 59)}`
}
