import { randomBytes } from 'node:crypto'
import {
  assertAgentAccountTransition,
  ConflictError,
  IdempotencyConflictError,
  IdempotencyKeyReusedError,
  InsufficientFundsError,
  InvalidStateError,
  NotFoundError,
  type AgentAccountLifecycleStatus,
} from '@agent-payment/core'
import type { Prisma, PrismaClient } from './generated/client/client.js'
import { createTimelineEvent } from './timeline.js'
import { enqueueWebhookEvent } from './webhook-events.js'

export interface V2AccountRecord {
  readonly id: string
  readonly name: string
  readonly status: AgentAccountLifecycleStatus
  readonly solanaPublicKey: string
  readonly workspaceId: string | null
  readonly runtimeVersion: string | null
  readonly provisioningFailureCode: string | null
  readonly disabledAt: Date | null
  readonly disabledReason: string | null
  readonly rowVersion: number
  readonly createdAt: Date
  readonly updatedAt: Date
}

export interface V2CredentialRecord {
  readonly id: string
  readonly accountId: string
  readonly keyPrefix: string
  readonly status: string
  readonly scopes: readonly string[]
  readonly expiresAt: Date | null
  readonly rotatedFromId: string | null
  readonly rowVersion: number
  readonly createdAt: Date
  readonly revokedAt: Date | null
}

export interface V2ProvisionedAccount {
  readonly account: V2AccountRecord
  readonly credential: V2CredentialRecord
  readonly recoveryEnvelope: {
    readonly idempotencyKey: string
    readonly accountId: string
    readonly credentialId: string
    readonly ciphertext: string
    readonly nonce: string
    readonly authTag: string
    readonly expiresAt: Date
  }
  readonly created: boolean
}

export interface V2CredentialIssuanceResult {
  readonly credential: V2CredentialRecord
  readonly created: boolean
}

export interface V2SpendPolicyAdminRecord {
  readonly id: string
  readonly accountId: string
  readonly version: number
  readonly status: string
  readonly denominationId: string
  readonly maxPerPaymentAtomic: bigint | null
  readonly rollingBudgetAtomic: bigint | null
  readonly rollingWindowSeconds: number | null
  readonly transactionCountCap: number | null
  readonly approvalThresholdAtomic: bigint | null
  readonly rollingBudgetEscalatable: boolean
  readonly transactionCountEscalatable: boolean
  readonly rulesJson: string
  readonly createdAt: Date
  readonly activatedAt: Date | null
  readonly retiredAt: Date | null
}

export interface V2ApprovalAdminRecord {
  readonly id: string
  readonly paymentId: string
  readonly accountId: string
  readonly fingerprint: string
  readonly policyDecisionId: string
  readonly status: string
  readonly expiresAt: Date
  readonly actorId: string | null
  readonly comment: string | null
  readonly rowVersion: number
  readonly createdAt: Date
  readonly decidedAt: Date | null
}

export interface V2FundingDestinationRecord {
  readonly id: string
  readonly accountId: string
  readonly routeId: string
  readonly network: string
  readonly assetId: string
  readonly destination: string
  readonly readiness: string
  readonly senderConstraintsJson: string
  readonly lastValidatedAt: Date | null
  readonly lastFailureCode: string | null
}

export interface V2CustodyKeyVersionRecord {
  readonly id: string
  readonly accountId: string | null
  readonly keyVersion: number
  readonly backendIdentity: string
  readonly keyReference: string
  readonly rootKeyFingerprint: string
  readonly status: string
}

export interface V2SigningRequestRecord {
  readonly id: string
  readonly paymentId: string
  readonly attemptId: string
  readonly effectHash: string
  readonly routeId: string
  readonly network: string
  readonly assetReference: string
  readonly destination: string
  readonly amountAtomic: bigint
  readonly feePayerIdentity: string
  readonly keyVersion: number
  readonly status: string
  readonly serviceIdentity: string
  readonly createdAt: Date
  readonly completedAt: Date | null
}

export interface V2HistoryRecord {
  readonly id: string
  readonly direction: 'INCOMING' | 'OUTGOING'
  readonly kind: string
  readonly status: string
  readonly amountAtomic: bigint
  readonly denominationId: string | null
  readonly currency: string
  readonly recipientId: string | null
  readonly externalId: string | null
  readonly occurredAt: Date
}

export interface V2ReceiveRequestAdminRecord {
  readonly id: string
  readonly accountId: string
  readonly amountAtomic: bigint | null
  readonly denominationId: string | null
  readonly amountScale: number | null
  readonly currency: string
  readonly reference: string
  readonly status: 'OPEN' | 'PAID' | 'EXPIRED' | 'CANCELLED'
  readonly createdAt: Date
  readonly updatedAt: Date
  readonly expiresAt: Date | null
  readonly paidAt: Date | null
  readonly matchedIncomingPaymentId: string | null
}

