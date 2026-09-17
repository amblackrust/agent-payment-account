import { randomBytes } from 'node:crypto'
import {
  assertAgentAccountTransition,
  ConflictError,
  IdempotencyConflictError,
  InsufficientFundsError,
  InvalidStateError,
  NotFoundError,
  type AgentAccountLifecycleStatus,
} from '@agent-payment/core'
import type { PrismaClient } from './generated/client/client.js'

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
  findProvisioningReplay(
    idempotencyKey: string,
  ): Promise<{ readonly accountId: string; readonly credentialId: string } | null>
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
  consumeRecoveryEnvelope(
    accountId: string,
    idempotencyKey: string,
    now?: Date,
  ): Promise<V2ProvisionedAccount['recoveryEnvelope'] | null>
  findAccount(accountId: string): Promise<V2AccountRecord | null>
  listCredentials(accountId: string): Promise<readonly V2CredentialRecord[]>
  transitionAccount(input: {
    readonly accountId: string
    readonly currentStatus: AgentAccountLifecycleStatus
    readonly nextStatus: AgentAccountLifecycleStatus
    readonly rowVersion: number
    readonly reason?: string
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
  }): Promise<V2CredentialRecord>
  revokeCredential(accountId: string, credentialId: string): Promise<void>
  listSpendPolicies(
    accountId: string,
  ): Promise<readonly V2SpendPolicyAdminRecord[]>
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
  }): Promise<V2SpendPolicyAdminRecord>
  activateSpendPolicy(
    accountId: string,
    policyId: string,
    rowVersion?: number,
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
  findActiveCustodyKeyVersion(accountId: string): Promise<V2CustodyKeyVersionRecord | null>
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
  }): Promise<{ readonly allowed: boolean; readonly count: number; readonly retryAt: Date }>
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
        const existing = await transaction.idempotencyRecord.findUnique({
          where: {
            ownerAccountId_operation_key: {
              ownerAccountId: input.accountId,
              operation: 'ACCOUNT_PROVISION',
              key: input.idempotencyKey,
            },
          },
        })
        if (existing !== null) {
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
            status: 'ACTIVE',
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
        if (input.receiveRequestId !== undefined && input.receiveReference !== undefined) {
          await transaction.receiveRequest.create({
            data: {
              id: input.receiveRequestId,
              accountId: input.accountId,
              currency: 'USD',
              reference: input.receiveReference,
            },
          })
        }
        await transaction.idempotencyRecord.create({
          data: {
            id: createId('idem'),
            ownerAccountId: input.accountId,
            operation: 'ACCOUNT_PROVISION',
            key: input.idempotencyKey,
            requestHash: input.idempotencyKey.padEnd(64, '0').slice(0, 64),
            fingerprint: input.idempotencyKey.padEnd(64, '0').slice(0, 64),
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

    async findProvisioningReplay(idempotencyKey) {
      const record = await prisma.idempotencyRecord.findFirst({
        where: { operation: 'ACCOUNT_PROVISION', key: idempotencyKey },
        select: { resourceId: true, responseSnapshot: true },
      })
      if (record === null || record.responseSnapshot === null) return null
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
            ...(input.amountAtomic === undefined ? {} : { amountAtomic: input.amountAtomic }),
            ...(input.denominationId === undefined ? {} : { denominationId: input.denominationId }),
            ...(input.amountScale === undefined ? {} : { amountScale: input.amountScale }),
            currency: input.currency,
            reference: input.reference,
            createdAt: input.createdAt,
            ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
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
        return deleted.count === 1 ? toRecoveryEnvelope(envelope) : null
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
        const current = await transaction.agentAccount.findUnique({
          where: { id: input.accountId },
        })
        if (current === null) throw new NotFoundError('Agent account was not found')
        if (current.status !== input.currentStatus || current.rowVersion !== input.rowVersion) {
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
                ? { disabledAt: null, disabledReason: null, provisioningFailureCode: null }
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
            actorId: input.accountId,
            source: 'V2_ACCOUNT_LIFECYCLE',
            occurredAt: new Date(),
            oldStateJson: JSON.stringify({ status: input.currentStatus }),
            newStateJson: JSON.stringify({
              status: input.nextStatus,
              reason: input.reason ?? null,
            }),
          },
        })
        return transaction.agentAccount.findUniqueOrThrow({
          where: { id: input.accountId },
        })
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
        await transaction.apiCredential.update({
          where: { id: oldCredential.id },
          data: {
            status: 'REVOKED',
            revokedAt: new Date(),
            rowVersion: { increment: 1 },
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
        return toCredentialRecord(newCredential)
      })
    },

    async revokeCredential(accountId, credentialId) {
      const result = await prisma.apiCredential.updateMany({
        where: { id: credentialId, accountId, revokedAt: null },
        data: { status: 'REVOKED', revokedAt: new Date(), rowVersion: { increment: 1 } },
      })
      if (result.count !== 1) throw new NotFoundError('Credential was not found or already revoked')
    },

    async listSpendPolicies(accountId) {
      const policies = await prisma.spendPolicy.findMany({
        where: { accountId },
        orderBy: [{ version: 'desc' }],
      })
      return policies.map(toSpendPolicyAdminRecord)
    },

    async createSpendPolicy(input) {
      const latest = await prisma.spendPolicy.findFirst({
        where: { accountId: input.accountId },
        orderBy: { version: 'desc' },
        select: { version: true },
      })
      const policy = await prisma.spendPolicy.create({
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
      return toSpendPolicyAdminRecord(policy)
    },

    async activateSpendPolicy(accountId, policyId, rowVersion) {
      return prisma.$transaction(async (transaction) => {
        const policy = await transaction.spendPolicy.findFirst({
          where: { id: policyId, accountId },
        })
        if (policy === null) throw new NotFoundError('Spend policy was not found')
        if (policy.status !== 'DRAFT') throw new ConflictError('Only a DRAFT policy can be activated')
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
            actorId: accountId,
            source: 'V2_POLICY_ADMIN',
            occurredAt: new Date(),
            newStateJson: JSON.stringify({ version: activated.version }),
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
        const nextStatus = input.action === 'APPROVE' ? 'APPROVED' : input.action
        if (input.action === 'APPROVE') {
          if (approval.expiresAt <= now) throw new ConflictError('Approval has expired')
          if (payment.status !== 'AWAITING_APPROVAL') {
            throw new ConflictError('Payment is no longer awaiting approval')
          }
          const account = await transaction.agentAccount.findUniqueOrThrow({
            where: { id: input.accountId },
            select: { status: true },
          })
          if (account.status !== 'ACTIVE') throw new InvalidStateError('Agent account is not active')
          const reserved = await transaction.outgoingReservation.aggregate({
            where: { ownerAccountId: input.accountId, status: 'ACTIVE' },
            _sum: { amountAtomic: true },
          })
          const available = (input.settledAtomic ?? 0n) - (reserved._sum.amountAtomic ?? 0n)
          if (payment.amountAtomic > available) throw new InsufficientFundsError()
          await transaction.outgoingReservation.create({
            data: {
              id: createId('resv'),
              paymentId: payment.id,
              ownerAccountId: input.accountId,
              amountAtomic: payment.amountAtomic,
              currency: payment.currency,
              lifecycleState: 'HELD',
            },
          })
          await transaction.paymentAttempt.create({
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
            data: { status: 'ROUTING', executionState: 'QUEUED', rowVersion: { increment: 1 } },
          })
        } else {
          await transaction.payment.update({
            where: { id: payment.id },
            data: {
              status: 'PROVED_NO_EFFECT',
              executionState: 'TERMINAL',
              outcomeState: 'PROVED_NO_EFFECT',
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
            newStateJson: JSON.stringify({ status: nextStatus, payment_id: payment.id }),
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
      const destination = await prisma.approvedDestination.create({
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
      return toApprovedDestinationRecord(destination)
    },

    async revokeApprovedDestination(input) {
      const result = await prisma.approvedDestination.updateMany({
        where: { id: input.id, accountId: input.accountId, status: 'ACTIVE' },
        data: { status: 'REVOKED', revokedAt: new Date(), reason: input.reason },
      })
      if (result.count !== 1) throw new NotFoundError('Approved destination was not found')
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
                    { updatedAt: { lt: input.cursor.occurredAt } },
                    { updatedAt: input.cursor.occurredAt, id: { lt: input.cursor.id } },
                  ],
                }),
          },
          orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
          take: input.limit,
        }),
        prisma.incomingPayment.findMany({
          where: {
            accountId: input.accountId,
            ...(input.cursor === undefined
              ? {}
              : {
                  OR: [
                    { confirmedAt: { lt: input.cursor.occurredAt } },
                    { confirmedAt: input.cursor.occurredAt, id: { lt: input.cursor.id } },
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
          externalId: null,
          occurredAt: payment.updatedAt,
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
      const key = await prisma.custodyKeyVersion.create({
        data: {
          id: input.id,
          accountId: input.accountId ?? null,
          keyVersion: input.keyVersion,
          backendIdentity: input.backendIdentity,
          keyReference: input.keyReference,
          rootKeyFingerprint: input.rootKeyFingerprint,
        },
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
      const request = await prisma.signingRequest.create({
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
      return toSigningRequestRecord(request)
    },

    async findSigningRequest(attemptId) {
      const request = await prisma.signingRequest.findUnique({ where: { attemptId } })
      return request === null ? null : toSigningRequestRecord(request)
    },

    async completeSigningRequest(id, effectHash, status) {
      const result = await prisma.signingRequest.updateMany({
        where: { id, effectHash, status: 'PENDING' },
        data: { status, completedAt: new Date() },
      })
      if (result.count !== 1) throw new ConflictError('Signing request changed concurrently')
      return toSigningRequestRecord(
        await prisma.signingRequest.findUniqueOrThrow({ where: { id } }),
      )
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
