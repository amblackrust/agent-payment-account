import { createHash, randomUUID } from 'node:crypto'
import {
  classifyWorkFailure,
  computeRetryAt,
  CustodyUnavailableError,
  InvalidStateError,
  type AgentAccountLifecycleStatus,
} from '@agent-payment/core'
import type {
  V2DatabaseRepository,
  V2PaymentAttemptSnapshot,
  V2PaymentView,
  V2WorkItemClaim,
} from '@agent-payment/db'
import type { V2AdminRepository } from '@agent-payment/db'
import type {
  ConstrainedEffectSigningRequest,
  ConstrainedSignedEffect,
  WalletSecretCipher,
} from './custody.js'

const DEFAULT_LEASE_SECONDS = 30
const DEFAULT_BATCH_SIZE = 10

export interface V2PreparedEffect extends ConstrainedEffectSigningRequest {
  readonly paymentId: string
  readonly attemptId: string
  readonly routeId: string
  readonly payloadHash: string
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
  }>
  reconcile?(input: {
    readonly view: V2PaymentView
    readonly attempt: V2PaymentAttemptSnapshot
  }): Promise<{
    readonly status: 'CONFIRMED' | 'PROVED_NO_EFFECT' | 'UNKNOWN'
    readonly externalId?: string
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
  readonly signedPayloadCipher?: WalletSecretCipher
  readonly serviceIdentity?: string
  readonly owner: string
  readonly leaseSeconds?: number
  readonly batchSize?: number
  readonly now?: () => Date
  readonly logger?: {
    info(data: Readonly<Record<string, unknown>>, message: string): void
  }
}

export class V2OutgoingWorker {
  private stopped = false
  private currentRun: Promise<void> | undefined
  private readonly now: () => Date