export interface V2AdminRepository {
  findProvisioningReplay(input: {
    readonly idempotencyKey: string
    readonly requestHash: string
  }): Promise<{ readonly accountId: string; readonly credentialId: string } | null>
  createReceiveRequestIdempotent(input: {
    readonly id: string
    readonly accountId: string
    readonly idempotencyKey: string
    readonly requestHash: string
    readonly amountAtomic?: bigint
    readonly denominationId?: string
    readonly amountScale?: number
    readonly currency: string
    readonly reference: string
    readonly createdAt: Date
    readonly expiresAt?: Date
  }): Promise<V2ReceiveRequestAdminRecord>
  provisionAccount(input: {
    readonly idempotencyKey: string
    readonly requestHash: string
    readonly accountId: string
    readonly name: string
    readonly solanaPublicKey: string
    readonly encryptedSolanaSecret: string
    readonly encryptionNonce: string
    readonly encryptionAuthTag: string
    readonly credentialId: string
    readonly keyHash: string
    readonly keyPrefix: string
    readonly scopes: readonly string[]
    readonly recoveryCiphertext: string
    readonly recoveryNonce: string
    readonly recoveryAuthTag: string
    readonly recoveryExpiresAt: Date
    readonly receiveRequestId?: string
    readonly receiveReference?: string
  }): Promise<V2ProvisionedAccount>
  findCredentialIdempotency(input: {
    readonly accountId: string
    readonly idempotencyKey: string
  }): Promise<{
    readonly requestHash: string
    readonly fingerprint: string
    readonly credential: V2CredentialRecord
  } | null>
  createCredential(input: {
    readonly accountId: string
    readonly idempotencyKey: string
    readonly requestHash: string
    readonly fingerprint: string
    readonly credentialId: string
    readonly keyHash: string
    readonly keyPrefix: string
    readonly scopes: readonly string[]
    readonly expiresAt?: Date
    readonly recoveryCiphertext: string
    readonly recoveryNonce: string
    readonly recoveryAuthTag: string
    readonly recoveryIdempotencyKey: string
    readonly recoveryExpiresAt: Date
    readonly actorId: string
  }): Promise<V2CredentialIssuanceResult>
  consumeRecoveryEnvelope(
    accountId: string,
    idempotencyKey: string,
    now?: Date,
  ): Promise<V2ProvisionedAccount['recoveryEnvelope'] | null>
  acknowledgeRecoveryEnvelope(accountId: string, idempotencyKey: string): Promise<void>
  findAccount(accountId: string): Promise<V2AccountRecord | null>
  listCredentials(accountId: string): Promise<readonly V2CredentialRecord[]>
  transitionAccount(input: {
    readonly accountId: string
    readonly currentStatus: AgentAccountLifecycleStatus
    readonly nextStatus: AgentAccountLifecycleStatus
    readonly rowVersion: number
    readonly reason?: string
    readonly actorId?: string
  }): Promise<V2AccountRecord>
  rotateCredential(input: {
    readonly accountId: string
    readonly oldCredentialId: string
    readonly newCredentialId: string
    readonly keyHash: string
    readonly keyPrefix: string
    readonly scopes: readonly string[]
    readonly expiresAt?: Date
    readonly recoveryCiphertext: string
    readonly recoveryNonce: string
    readonly recoveryAuthTag: string
    readonly recoveryIdempotencyKey: string
    readonly recoveryExpiresAt: Date
    readonly actorId?: string
  }): Promise<V2CredentialRecord>
  revokeCredential(
    accountId: string,
    credentialId: string,
    actorId?: string,
  ): Promise<void>
  listSpendPolicies(accountId: string): Promise<readonly V2SpendPolicyAdminRecord[]>
  createSpendPolicy(input: {
    readonly id: string
    readonly accountId: string
    readonly denominationId: string
    readonly maxPerPaymentAtomic: bigint | null
    readonly rollingBudgetAtomic: bigint | null
    readonly rollingWindowSeconds: number | null
    readonly transactionCountCap: number | null
    readonly approvalThresholdAtomic: bigint | null
    readonly rollingBudgetEscalatable: boolean
    readonly transactionCountEscalatable: boolean
    readonly rulesJson: string
    readonly actorId?: string
  }): Promise<V2SpendPolicyAdminRecord>
  replaceSpendPolicy(input: {
    readonly id: string
    readonly accountId: string
    readonly denominationId: string
    readonly maxPerPaymentAtomic: bigint | null
    readonly rollingBudgetAtomic: bigint | null
    readonly rollingWindowSeconds: number | null
    readonly transactionCountCap: number | null
    readonly approvalThresholdAtomic: bigint | null
    readonly rollingBudgetEscalatable: boolean
    readonly transactionCountEscalatable: boolean
    readonly rulesJson: string
    readonly expectedVersion?: number
    readonly actorId: string
  }): Promise<V2SpendPolicyAdminRecord>
  activateSpendPolicy(
    accountId: string,
    policyId: string,
    rowVersion?: number,
    actorId?: string,
  ): Promise<V2SpendPolicyAdminRecord>
  listApprovals(accountId: string): Promise<readonly V2ApprovalAdminRecord[]>
  decideApproval(input: {
    readonly accountId: string
    readonly approvalId: string
    readonly action: 'APPROVE' | 'REJECT' | 'EXPIRE'
    readonly actorId: string
    readonly comment?: string
    readonly rowVersion: number
    readonly settledAtomic?: bigint
    readonly now?: Date
  }): Promise<V2ApprovalAdminRecord>
  listApprovedDestinations(
    accountId: string,
  ): Promise<readonly V2ApprovedDestinationRecord[]>
  createApprovedDestination(input: {
    readonly id: string
    readonly accountId: string
    readonly fingerprint: string
    readonly rail: string
    readonly network: string
    readonly assetReference: string
    readonly destination: string
    readonly actorId: string
    readonly reason?: string
  }): Promise<V2ApprovedDestinationRecord>
  revokeApprovedDestination(input: {
    readonly accountId: string
    readonly id: string
    readonly actorId: string
    readonly reason: string
  }): Promise<void>
  findFundingDestination(
    accountId: string,
    routeId?: string,
  ): Promise<V2FundingDestinationRecord | null>
  upsertFundingDestination(input: {
    readonly id: string
    readonly accountId: string
    readonly routeId: string
    readonly network: string
    readonly assetId: string
    readonly destination: string
    readonly readiness: string
    readonly senderConstraintsJson: string
    readonly lastValidatedAt?: Date
    readonly lastFailureCode?: string
  }): Promise<V2FundingDestinationRecord>
  listHistory(input: {
    readonly accountId: string
    readonly limit: number
    readonly cursor?: { readonly occurredAt: Date; readonly id: string }
  }): Promise<readonly V2HistoryRecord[]>
  createCustodyKeyVersion(input: {
    readonly id: string
    readonly accountId?: string
    readonly keyVersion: number
    readonly backendIdentity: string
    readonly keyReference: string
    readonly rootKeyFingerprint: string
  }): Promise<V2CustodyKeyVersionRecord>
  findActiveCustodyKeyVersion(
    accountId: string,
  ): Promise<V2CustodyKeyVersionRecord | null>
  createSigningRequest(input: {
    readonly id: string
    readonly paymentId: string
    readonly attemptId: string
    readonly effectHash: string
    readonly routeId: string
    readonly network: string
    readonly assetReference: string
    readonly destination: string
    readonly amountAtomic: bigint
    readonly feePayerIdentity: string
    readonly keyVersion: number
    readonly serviceIdentity: string
  }): Promise<V2SigningRequestRecord>
  findSigningRequest(attemptId: string): Promise<V2SigningRequestRecord | null>
  completeSigningRequest(
    id: string,
    effectHash: string,
    status: 'SIGNED' | 'REJECTED',
  ): Promise<V2SigningRequestRecord>
  consumeRateLimit(input: {
    readonly subjectType: string
    readonly subjectId: string
    readonly bucket: string
    readonly windowSeconds: number
    readonly limit: number
    readonly now?: Date
  }): Promise<{
    readonly allowed: boolean
    readonly count: number
    readonly retryAt: Date
  }>
}

export interface V2ApprovedDestinationRecord {
  readonly id: string
  readonly accountId: string
  readonly fingerprint: string
  readonly rail: string
  readonly network: string
  readonly assetReference: string
  readonly destination: string
  readonly status: string
  readonly actorId: string
  readonly reason: string | null
  readonly createdAt: Date
  readonly revokedAt: Date | null
}