  public constructor(private readonly options: V2OutgoingWorkerOptions) {
    this.now = options.now ?? (() => new Date())
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
    const kinds = ['OUTGOING_PAYMENT_ATTEMPT', 'OUTGOING_PAYMENT'] as const
    for (let index = 0; index < batchSize; index += 1) {
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

  private async processClaim(claim: V2WorkItemClaim): Promise<void> {
    try {
      if (claim.accountId === undefined) {
        throw new InvalidStateError('Outgoing work item has no owning account')
      }
      const paymentId = paymentIdFromClaim(claim)
      const view = await this.options.repository.findPaymentView(claim.accountId, paymentId)
      if (view === null) {
        await this.options.repository.completeWorkItem(claim.id, this.options.owner)
        return
      }
      const attempt = view.attempts.at(-1)
      if (attempt === undefined) {
        await this.options.repository.completeWorkItem(claim.id, this.options.owner)
        return
      }
      if (attempt.outcome === 'SUBMITTED' || attempt.outcome === 'UNKNOWN') {
        await this.processReconciliation(claim, view, attempt)
        return
      }
      if (view.payment.status === 'PROVED_NO_EFFECT' || view.payment.status === 'CONFIRMED') {
        await this.options.repository.completeWorkItem(claim.id, this.options.owner)
        return
      }
      if (!(await this.ensureActiveBeforeEffect(claim, view, attempt))) return
      if (this.options.custody === undefined || this.options.signedPayloadCipher === undefined) {
        throw new CustodyUnavailableError(
          'Outgoing worker requires durable custody and signed-payload encryption',
        )
      }
      const prepared = await this.options.executor.prepare({ view, attempt })
      if (
        attempt.preparedEffectHash !== null &&
        attempt.preparedEffectHash !== prepared.effectHash
      ) {
        throw new InvalidStateError('Prepared effect changed after durable persistence')
      }
      await this.options.repository.updateAttemptOutcome({
        attemptId: attempt.id,
        currentOutcome: attempt.outcome,
        nextOutcome: attempt.outcome,
        currentRowVersion: attempt.rowVersion,
        status: 'PREPARED',
        preparedEffectHash: prepared.effectHash,
        ...(prepared.validityExpiresAt === undefined
          ? {}
          : { validityExpiresAt: prepared.validityExpiresAt }),
        ...(prepared.validitySlot === undefined ? {} : { validitySlot: prepared.validitySlot }),
      })
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
        (signingRequest.status !== 'PENDING' &&
          !(signingRequest.status === 'SIGNED' &&
            attempt.signedPayloadEncrypted !== undefined &&
            attempt.signedPayloadEncrypted !== null))
      ) {
        throw new CustodyUnavailableError('Signing request is not usable for this effect')
      }
      let signed: ConstrainedSignedEffect
      if (attempt.signedPayloadEncrypted !== undefined && attempt.signedPayloadEncrypted !== null) {
        signed = restoreSignedEffect(
          this.options.signedPayloadCipher,
          attempt.signedPayloadEncrypted,
          prepared,
          attempt.expectedExternalId,
          attempt.signedPayloadHash,
        )
      } else {
        try {
          signed = await this.options.executor.sign(prepared)
          await this.options.custody.completeSigningRequest(
            signingRequest.id,
            prepared.effectHash,
            'SIGNED',
          )
        } catch (error) {
          await this.options.custody.completeSigningRequest(
            signingRequest.id,
            prepared.effectHash,
            'REJECTED',
          )
          throw error
        }
      }
      await this.options.repository.updateAttemptOutcome({
        attemptId: attempt.id,
        currentOutcome: attempt.outcome,
        nextOutcome: attempt.outcome,
        currentRowVersion: attempt.rowVersion + 1,
        status: 'EXECUTING',
        signedPayloadHash: hashBytes(signed.signedPayload),
        expectedExternalId: signed.externalId,
        signedPayloadEncrypted: serializeEncryptedPayload(
          this.options.signedPayloadCipher.encrypt(signed.signedPayload),
        ),
      })
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
      if (!(await this.ensureActiveBeforeEffect(claim, currentView, currentAttempt))) return
      const result = await this.options.executor.submit({ prepared, signed })
      await this.handleSubmissionResult(claim, currentView, currentAttempt, prepared, result)
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
        : (await this.options.repository.findPaymentView(claim.accountId, view.payment.id)) ?? view
    const currentAttempt = currentView.attempts.at(-1) ?? attempt
    const status = await this.options.accountStatusProvider.getStatus(currentView.payment.payerAccountId)
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
    if (currentAttempt.outcome === 'NOT_STARTED' && currentAttempt.signedPayloadHash !== null) {
      await this.markPossibleEffect(claim, currentView, currentAttempt)
      return false
    }
    throw new CustodyUnavailableError('Account is not active for a possible-effect attempt')
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
        attemptRowVersion: attempt.rowVersion + 2,
        currentOutcome: attempt.outcome,
        nextOutcome: 'CONFIRMED',
        attemptStatus: 'CONFIRMED',
        paymentStatus: 'CONFIRMED',
        settlementState: 'CONFIRMED',
        outcomeState: 'CONFIRMED',
        ...(result.externalId === undefined ? {} : { externalId: result.externalId }),
        confirmedAt: this.now(),
        reservation: 'CONSUME',
        evidenceOutcome: 'CONFIRMED',
        source: 'V2_OUTGOING_WORKER',
      })
      await this.options.repository.completeWorkItem(claim.id, this.options.owner)
      return
    }
    if (result.status === 'SUBMITTED') {
      await this.options.repository.updateAttemptOutcome({
        attemptId: attempt.id,
        currentOutcome: attempt.outcome,
        nextOutcome: 'SUBMITTED',
        currentRowVersion: attempt.rowVersion + 2,
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
      await this.options.repository.completeWorkItem(claim.id, this.options.owner)
      return
    }
    if (result.status === 'UNKNOWN') {
      await this.options.repository.updateAttemptOutcome({
        attemptId: attempt.id,
        currentOutcome: attempt.outcome,
        nextOutcome: 'UNKNOWN',
        currentRowVersion: attempt.rowVersion + 2,
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
      await this.options.repository.retryWorkItem({
        id: claim.id,
        owner: this.options.owner,
        retryAt: computeRetryAt({ now: this.now(), attemptCount: claim.attemptCount }),
        errorCode: 'OUTCOME_UNKNOWN',
        errorSafe: 'Settlement outcome requires reconciliation',
      })
      return
    }
    await this.options.repository.finalizeV2Payment({
      paymentId: view.payment.id,
      attemptId: attempt.id,
      paymentRowVersion: view.payment.rowVersion,
      attemptRowVersion: attempt.rowVersion + 2,
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
      reservation: 'RELEASE',
      evidenceOutcome: 'PROVED_NO_EFFECT',
      source: 'V2_OUTGOING_WORKER',
    })
    await this.options.repository.completeWorkItem(claim.id, this.options.owner)
    void prepared
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
    const result = await this.options.executor.reconcile({ view, attempt })
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
        confirmedAt: this.now(),
        reservation: 'CONSUME',
        evidenceOutcome: 'CONFIRMED',
        source: 'V2_RECONCILIATION_WORKER',
      })
      await this.options.repository.completeWorkItem(claim.id, this.options.owner)
      return
    }
    if (result.status === 'PROVED_NO_EFFECT') {
      await this.options.repository.finalizeV2Payment({
        paymentId: view.payment.id,
        attemptId: attempt.id,
        paymentRowVersion: view.payment.rowVersion,
        attemptRowVersion: attempt.rowVersion,
        currentOutcome: attempt.outcome,
        nextOutcome: 'PROVED_NO_EFFECT',
        attemptStatus: 'FAILED',
        paymentStatus: 'PROVED_NO_EFFECT',
        settlementState: 'NOT_SUBMITTED',
        outcomeState: 'PROVED_NO_EFFECT',
        reservation: 'RELEASE',
        evidenceOutcome: 'PROVED_NO_EFFECT',
        source: 'V2_RECONCILIATION_WORKER',
      })
      await this.options.repository.completeWorkItem(claim.id, this.options.owner)
      return
    }
    await this.options.repository.retryWorkItem({
      id: claim.id,
      owner: this.options.owner,
      retryAt: computeRetryAt({ now: this.now(), attemptCount: claim.attemptCount }),
      errorCode: 'OUTCOME_UNKNOWN',
      errorSafe: 'Settlement outcome remains unknown',
    })
  }

  private async handleFailure(claim: V2WorkItemClaim, error: unknown): Promise<void> {
    const decision = classifyWorkFailure(error, 'RAIL')
    const view = await this.loadClaimView(claim)
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
          failureMessageSafe: 'Outgoing execution failed before submission',
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
    await this.options.repository.retryWorkItem({
      id: claim.id,
      owner: this.options.owner,
      retryAt: computeRetryAt({ now: this.now(), attemptCount: claim.attemptCount }),
      errorCode: 'OUTCOME_UNKNOWN',
      errorSafe: 'Submission outcome requires reconciliation',
    })
  }
}

function hashBytes(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function serializeEncryptedPayload(value: {
  readonly ciphertext: string
  readonly nonce: string
  readonly authTag: string
}): string {
  return JSON.stringify(value)
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
  if (hashBytes(signedPayload) !== expectedPayloadHash) {
    throw new InvalidStateError('Durable signed effect hash does not match its payload')
  }
  return {
    effectHash: prepared.effectHash,
    keyVersion: prepared.keyVersion,
    signedPayload,
    externalId: expectedExternalId,
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