export function createV2AdminRepository(prisma: PrismaClient): V2AdminRepository {
  return {
    async provisionAccount(input) {
      return prisma.$transaction(async (transaction) => {
        // The account id is generated by the caller, so it cannot be part of
        // the lock identity for a global provisioning idempotency key.
        await transaction.$queryRaw`
          SELECT pg_advisory_xact_lock(
            hashtextextended(${`ACCOUNT_PROVISION:${input.idempotencyKey}`}, 0)
          ) IS NULL AS locked
        `
        const existing = await transaction.idempotencyRecord.findFirst({
          where: {
            operation: 'ACCOUNT_PROVISION',
            key: input.idempotencyKey,
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        })
        if (existing !== null) {
          if (existing.requestHash !== input.requestHash) {
            throw new IdempotencyConflictError()
          }
          const account = await transaction.agentAccount.findUniqueOrThrow({
            where: { id: existing.resourceId },
          })
          const credential = await transaction.apiCredential.findFirstOrThrow({
            where: { accountId: account.id, id: existing.responseSnapshot ?? '' },
          })
          const envelope = await transaction.credentialRecoveryEnvelope.findUnique({
            where: { idempotencyKey: input.idempotencyKey },
          })
          if (envelope === null) {
            throw new InvalidStateError('Credential recovery envelope is unavailable')
          }
          return {
            account: toAccountRecord(account),
            credential: toCredentialRecord(credential),
            recoveryEnvelope: toRecoveryEnvelope(envelope),
            created: false,
          }
        }

        const account = await transaction.agentAccount.create({
          data: {
            id: input.accountId,
            name: input.name,
            status: 'PROVISIONING',
            solanaPublicKey: input.solanaPublicKey,
            encryptedSolanaSecret: input.encryptedSolanaSecret,
            encryptionNonce: input.encryptionNonce,
            encryptionAuthTag: input.encryptionAuthTag,
          },
        })
        const credential = await transaction.apiCredential.create({
          data: {
            id: input.credentialId,
            accountId: input.accountId,
            keyHash: input.keyHash,
            keyPrefix: input.keyPrefix,
            scopes: JSON.stringify([...input.scopes]),
          },
        })
        const envelope = await transaction.credentialRecoveryEnvelope.create({
          data: {
            idempotencyKey: input.idempotencyKey,
            accountId: input.accountId,
            credentialId: input.credentialId,
            ciphertext: input.recoveryCiphertext,
            nonce: input.recoveryNonce,
            authTag: input.recoveryAuthTag,
            expiresAt: input.recoveryExpiresAt,
          },
        })
        if (
          input.receiveRequestId !== undefined &&
          input.receiveReference !== undefined
        ) {
          await transaction.receiveRequest.create({
            data: {
              id: input.receiveRequestId,
              accountId: input.accountId,
              currency: 'USD',
              reference: input.receiveReference,
            },
          })
        }
        await createTimelineEvent(transaction, {
          id: createId('timeline'),
          accountId: account.id,
          resourceType: 'ACCOUNT',
          resourceId: account.id,
          eventType: 'ACCOUNT_CREATED',
          actorType: 'SYSTEM',
          source: 'V2_ACCOUNT_PROVISIONING',
          occurredAt: account.createdAt,
          newStateJson: JSON.stringify({ status: account.status }),
        })
        await createTimelineEvent(transaction, {
          id: createId('timeline'),
          accountId: account.id,
          resourceType: 'CREDENTIAL',
          resourceId: credential.id,
          eventType: 'CREDENTIAL_CREATED',
          actorType: 'SYSTEM',
          source: 'V2_ACCOUNT_PROVISIONING',
          occurredAt: credential.createdAt,
          newStateJson: JSON.stringify({
            status: credential.status,
            scopes: input.scopes,
          }),
        })
        await enqueueWebhookEvent(transaction, {
          accountId: account.id,
          resourceType: 'ACCOUNT',
          resourceId: account.id,
          resourceVersion: account.rowVersion,
          eventType: 'account.created',
          resource: {
            id: account.id,
            name: account.name,
            status: account.status,
          },
        })
        await enqueueWebhookEvent(transaction, {
          accountId: account.id,
          resourceType: 'CREDENTIAL',
          resourceId: credential.id,
          resourceVersion: credential.rowVersion,
          eventType: 'credential.created',
          resource: {
            id: credential.id,
            account_id: credential.accountId,
            status: credential.status,
            scopes: input.scopes,
          },
        })
        await transaction.idempotencyRecord.create({
          data: {
            id: createId('idem'),
            ownerAccountId: input.accountId,
            operation: 'ACCOUNT_PROVISION',
            key: input.idempotencyKey,
            requestHash: input.requestHash,
            fingerprint: input.requestHash,
            resourceId: account.id,
            responseSnapshot: credential.id,
            expiresAt: input.recoveryExpiresAt,
          },
        })
        return {
          account: toAccountRecord(account),
          credential: toCredentialRecord(credential),
          recoveryEnvelope: toRecoveryEnvelope(envelope),
          created: true,
        }
      })
    },

    async createCredential(input) {
      return prisma.$transaction(async (transaction) => {
        const accountRows = await transaction.$queryRaw<Array<{ status: string }>>`
          SELECT status
          FROM "agent_accounts"
          WHERE id = ${input.accountId}
          FOR UPDATE
        `
        const account = accountRows[0]
        if (account === undefined) {
          throw new NotFoundError('Agent account was not found')
        }

        const existing = await transaction.idempotencyRecord.findUnique({
          where: {
            ownerAccountId_operation_key: {
              ownerAccountId: input.accountId,
              operation: 'V2_CREDENTIAL_CREATE',
              key: input.idempotencyKey,
            },
          },
        })
        if (existing !== null) {
          if (
            existing.requestHash !== input.requestHash ||
            existing.fingerprint !== input.fingerprint
          ) {
            throw new IdempotencyKeyReusedError()
          }
          const credential = await transaction.apiCredential.findUnique({
            where: { id: existing.resourceId },
          })
          if (credential === null || credential.accountId !== input.accountId) {
            throw new InvalidStateError(
              'Credential idempotency resource is unavailable',
            )
          }
          return { credential: toCredentialRecord(credential), created: false }
        }
        if (account.status !== 'ACTIVE') {
          throw new InvalidStateError('Agent account is not active')
        }

        const credential = await transaction.apiCredential.create({
          data: {
            id: input.credentialId,
            accountId: input.accountId,
            keyHash: input.keyHash,
            keyPrefix: input.keyPrefix,
            scopes: JSON.stringify([...input.scopes]),
            ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
          },
        })
        await transaction.credentialRecoveryEnvelope.create({
          data: {
            idempotencyKey: input.recoveryIdempotencyKey,
            accountId: input.accountId,
            credentialId: credential.id,
            ciphertext: input.recoveryCiphertext,
            nonce: input.recoveryNonce,
            authTag: input.recoveryAuthTag,
            expiresAt: input.recoveryExpiresAt,
          },
        })
        await transaction.operationTimelineEvent.create({
          data: {
            id: createId('timeline'),
            accountId: input.accountId,
            resourceType: 'CREDENTIAL',
            resourceId: credential.id,
            eventType: 'CREDENTIAL_CREATED',
            actorType: 'OPERATOR',
            actorId: input.actorId,
            source: 'V2_CREDENTIAL_ISSUANCE',
            occurredAt: new Date(),
            newStateJson: JSON.stringify({
              account_id: credential.accountId,
              status: credential.status,
              scopes: input.scopes,
              expires_at: credential.expiresAt?.toISOString() ?? null,
            }),
          },
        })
        await enqueueWebhookEvent(transaction, {
          accountId: credential.accountId,
          resourceType: 'CREDENTIAL',
          resourceId: credential.id,
          resourceVersion: credential.rowVersion,
          eventType: 'credential.created',
          resource: {
            id: credential.id,
            account_id: credential.accountId,
            status: credential.status,
            scopes: input.scopes,
            expires_at: credential.expiresAt?.toISOString() ?? null,
          },
        })
        await transaction.idempotencyRecord.create({
          data: {
            id: createId('idem'),
            ownerAccountId: input.accountId,
            operation: 'V2_CREDENTIAL_CREATE',
            key: input.idempotencyKey,
            requestHash: input.requestHash,
            fingerprint: input.fingerprint,
            resourceId: credential.id,
            responseSnapshot: JSON.stringify({ credential_id: credential.id }),
            expiresAt: input.recoveryExpiresAt,
          },
        })
        return { credential: toCredentialRecord(credential), created: true }
      })
    },

    async findCredentialIdempotency(input) {
      const record = await prisma.idempotencyRecord.findUnique({
        where: {
          ownerAccountId_operation_key: {
            ownerAccountId: input.accountId,
            operation: 'V2_CREDENTIAL_CREATE',
            key: input.idempotencyKey,
          },
        },
      })
      if (record === null) return null
      const credential = await prisma.apiCredential.findUnique({
        where: { id: record.resourceId },
      })
      if (credential === null || credential.accountId !== input.accountId) {
        throw new InvalidStateError('Credential idempotency resource is unavailable')
      }
      return {
        requestHash: record.requestHash,
        fingerprint: record.fingerprint ?? record.requestHash,
        credential: toCredentialRecord(credential),
      }
    },

    async findProvisioningReplay(input) {
      const record = await prisma.idempotencyRecord.findFirst({
        where: { operation: 'ACCOUNT_PROVISION', key: input.idempotencyKey },
        select: { resourceId: true, responseSnapshot: true, requestHash: true },
      })
      if (record === null || record.responseSnapshot === null) return null
      if (record.requestHash !== input.requestHash) throw new IdempotencyConflictError()
      return { accountId: record.resourceId, credentialId: record.responseSnapshot }
    },

    async createReceiveRequestIdempotent(input) {
      return prisma.$transaction(async (transaction) => {
        const existing = await transaction.idempotencyRecord.findUnique({
          where: {
            ownerAccountId_operation_key: {
              ownerAccountId: input.accountId,
              operation: 'V2_RECEIVE_REQUEST',
              key: input.idempotencyKey,
            },
          },
        })
        if (existing !== null) {
          if (existing.requestHash !== input.requestHash) {
            throw new IdempotencyConflictError()
          }
          return toReceiveRequestAdminRecord(
            await transaction.receiveRequest.findUniqueOrThrow({
              where: { id: existing.resourceId },
            }),
          )
        }
        const request = await transaction.receiveRequest.create({
          data: {
            id: input.id,
            accountId: input.accountId,
            ...(input.amountAtomic === undefined
              ? {}
              : { amountAtomic: input.amountAtomic }),
            ...(input.denominationId === undefined
              ? {}
              : { denominationId: input.denominationId }),
            ...(input.amountScale === undefined
              ? {}
              : { amountScale: input.amountScale }),
            currency: input.currency,
            reference: input.reference,
            createdAt: input.createdAt,
            ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
          },
        })
        await enqueueWebhookEvent(transaction, {
          accountId: request.accountId,
          resourceType: 'RECEIVE_REQUEST',
          resourceId: request.id,
          resourceVersion: 1,
          eventType: 'receive_request.created',
          resource: {
            id: request.id,
            account_id: request.accountId,
            amount_atomic: request.amountAtomic?.toString() ?? null,
            denomination_id: request.denominationId,
            reference: request.reference,
            status: request.status,
            expires_at: request.expiresAt?.toISOString() ?? null,
          },
        })
        await transaction.idempotencyRecord.create({
          data: {
            id: createId('idem'),
            ownerAccountId: input.accountId,
            operation: 'V2_RECEIVE_REQUEST',
            key: input.idempotencyKey,
            requestHash: input.requestHash,
            fingerprint: input.requestHash,
            resourceId: request.id,
            responseSnapshot: JSON.stringify({ receive_request_id: request.id }),
          },
        })
        return toReceiveRequestAdminRecord(request)
      })
    },

    async consumeRecoveryEnvelope(accountId, idempotencyKey, now = new Date()) {
      return prisma.$transaction(async (transaction) => {
        const envelope = await transaction.credentialRecoveryEnvelope.findUnique({
          where: { idempotencyKey },
        })
        if (envelope === null || envelope.accountId !== accountId) return null
        if (envelope.expiresAt <= now || envelope.acknowledgedAt !== null) {
          await transaction.credentialRecoveryEnvelope.deleteMany({
            where: { idempotencyKey },
          })
          return null
        }
        const deleted = await transaction.credentialRecoveryEnvelope.deleteMany({
          where: { idempotencyKey, acknowledgedAt: null },
        })
        if (deleted.count !== 1) return null
        await createTimelineEvent(transaction, {
          id: createId('timeline'),
          accountId,
          resourceType: 'CREDENTIAL_RECOVERY_ENVELOPE',
          resourceId: envelope.credentialId,
          eventType: 'CREDENTIAL_RECOVERY_CONSUMED',
          actorType: 'SYSTEM',
          source: 'V2_CREDENTIAL_RECOVERY',
          occurredAt: new Date(),
          newStateJson: JSON.stringify({
            credential_id: envelope.credentialId,
            recovery_available: false,
          }),
        })
        return toRecoveryEnvelope(envelope)
      })
    },

    async acknowledgeRecoveryEnvelope(accountId, idempotencyKey) {
      await prisma.$transaction(async (transaction) => {
        const envelope = await transaction.credentialRecoveryEnvelope.findUnique({
          where: { idempotencyKey },
        })
        if (envelope === null || envelope.accountId !== accountId) return
        const deleted = await transaction.credentialRecoveryEnvelope.deleteMany({
          where: { accountId, idempotencyKey },
        })
        if (deleted.count !== 1) return
        await createTimelineEvent(transaction, {
          id: createId('timeline'),
          accountId,
          resourceType: 'CREDENTIAL_RECOVERY_ENVELOPE',
          resourceId: envelope.credentialId,
          eventType: 'CREDENTIAL_RECOVERY_ACKNOWLEDGED',
          actorType: 'OPERATOR',
          source: 'V2_CREDENTIAL_RECOVERY',
          occurredAt: new Date(),
          newStateJson: JSON.stringify({
            credential_id: envelope.credentialId,
            recovery_available: false,
          }),
        })
      })
    },

    async findAccount(accountId) {
      const account = await prisma.agentAccount.findUnique({ where: { id: accountId } })
      return account === null ? null : toAccountRecord(account)
    },

    async listCredentials(accountId) {
      const credentials = await prisma.apiCredential.findMany({
        where: { accountId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      })
      return credentials.map(toCredentialRecord)
    },

    async transitionAccount(input) {
      assertAgentAccountTransition(input.currentStatus, input.nextStatus)
      const result = await prisma.$transaction(async (transaction) => {
        const currentRows = await transaction.$queryRaw<
          Array<{ status: string; row_version: number }>
        >`
          SELECT status, row_version
          FROM "agent_accounts"
          WHERE id = ${input.accountId}
          FOR UPDATE
        `
        const current = currentRows[0]
        if (current === undefined)
          throw new NotFoundError('Agent account was not found')
        if (
          current.status !== input.currentStatus ||
          current.row_version !== input.rowVersion
        ) {
          throw new ConflictError('Account lifecycle changed concurrently')
        }
        const updated = await transaction.agentAccount.updateMany({
          where: {
            id: input.accountId,
            status: input.currentStatus,
            rowVersion: input.rowVersion,
          },
          data: {
            status: input.nextStatus,
            rowVersion: { increment: 1 },
            ...(input.nextStatus === 'DISABLED'
              ? { disabledAt: new Date(), disabledReason: input.reason ?? null }
              : input.nextStatus === 'ACTIVE'
                ? {
                    disabledAt: null,
                    disabledReason: null,
                    provisioningFailureCode: null,
                  }
                : input.nextStatus === 'PROVISIONING_FAILED'
                  ? { provisioningFailureCode: input.reason ?? 'PROVISIONING_FAILED' }
                  : {}),
          },
        })
        if (updated.count !== 1) {
          throw new ConflictError('Account lifecycle changed concurrently')
        }
        await transaction.operationTimelineEvent.create({
          data: {
            id: createId('timeline'),
            accountId: input.accountId,
            resourceType: 'ACCOUNT',
            resourceId: input.accountId,
            eventType: `ACCOUNT_${input.nextStatus}`,
            actorType: 'OPERATOR',
            actorId: input.actorId ?? input.accountId,
            source: 'V2_ACCOUNT_LIFECYCLE',
            occurredAt: new Date(),
            oldStateJson: JSON.stringify({ status: input.currentStatus }),
            newStateJson: JSON.stringify({
              status: input.nextStatus,
              reason: input.reason ?? null,
            }),
          },
        })
        const updatedAccount = await transaction.agentAccount.findUniqueOrThrow({
          where: { id: input.accountId },
        })
        await enqueueWebhookEvent(transaction, {
          accountId: updatedAccount.id,
          resourceType: 'ACCOUNT',
          resourceId: updatedAccount.id,
          resourceVersion: updatedAccount.rowVersion,
          eventType: 'account.updated',
          resource: {
            id: updatedAccount.id,
            name: updatedAccount.name,
            status: updatedAccount.status,
            reason: input.reason ?? null,
          },
        })
        return updatedAccount
      })
      return toAccountRecord(result)
    },

    async rotateCredential(input) {
      return prisma.$transaction(async (transaction) => {
        const oldCredential = await transaction.apiCredential.findFirst({
          where: { id: input.oldCredentialId, accountId: input.accountId },
        })
        if (oldCredential === null || oldCredential.status === 'REVOKED') {
          throw new NotFoundError('Credential was not found or already revoked')
        }
        const newCredential = await transaction.apiCredential.create({
          data: {
            id: input.newCredentialId,
            accountId: input.accountId,
            keyHash: input.keyHash,
            keyPrefix: input.keyPrefix,
            scopes: JSON.stringify([...input.scopes]),
            ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
            rotatedFromId: oldCredential.id,
          },
        })
        const revoked = await transaction.apiCredential.updateMany({
          where: {
            id: oldCredential.id,
            accountId: input.accountId,
            status: 'ACTIVE',
            revokedAt: null,
          },
          data: {
            status: 'REVOKED',
            revokedAt: new Date(),
            rowVersion: { increment: 1 },
          },
        })
        if (revoked.count !== 1) {
          throw new NotFoundError('Credential was not found or already revoked')
        }
        const revokedCredential = await transaction.apiCredential.findUniqueOrThrow({
          where: { id: oldCredential.id },
        })
        await createTimelineEvent(transaction, {
          id: createId('timeline'),
          accountId: input.accountId,
          resourceType: 'CREDENTIAL',
          resourceId: revokedCredential.id,
          eventType: 'CREDENTIAL_REVOKED',
          actorType: 'OPERATOR',
          ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
          source: 'V2_CREDENTIAL_ROTATION',
          occurredAt: revokedCredential.revokedAt ?? new Date(),
          oldStateJson: JSON.stringify({ status: oldCredential.status }),
          newStateJson: JSON.stringify({ status: revokedCredential.status }),
        })
        await enqueueWebhookEvent(transaction, {
          accountId: revokedCredential.accountId,
          resourceType: 'CREDENTIAL',
          resourceId: revokedCredential.id,
          resourceVersion: revokedCredential.rowVersion,
          eventType: 'credential.revoked',
          resource: {
            id: revokedCredential.id,
            account_id: revokedCredential.accountId,
            status: revokedCredential.status,
          },
        })
        await transaction.credentialRecoveryEnvelope.upsert({
          where: { idempotencyKey: input.recoveryIdempotencyKey },
          create: {
            idempotencyKey: input.recoveryIdempotencyKey,
            accountId: input.accountId,
            credentialId: newCredential.id,
            ciphertext: input.recoveryCiphertext,
            nonce: input.recoveryNonce,
            authTag: input.recoveryAuthTag,
            expiresAt: input.recoveryExpiresAt,
          },
          update: {},
        })
        await enqueueWebhookEvent(transaction, {
          accountId: newCredential.accountId,
          resourceType: 'CREDENTIAL',
          resourceId: newCredential.id,
          resourceVersion: newCredential.rowVersion,
          eventType: 'credential.rotated',
          resource: {
            id: newCredential.id,
            account_id: newCredential.accountId,
            status: newCredential.status,
            scopes: input.scopes,
            rotated_from_id: oldCredential.id,
          },
        })
        await createTimelineEvent(transaction, {
          id: createId('timeline'),
          accountId: input.accountId,
          resourceType: 'CREDENTIAL',
          resourceId: newCredential.id,
          eventType: 'CREDENTIAL_ROTATED',
          actorType: 'OPERATOR',
          ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
          source: 'V2_CREDENTIAL_ROTATION',
          occurredAt: newCredential.createdAt,
          newStateJson: JSON.stringify({
            status: newCredential.status,
            scopes: input.scopes,
            rotated_from_id: oldCredential.id,
          }),
        })
        return toCredentialRecord(newCredential)
      })
    },

    async revokeCredential(accountId, credentialId, actorId) {
      await prisma.$transaction(async (transaction) => {
        const result = await transaction.apiCredential.updateMany({
          where: { id: credentialId, accountId, revokedAt: null },
          data: {
            status: 'REVOKED',
            revokedAt: new Date(),
            rowVersion: { increment: 1 },
          },
        })
        if (result.count !== 1)
          throw new NotFoundError('Credential was not found or already revoked')
        const credential = await transaction.apiCredential.findUniqueOrThrow({
          where: { id: credentialId },
        })
        await createTimelineEvent(transaction, {
          id: createId('timeline'),
          accountId,
          resourceType: 'CREDENTIAL',
          resourceId: credential.id,
          eventType: 'CREDENTIAL_REVOKED',
          actorType: 'OPERATOR',
          ...(actorId === undefined ? {} : { actorId }),
          source: 'V2_CREDENTIAL_LIFECYCLE',
          occurredAt: credential.revokedAt ?? new Date(),
          oldStateJson: JSON.stringify({ status: 'ACTIVE' }),
          newStateJson: JSON.stringify({ status: credential.status }),
        })
        await enqueueWebhookEvent(transaction, {
          accountId,
          resourceType: 'CREDENTIAL',
          resourceId: credential.id,
          resourceVersion: credential.rowVersion,
          eventType: 'credential.revoked',
          resource: {
            id: credential.id,
            account_id: credential.accountId,
            status: credential.status,
          },
        })
      })
    },

    async listSpendPolicies(accountId) {
      const policies = await prisma.spendPolicy.findMany({
        where: { accountId },
        orderBy: [{ version: 'desc' }],
      })
      return policies.map(toSpendPolicyAdminRecord)
    },

    async createSpendPolicy(input) {
      const policy = await prisma.$transaction(async (transaction) => {
        await lockAgentAccount(transaction, input.accountId)
        const latest = await transaction.spendPolicy.findFirst({
          where: { accountId: input.accountId },
          orderBy: { version: 'desc' },
          select: { version: true },
        })
        const created = await transaction.spendPolicy.create({
          data: {
            id: input.id,
            accountId: input.accountId,
            version: (latest?.version ?? 0) + 1,
            denominationId: input.denominationId,
            maxPerPaymentAtomic: input.maxPerPaymentAtomic,
            rollingBudgetAtomic: input.rollingBudgetAtomic,
            rollingWindowSeconds: input.rollingWindowSeconds,
            transactionCountCap: input.transactionCountCap,
            approvalThresholdAtomic: input.approvalThresholdAtomic,
            rollingBudgetEscalatable: input.rollingBudgetEscalatable,
            transactionCountEscalatable: input.transactionCountEscalatable,
            rulesJson: input.rulesJson,
          },
        })
        await createTimelineEvent(transaction, {
          id: createId('timeline'),
          accountId: created.accountId,
          resourceType: 'SPEND_POLICY',
          resourceId: created.id,
          eventType: 'SPEND_POLICY_CREATED',
          actorType: 'OPERATOR',
          ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
          source: 'V2_POLICY_ADMIN',
          occurredAt: created.createdAt,
          newStateJson: JSON.stringify({
            version: created.version,
            status: created.status,
            denomination_id: created.denominationId,
          }),
        })
        await enqueueWebhookEvent(transaction, {
          accountId: created.accountId,
          resourceType: 'SPEND_POLICY',
          resourceId: created.id,
          resourceVersion: created.version,
          eventType: 'policy.created',
          resource: {
            id: created.id,
            account_id: created.accountId,
            version: created.version,
            status: created.status,
            denomination_id: created.denominationId,
          },
        })
        return created
      })
      return toSpendPolicyAdminRecord(policy)
    },

    async replaceSpendPolicy(input) {
      const now = new Date()
      const policy = await prisma.$transaction(async (transaction) => {
        await lockAgentAccount(transaction, input.accountId)
        const active = await transaction.spendPolicy.findFirst({
          where: { accountId: input.accountId, status: 'ACTIVE' },
          orderBy: { version: 'desc' },
          select: { id: true, version: true },
        })
        if (active !== null && input.expectedVersion === undefined) {
          throw new ConflictError('Spend policy version is required for replacement')
        }
        if (
          input.expectedVersion !== undefined &&
          (active?.version ?? 0) !== input.expectedVersion
        ) {
          throw new ConflictError('Spend policy version changed concurrently')
        }
        const latest = await transaction.spendPolicy.findFirst({
          where: { accountId: input.accountId },
          orderBy: { version: 'desc' },
          select: { version: true },
        })
        await transaction.spendPolicy.updateMany({
          where: { accountId: input.accountId, status: 'ACTIVE' },
          data: { status: 'RETIRED', retiredAt: now },
        })
        const created = await transaction.spendPolicy.create({
          data: {
            id: input.id,
            accountId: input.accountId,
            version: (latest?.version ?? 0) + 1,
            status: 'ACTIVE',
            denominationId: input.denominationId,
            maxPerPaymentAtomic: input.maxPerPaymentAtomic,
            rollingBudgetAtomic: input.rollingBudgetAtomic,
            rollingWindowSeconds: input.rollingWindowSeconds,
            transactionCountCap: input.transactionCountCap,
            approvalThresholdAtomic: input.approvalThresholdAtomic,
            rollingBudgetEscalatable: input.rollingBudgetEscalatable,
            transactionCountEscalatable: input.transactionCountEscalatable,
            rulesJson: input.rulesJson,
            activatedAt: now,
          },
        })
        await transaction.operationTimelineEvent.create({
          data: {
            id: createId('timeline'),
            accountId: input.accountId,
            resourceType: 'SPEND_POLICY',
            resourceId: created.id,
            eventType: 'SPEND_POLICY_REPLACED',
            actorType: 'OPERATOR',
            actorId: input.actorId,
            source: 'V2_POLICY_ADMIN',
            occurredAt: now,
            newStateJson: JSON.stringify({
              version: created.version,
              previous_version: active?.version ?? null,
            }),
          },
        })
        await enqueueWebhookEvent(transaction, {
          accountId: created.accountId,
          resourceType: 'SPEND_POLICY',
          resourceId: created.id,
          resourceVersion: created.version,
          eventType: 'policy.updated',
          resource: {
            id: created.id,
            account_id: created.accountId,
            version: created.version,
            status: created.status,
            denomination_id: created.denominationId,
            previous_version: active?.version ?? null,
          },
        })
        return created
      })
      return toSpendPolicyAdminRecord(policy)
    },

    async activateSpendPolicy(accountId, policyId, rowVersion, actorId) {
      return prisma.$transaction(async (transaction) => {
        await lockAgentAccount(transaction, accountId)
        const policy = await transaction.spendPolicy.findFirst({
          where: { id: policyId, accountId },
        })
        if (policy === null) throw new NotFoundError('Spend policy was not found')
        if (policy.status !== 'DRAFT')
          throw new ConflictError('Only a DRAFT policy can be activated')
        if (rowVersion !== undefined && policy.version !== rowVersion) {
          throw new ConflictError('Spend policy version changed concurrently')
        }
        await transaction.spendPolicy.updateMany({
          where: { accountId, status: 'ACTIVE' },
          data: { status: 'RETIRED', retiredAt: new Date() },
        })
        const activated = await transaction.spendPolicy.update({
          where: { id: policyId },
          data: { status: 'ACTIVE', activatedAt: new Date() },
        })
        await transaction.operationTimelineEvent.create({
          data: {
            id: createId('timeline'),
            accountId,
            resourceType: 'SPEND_POLICY',
            resourceId: policyId,
            eventType: 'SPEND_POLICY_ACTIVATED',
            actorType: 'OPERATOR',
            actorId: actorId ?? accountId,
            source: 'V2_POLICY_ADMIN',
            occurredAt: new Date(),
            newStateJson: JSON.stringify({ version: activated.version }),
          },
        })
        await enqueueWebhookEvent(transaction, {
          accountId: activated.accountId,
          resourceType: 'SPEND_POLICY',
          resourceId: activated.id,
          resourceVersion: activated.version,
          eventType: 'policy.activated',
          resource: {
            id: activated.id,
            account_id: activated.accountId,
            version: activated.version,
            status: activated.status,
            denomination_id: activated.denominationId,
          },
        })
        return toSpendPolicyAdminRecord(activated)
      })
    },

    async listApprovals(accountId) {
      const approvals = await prisma.approval.findMany({
        where: { accountId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      })
      return approvals.map(toApprovalAdminRecord)
    },

    async decideApproval(input) {
      return prisma.$transaction(async (transaction) => {
        await lockAgentAccount(transaction, input.accountId)
        const approval = await transaction.approval.findFirst({
          where: { id: input.approvalId, accountId: input.accountId },
        })
        if (approval === null) throw new NotFoundError('Approval was not found')
        if (approval.rowVersion !== input.rowVersion) {
          throw new ConflictError('Approval changed concurrently')
        }
        if (approval.status !== 'PENDING') {
          throw new ConflictError('Approval is already terminal')
        }
        const now = input.now ?? new Date()
        const payment = await transaction.payment.findFirst({
          where: { id: approval.paymentId, payerAccountId: input.accountId },
        })
        if (payment === null) throw new NotFoundError('Approval payment was not found')
        const nextStatus =
          input.action === 'APPROVE'
            ? 'APPROVED'
            : input.action === 'EXPIRE'
              ? 'EXPIRED'
              : 'REJECTED'
        if (input.action === 'APPROVE') {
          if (approval.expiresAt <= now) throw new ConflictError('Approval has expired')
          if (payment.status !== 'AWAITING_APPROVAL') {
            throw new ConflictError('Payment is no longer awaiting approval')
          }
          if (
            payment.intentFingerprint === null ||
            approval.fingerprint !== payment.intentFingerprint
          ) {
            throw new ConflictError('Approval intent no longer matches the payment')
          }
          const account = await transaction.agentAccount.findUniqueOrThrow({
            where: { id: input.accountId },
            select: { status: true },
          })
          if (account.status !== 'ACTIVE')
            throw new InvalidStateError('Agent account is not active')
          const reserved = await transaction.outgoingReservation.aggregate({
            where: {
              ownerAccountId: input.accountId,
              status: 'ACTIVE',
              lifecycleState: 'HELD',
              ...(payment.denominationId === null
                ? { currency: payment.currency }
                : { payment: { denominationId: payment.denominationId } }),
            },
            _sum: { amountAtomic: true },
          })
          const available =
            (input.settledAtomic ?? 0n) - (reserved._sum.amountAtomic ?? 0n)
          if (payment.amountAtomic > available) throw new InsufficientFundsError()
          const reservation = await transaction.outgoingReservation.create({
            data: {
              id: createId('resv'),
              paymentId: payment.id,
              ownerAccountId: input.accountId,
              amountAtomic: payment.amountAtomic,
              currency: payment.currency,
              lifecycleState: 'HELD',
            },
          })
          const attempt = await transaction.paymentAttempt.create({
            data: {
              id: createId('attempt'),
              paymentId: payment.id,
              attemptNumber: 1,
              rail: payment.route ?? 'UNSELECTED',
              routeId: payment.routeId,
              status: 'CREATED',
              outcome: 'NOT_STARTED',
            },
          })
          await createTimelineEvent(transaction, {
            id: createId('timeline'),
            accountId: input.accountId,
            resourceType: 'RESERVATION',
            resourceId: reservation.id,
            eventType: 'RESERVATION_HELD',
            actorType: 'OPERATOR',
            actorId: input.actorId,
            correlationId: payment.correlationId ?? undefined,
            source: 'V2_APPROVAL_ADMIN',
            occurredAt: reservation.createdAt,
            newStateJson: JSON.stringify({
              payment_id: payment.id,
              amount_atomic: reservation.amountAtomic.toString(),
              currency: reservation.currency,
              lifecycle_state: reservation.lifecycleState,
            }),
          })
          if (payment.routeId !== null) {
            await createTimelineEvent(transaction, {
              id: createId('timeline'),
              accountId: input.accountId,
              resourceType: 'SETTLEMENT_ROUTE',
              resourceId: payment.routeId,
              eventType: 'ROUTE_SELECTED',
              actorType: 'OPERATOR',
              actorId: input.actorId,
              correlationId: payment.correlationId ?? undefined,
              source: 'V2_APPROVAL_ADMIN',
              occurredAt: payment.updatedAt,
              newStateJson: JSON.stringify({
                payment_id: payment.id,
                route_id: payment.routeId,
                rail: payment.route,
                selection_reason: payment.routeSelectionReason,
              }),
            })
          }
          await createTimelineEvent(transaction, {
            id: createId('timeline'),
            accountId: input.accountId,
            resourceType: 'PAYMENT_ATTEMPT',
            resourceId: attempt.id,
            eventType: 'ATTEMPT_CREATED',
            actorType: 'OPERATOR',
            actorId: input.actorId,
            correlationId: payment.correlationId ?? undefined,
            source: 'V2_APPROVAL_ADMIN',
            occurredAt: attempt.createdAt,
            newStateJson: JSON.stringify({
              payment_id: payment.id,
              attempt_number: attempt.attemptNumber,
              route_id: attempt.routeId,
              outcome: attempt.outcome,
            }),
          })
          await transaction.durableWorkItem.create({
            data: {
              id: createId('work'),
              kind: 'OUTGOING_PAYMENT',
              resourceType: 'PAYMENT',
              resourceId: payment.id,
              payloadJson: JSON.stringify({ payment_id: payment.id }),
            },
          })
          await transaction.payment.update({
            where: { id: payment.id },
            data: {
              status: 'ROUTING',
              executionState: 'QUEUED',
              rowVersion: { increment: 1 },
            },
          })
        } else {
          await transaction.payment.update({
            where: { id: payment.id },
            data: {
              status: nextStatus === 'EXPIRED' ? 'EXPIRED' : 'REJECTED',
              executionState: 'TERMINAL',
              outcomeState: 'PROVED_NO_EFFECT',
              settlementState: 'NOT_SUBMITTED',
              rowVersion: { increment: 1 },
            },
          })
        }
        const updated = await transaction.approval.update({
          where: { id: approval.id },
          data: {
            status: nextStatus,
            actorId: input.actorId,
            comment: input.comment ?? null,
            decidedAt: now,
            rowVersion: { increment: 1 },
          },
        })
        await transaction.operationTimelineEvent.create({
          data: {
            id: createId('timeline'),
            accountId: input.accountId,
            resourceType: 'APPROVAL',
            resourceId: approval.id,
            eventType: `APPROVAL_${input.action}`,
            actorType: 'OPERATOR',
            actorId: input.actorId,
            source: 'V2_APPROVAL_ADMIN',
            occurredAt: now,
            newStateJson: JSON.stringify({
              status: nextStatus,
              payment_id: payment.id,
            }),
          },
        })
        const updatedPayment = await transaction.payment.findUniqueOrThrow({
          where: { id: payment.id },
        })
        await enqueueWebhookEvent(transaction, {
          accountId: input.accountId,
          resourceType: 'APPROVAL',
          resourceId: updated.id,
          resourceVersion: updated.rowVersion,
          eventType: 'approval.updated',
          resource: {
            id: updated.id,
            payment_id: updated.paymentId,
            account_id: updated.accountId,
            status: updated.status,
            actor_id: updated.actorId,
          },
        })
        await enqueueWebhookEvent(transaction, {
          accountId: updatedPayment.payerAccountId,
          resourceType: 'PAYMENT',
          resourceId: updatedPayment.id,
          resourceVersion: updatedPayment.rowVersion,
          eventType: 'payment.updated',
          resource: {
            id: updatedPayment.id,
            status: updatedPayment.status,
            amount_atomic: updatedPayment.amountAtomic.toString(),
            denomination_id: updatedPayment.denominationId,
          },
        })
        return toApprovalAdminRecord(updated)
      })
    },

    async listApprovedDestinations(accountId) {
      const destinations = await prisma.approvedDestination.findMany({
        where: { accountId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      })
      return destinations.map(toApprovedDestinationRecord)
    },

    async createApprovedDestination(input) {
      const destination = await prisma.$transaction(async (transaction) => {
        await lockAgentAccount(transaction, input.accountId)
        const created = await transaction.approvedDestination.create({
          data: {
            id: input.id,
            accountId: input.accountId,
            fingerprint: input.fingerprint,
            rail: input.rail,
            network: input.network,
            assetReference: input.assetReference,
            destination: input.destination,
            actorId: input.actorId,
            ...(input.reason === undefined ? {} : { reason: input.reason }),
          },
        })
        await createTimelineEvent(transaction, {
          id: createId('timeline'),
          accountId: created.accountId,
          resourceType: 'APPROVED_DESTINATION',
          resourceId: created.id,
          eventType: 'APPROVED_DESTINATION_CREATED',
          actorType: 'OPERATOR',
          actorId: created.actorId,
          source: 'V2_DESTINATION_ADMIN',
          occurredAt: created.createdAt,
          newStateJson: JSON.stringify({
            fingerprint: created.fingerprint,
            rail: created.rail,
            network: created.network,
            asset_reference: created.assetReference,
            status: created.status,
          }),
        })
        await enqueueWebhookEvent(transaction, {
          accountId: created.accountId,
          resourceType: 'APPROVED_DESTINATION',
          resourceId: created.id,
          resourceVersion: 1,
          eventType: 'destination.created',
          resource: {
            id: created.id,
            account_id: created.accountId,
            fingerprint: created.fingerprint,
            rail: created.rail,
            network: created.network,
            asset_reference: created.assetReference,
            destination: created.destination,
            status: created.status,
          },
        })
        return created
      })
      return toApprovedDestinationRecord(destination)
    },

    async revokeApprovedDestination(input) {
      await prisma.$transaction(async (transaction) => {
        await lockAgentAccount(transaction, input.accountId)
        const result = await transaction.approvedDestination.updateMany({
          where: { id: input.id, accountId: input.accountId, status: 'ACTIVE' },
          data: { status: 'REVOKED', revokedAt: new Date(), reason: input.reason },
        })
        if (result.count !== 1)
          throw new NotFoundError('Approved destination was not found')
        const destination = await transaction.approvedDestination.findUniqueOrThrow({
          where: { id: input.id },
        })
        await createTimelineEvent(transaction, {
          id: createId('timeline'),
          accountId: destination.accountId,
          resourceType: 'APPROVED_DESTINATION',
          resourceId: destination.id,
          eventType: 'APPROVED_DESTINATION_REVOKED',
          actorType: 'OPERATOR',
          actorId: input.actorId,
          source: 'V2_DESTINATION_ADMIN',
          occurredAt: destination.revokedAt ?? new Date(),
          oldStateJson: JSON.stringify({ status: 'ACTIVE' }),
          newStateJson: JSON.stringify({
            status: destination.status,
            reason: destination.reason,
          }),
        })
        await enqueueWebhookEvent(transaction, {
          accountId: destination.accountId,
          resourceType: 'APPROVED_DESTINATION',
          resourceId: destination.id,
          resourceVersion: 2,
          eventType: 'destination.revoked',
          resource: {
            id: destination.id,
            account_id: destination.accountId,
            fingerprint: destination.fingerprint,
            rail: destination.rail,
            network: destination.network,
            asset_reference: destination.assetReference,
            destination: destination.destination,
            status: destination.status,
            reason: destination.reason,
          },
        })
      })
    },

    async findFundingDestination(accountId, routeId) {
      const destination = await prisma.fundingDestination.findFirst({
        where: { accountId, ...(routeId === undefined ? {} : { routeId }) },
        orderBy: { updatedAt: 'desc' },
      })
      return destination === null ? null : toFundingDestinationRecord(destination)
    },

    async upsertFundingDestination(input) {
      const destination = await prisma.fundingDestination.upsert({
        where: {
          accountId_routeId_assetId: {
            accountId: input.accountId,
            routeId: input.routeId,
            assetId: input.assetId,
          },
        },
        create: {
          id: input.id,
          accountId: input.accountId,
          routeId: input.routeId,
          network: input.network,
          assetId: input.assetId,
          destination: input.destination,
          readiness: input.readiness,
          senderConstraintsJson: input.senderConstraintsJson,
          ...(input.lastValidatedAt === undefined
            ? {}
            : { lastValidatedAt: input.lastValidatedAt }),
          ...(input.lastFailureCode === undefined
            ? {}
            : { lastFailureCode: input.lastFailureCode }),
        },
        update: {
          network: input.network,
          destination: input.destination,
          readiness: input.readiness,
          senderConstraintsJson: input.senderConstraintsJson,
          ...(input.lastValidatedAt === undefined
            ? {}
            : { lastValidatedAt: input.lastValidatedAt }),
          ...(input.lastFailureCode === undefined
            ? {}
            : { lastFailureCode: input.lastFailureCode }),
        },
      })
      return toFundingDestinationRecord(destination)
    },

    async listHistory(input) {
      const [payments, incoming] = await Promise.all([
        prisma.payment.findMany({
          where: {
            payerAccountId: input.accountId,
            ...(input.cursor === undefined
              ? {}
              : {
                  OR: [
                    { createdAt: { lt: input.cursor.occurredAt } },
                    { createdAt: input.cursor.occurredAt, id: { lt: input.cursor.id } },
                  ],
                }),
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: input.limit,
          include: {
            attempts: {
              select: { railTransactionId: true },
              orderBy: { attemptNumber: 'desc' },
              take: 1,
            },
          },
        }),
        prisma.incomingPayment.findMany({
          where: {
            accountId: input.accountId,
            ...(input.cursor === undefined
              ? {}
              : {
                  OR: [
                    { confirmedAt: { lt: input.cursor.occurredAt } },
                    {
                      confirmedAt: input.cursor.occurredAt,
                      id: { lt: input.cursor.id },
                    },
                  ],
                }),
          },
          orderBy: [{ confirmedAt: 'desc' }, { id: 'desc' }],
          take: input.limit,
        }),
      ])
      return [
        ...payments.map((payment) => ({
          id: payment.id,
          direction: 'OUTGOING' as const,
          kind: payment.kind,
          status: payment.status,
          amountAtomic: payment.amountAtomic,
          denominationId: payment.denominationId,
          currency: payment.currency,
          recipientId: payment.recipientId,
          externalId: payment.attempts[0]?.railTransactionId ?? null,
          occurredAt: payment.createdAt,
        })),
        ...incoming.map((payment) => ({
          id: payment.id,
          direction: 'INCOMING' as const,
          kind: 'RECEIVE',
          status: payment.status,
          amountAtomic: payment.amountAtomic,
          denominationId: null,
          currency: payment.currency,
          recipientId: null,
          externalId: payment.signature,
          occurredAt: payment.confirmedAt,
        })),
      ]
        .sort((left, right) => {
          const time = right.occurredAt.getTime() - left.occurredAt.getTime()
          return time === 0 ? right.id.localeCompare(left.id) : time
        })
        .slice(0, input.limit)
    },

    async createCustodyKeyVersion(input) {
      const key = await prisma.$transaction(async (transaction) => {
        const created = await transaction.custodyKeyVersion.create({
          data: {
            id: input.id,
            accountId: input.accountId ?? null,
            keyVersion: input.keyVersion,
            backendIdentity: input.backendIdentity,
            keyReference: input.keyReference,
            rootKeyFingerprint: input.rootKeyFingerprint,
          },
        })
        await createTimelineEvent(transaction, {
          id: createId('timeline'),
          ...(created.accountId === null ? {} : { accountId: created.accountId }),
          resourceType: 'CUSTODY_KEY_VERSION',
          resourceId: created.id,
          eventType: 'CUSTODY_KEY_VERSION_CREATED',
          actorType: 'SYSTEM',
          source: 'V2_CUSTODY_CONTROL_PLANE',
          occurredAt: created.createdAt,
          newStateJson: JSON.stringify({
            key_version: created.keyVersion,
            status: created.status,
            backend_identity: created.backendIdentity,
            root_key_fingerprint: created.rootKeyFingerprint,
          }),
        })
        return created
      })
      return toCustodyKeyVersionRecord(key)
    },

    async findActiveCustodyKeyVersion(accountId) {
      const key = await prisma.custodyKeyVersion.findFirst({
        where: { accountId, status: 'ACTIVE' },
        orderBy: { keyVersion: 'desc' },
      })
      return key === null ? null : toCustodyKeyVersionRecord(key)
    },

    async createSigningRequest(input) {
      const request = await prisma.$transaction(async (transaction) => {
        const created = await transaction.signingRequest.create({
          data: {
            id: input.id,
            paymentId: input.paymentId,
            attemptId: input.attemptId,
            effectHash: input.effectHash,
            routeId: input.routeId,
            network: input.network,
            assetReference: input.assetReference,
            destination: input.destination,
            amountAtomic: input.amountAtomic,
            feePayerIdentity: input.feePayerIdentity,
            keyVersion: input.keyVersion,
            serviceIdentity: input.serviceIdentity,
          },
        })
        const payment = await transaction.payment.findUniqueOrThrow({
          where: { id: created.paymentId },
          select: { payerAccountId: true, correlationId: true },
        })
        await createTimelineEvent(transaction, {
          id: createId('timeline'),
          accountId: payment.payerAccountId,
          resourceType: 'SIGNING_REQUEST',
          resourceId: created.id,
          eventType: 'SIGNING_REQUEST_CREATED',
          actorType: 'SERVICE',
          actorId: created.serviceIdentity,
          correlationId: payment.correlationId ?? undefined,
          source: 'V2_CUSTODY_CONTROL_PLANE',
          occurredAt: created.createdAt,
          newStateJson: JSON.stringify({
            payment_id: created.paymentId,
            attempt_id: created.attemptId,
            effect_hash: created.effectHash,
            route_id: created.routeId,
            network: created.network,
            asset_reference: created.assetReference,
            amount_atomic: created.amountAtomic.toString(),
            key_version: created.keyVersion,
            status: created.status,
          }),
        })
        return created
      })
      return toSigningRequestRecord(request)
    },

    async findSigningRequest(attemptId) {
      const request = await prisma.signingRequest.findUnique({ where: { attemptId } })
      return request === null ? null : toSigningRequestRecord(request)
    },

    async completeSigningRequest(id, effectHash, status) {
      const request = await prisma.$transaction(async (transaction) => {
        const result = await transaction.signingRequest.updateMany({
          where: { id, effectHash, status: 'PENDING' },
          data: { status, completedAt: new Date() },
        })
        if (result.count !== 1)
          throw new ConflictError('Signing request changed concurrently')
        const updated = await transaction.signingRequest.findUniqueOrThrow({
          where: { id },
        })
        const payment = await transaction.payment.findUniqueOrThrow({
          where: { id: updated.paymentId },
          select: { payerAccountId: true, correlationId: true },
        })
        await createTimelineEvent(transaction, {
          id: createId('timeline'),
          accountId: payment.payerAccountId,
          resourceType: 'SIGNING_REQUEST',
          resourceId: updated.id,
          eventType: 'SIGNING_REQUEST_COMPLETED',
          actorType: 'SERVICE',
          actorId: updated.serviceIdentity,
          correlationId: payment.correlationId ?? undefined,
          source: 'V2_CUSTODY_CONTROL_PLANE',
          occurredAt: updated.completedAt ?? new Date(),
          oldStateJson: JSON.stringify({ status: 'PENDING' }),
          newStateJson: JSON.stringify({
            status: updated.status,
            effect_hash: updated.effectHash,
          }),
        })
        return updated
      })
      return toSigningRequestRecord(request)
    },

    async consumeRateLimit(input) {
      if (!Number.isInteger(input.windowSeconds) || input.windowSeconds <= 0) {
        throw new InvalidStateError('Rate limit window must be positive')
      }
      if (!Number.isInteger(input.limit) || input.limit <= 0) {
        throw new InvalidStateError('Rate limit must be positive')
      }
      const now = input.now ?? new Date()
      const windowStart = new Date(
        Math.floor(now.getTime() / (input.windowSeconds * 1000)) *
          input.windowSeconds *
          1000,
      )
      const retryAt = new Date(windowStart.getTime() + input.windowSeconds * 1000)
      const bucketId = `${input.subjectType}:${input.subjectId}:${input.bucket}:${windowStart.toISOString()}`
      const result = await prisma.$transaction(async (transaction) => {
        await transaction.rateLimitBucket.upsert({
          where: {
            subjectType_subjectId_bucket_windowStartedAt: {
              subjectType: input.subjectType,
              subjectId: input.subjectId,
              bucket: input.bucket,
              windowStartedAt: windowStart,
            },
          },
          create: {
            id: bucketId,
            subjectType: input.subjectType,
            subjectId: input.subjectId,
            bucket: input.bucket,
            windowStartedAt: windowStart,
            requestCount: 0,
          },
          update: {},
        })
        return transaction.rateLimitBucket.update({
          where: { id: bucketId },
          data: { requestCount: { increment: 1 } },
        })
      })
      return {
        allowed: result.requestCount <= input.limit,
        count: result.requestCount,
        retryAt,
      }
    },
  }
}

async function lockAgentAccount(
  transaction: Prisma.TransactionClient,
  accountId: string,
): Promise<void> {
  const rows = await transaction.$queryRaw<Array<{ id: string }>>`
    SELECT id
    FROM "agent_accounts"
    WHERE id = ${accountId}
    FOR UPDATE
  `
  if (rows[0] === undefined) throw new NotFoundError('Agent account was not found')
}

function createId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString('hex')}`
}

function toAccountRecord(account: {
  id: string
  name: string
  status: AgentAccountLifecycleStatus
  solanaPublicKey: string
  workspaceId: string | null
  runtimeVersion: string | null
  provisioningFailureCode: string | null
  disabledAt: Date | null
  disabledReason: string | null
  rowVersion: number
  createdAt: Date
  updatedAt: Date
}): V2AccountRecord {
  return account as V2AccountRecord
}

function parseScopes(value: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed) || parsed.some((scope) => typeof scope !== 'string')) {
      throw new Error('invalid scopes')
    }
    return parsed
  } catch {
    throw new InvalidStateError('Credential scopes are corrupt')
  }
}

function toCredentialRecord(credential: {
  id: string
  accountId: string
  keyPrefix: string
  status: string
  scopes: string
  expiresAt: Date | null
  rotatedFromId: string | null
  rowVersion: number
  createdAt: Date
  revokedAt: Date | null
}): V2CredentialRecord {
  return {
    ...credential,
    scopes: parseScopes(credential.scopes),
  }
}

function toRecoveryEnvelope(envelope: {
  idempotencyKey: string
  accountId: string
  credentialId: string
  ciphertext: string
  nonce: string
  authTag: string
  expiresAt: Date
}): V2ProvisionedAccount['recoveryEnvelope'] {
  return envelope
}

function toSpendPolicyAdminRecord(policy: {
  id: string
  accountId: string
  version: number
  status: string
  denominationId: string
  maxPerPaymentAtomic: bigint | null
  rollingBudgetAtomic: bigint | null
  rollingWindowSeconds: number | null
  transactionCountCap: number | null
  approvalThresholdAtomic: bigint | null
  rollingBudgetEscalatable: boolean
  transactionCountEscalatable: boolean
  rulesJson: string
  createdAt: Date
  activatedAt: Date | null
  retiredAt: Date | null
}): V2SpendPolicyAdminRecord {
  return policy
}

function toApprovalAdminRecord(approval: {
  id: string
  paymentId: string
  accountId: string
  fingerprint: string
  policyDecisionId: string
  status: string
  expiresAt: Date
  actorId: string | null
  comment: string | null
  rowVersion: number
  createdAt: Date
  decidedAt: Date | null
}): V2ApprovalAdminRecord {
  return approval
}

function toApprovedDestinationRecord(destination: {
  id: string
  accountId: string
  fingerprint: string
  rail: string
  network: string
  assetReference: string
  destination: string
  status: string
  actorId: string
  reason: string | null
  createdAt: Date
  revokedAt: Date | null
}): V2ApprovedDestinationRecord {
  return destination
}

function toFundingDestinationRecord(destination: {
  id: string
  accountId: string
  routeId: string
  network: string
  assetId: string
  destination: string
  readiness: string
  senderConstraintsJson: string
  lastValidatedAt: Date | null
  lastFailureCode: string | null
}): V2FundingDestinationRecord {
  return destination
}

function toReceiveRequestAdminRecord(request: {
  id: string
  accountId: string
  amountAtomic: bigint | null
  denominationId: string | null
  amountScale: number | null
  currency: string
  reference: string
  status: 'OPEN' | 'PAID' | 'EXPIRED' | 'CANCELLED'
  createdAt: Date
  updatedAt: Date
  expiresAt: Date | null
  paidAt: Date | null
  matchedIncomingPaymentId: string | null
}): V2ReceiveRequestAdminRecord {
  return request
}

function toCustodyKeyVersionRecord(key: {
  id: string
  accountId: string | null
  keyVersion: number
  backendIdentity: string
  keyReference: string
  rootKeyFingerprint: string
  status: string
}): V2CustodyKeyVersionRecord {
  return key
}

function toSigningRequestRecord(request: {
  id: string
  paymentId: string
  attemptId: string
  effectHash: string
  routeId: string
  network: string
  assetReference: string
  destination: string
  amountAtomic: bigint
  feePayerIdentity: string
  keyVersion: number
  status: string
  serviceIdentity: string
  createdAt: Date
  completedAt: Date | null
}): V2SigningRequestRecord {
  return request
}
