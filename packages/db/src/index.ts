import { randomBytes } from 'node:crypto'
import { PrismaPg } from '@prisma/adapter-pg'
import {
  assertPaymentAttemptStatusTransition,
  assertPaymentStatusTransition,
  ConflictError,
  ExternalRailError,
  InsufficientFundsError,
  RecipientResolutionError,
} from '@agent-payment/core'
import { PrismaClient, type Prisma } from './generated/client/client.js'

export type AgentAccountStatus = 'ACTIVE' | 'DISABLED'

export interface StoredAgentAccount {
  readonly id: string
  readonly name: string
  readonly status: AgentAccountStatus
  readonly solanaPublicKey: string
  readonly encryptedSolanaSecret: string
  readonly encryptionNonce: string
  readonly encryptionAuthTag: string
  readonly createdAt: Date
  readonly updatedAt: Date
}

export interface AuthenticatedAccount {
  readonly account: {
    readonly id: string
    readonly name: string
    readonly status: AgentAccountStatus
    readonly solanaPublicKey: string
  }
  readonly credential: {
    readonly id: string
    readonly accountId: string
    readonly keyHash: string
    readonly keyPrefix: string
    readonly revokedAt: Date | null
    readonly lastUsedAt: Date | null
  }
}

export interface CreateAgentAccountInput {
  readonly id: string
  readonly name: string
  readonly solanaPublicKey: string
  readonly encryptedSolanaSecret: string
  readonly encryptionNonce: string
  readonly encryptionAuthTag: string
  readonly credentialId: string
  readonly keyHash: string
  readonly keyPrefix: string
}

export interface AccountCustodyRecord {
  readonly accountId: string
  readonly solanaPublicKey: string
  readonly encryptedSolanaSecret: string
  readonly encryptionNonce: string
  readonly encryptionAuthTag: string
}

export interface AccountRepository {
  createAgentAccount(input: CreateAgentAccountInput): Promise<StoredAgentAccount>
  findAccountByCredentialHash(keyHash: string): Promise<AuthenticatedAccount | null>
  readonly findAccountCustody?: (
    accountId: string,
  ) => Promise<AccountCustodyRecord | null>
  markCredentialUsed(credentialId: string): Promise<void>
  revokeCredential(accountId: string, credentialId: string): Promise<boolean>
  readonly findAccountPublicKey?: (accountId: string) => Promise<string | null>
  readonly createApiCredential?: (input: {
    readonly id: string
    readonly accountId: string
    readonly keyHash: string
    readonly keyPrefix: string
  }) => Promise<StoredApiCredential>
  readonly listAccountSummaries?: () => Promise<readonly AccountSummary[]>
  readonly findAccountSummary?: (accountId: string) => Promise<AccountSummary | null>
}

export interface StoredApiCredential {
  readonly id: string
  readonly accountId: string
  readonly keyPrefix: string
  readonly createdAt: Date
  readonly revokedAt: Date | null
}

export interface AccountSummary {
  readonly id: string
  readonly name: string
  readonly status: AgentAccountStatus
  readonly solanaPublicKey: string
  readonly createdAt: Date
  readonly updatedAt: Date
  readonly credentials: readonly StoredApiCredential[]
}

export interface SponsorshipRepository {
  reserveFeeSponsorship(input: {
    readonly accountId: string
    readonly paymentId: string
    readonly lamports: bigint
    readonly maxLamportsPerDay: bigint
    readonly maxTransactionsPerHour: number
    readonly now?: Date
  }): Promise<void>
}

export interface RecipientDestinationRecord {
  readonly id: string
  readonly rail: string
  readonly type: string
  readonly walletAddress: string
}

export interface RecipientRecord {
  readonly id: string
  readonly ownerAccountId: string
  readonly displayName: string
  readonly type: string
  readonly managedAccountId: string | null
  readonly ownerStatus: AgentAccountStatus
  readonly destinations: readonly RecipientDestinationRecord[]
  readonly createdAt: Date
  readonly updatedAt: Date
}

export interface CreateRecipientInput {
  readonly id: string
  readonly ownerAccountId: string
  readonly displayName: string
  readonly type: string
  readonly managedAccountId?: string
  readonly destination: {
    readonly id: string
    readonly rail: string
    readonly type: string
    readonly walletAddress: string
  }
}

export interface UpdateRecipientInput {
  readonly id: string
  readonly ownerAccountId: string
  readonly displayName?: string
  readonly type?: string
  readonly managedAccountId?: string | null
  readonly destination?: {
    readonly id: string
    readonly rail: string
    readonly type: string
    readonly walletAddress: string
  }
}

export interface RecipientRepository {
  createRecipient(input: CreateRecipientInput): Promise<RecipientRecord>
  findRecipientForOwner(
    ownerAccountId: string,
    recipientId: string,
  ): Promise<RecipientRecord | null>
  listRecipients(ownerAccountId: string): Promise<readonly RecipientRecord[]>
  readonly listRecipientsPage?: (
    ownerAccountId: string,
    limit: number,
    cursor?: { readonly createdAt: Date; readonly id: string },
  ) => Promise<readonly RecipientRecord[]>
  readonly findRecipientsForOwner?: (
    ownerAccountId: string,
    recipientIds: readonly string[],
  ) => Promise<readonly RecipientRecord[]>
  updateRecipient(input: UpdateRecipientInput): Promise<RecipientRecord | null>
}

export interface IdempotencyReplay {
  readonly requestHash: string
  readonly payment: PaymentRecord
}

export interface ReservationRepository {
  findIdempotencyReplay(
    ownerAccountId: string,
    operation: PaymentKind,
    key: string,
  ): Promise<IdempotencyReplay | null>
  getActiveOutgoingReservationAtomic(
    ownerAccountId: string,
    currency: string,
  ): Promise<bigint>
  readonly reserveFeeSponsorship?: (input: {
    readonly accountId: string
    readonly paymentId: string
    readonly lamports: bigint
    readonly maxLamportsPerDay: bigint
    readonly maxTransactionsPerHour: number
    readonly now?: Date
  }) => Promise<void>
}

export type PaymentKind = 'PAY' | 'SEND' | 'REFUND'
export type PaymentStatus =
  'CREATED' | 'ROUTING' | 'SUBMITTED' | 'RECONCILING' | 'CONFIRMED' | 'FAILED'
export type PaymentAttemptStatus =
  | 'CREATED'
  | 'PREPARED'
  | 'EXECUTING'
  | 'SUBMITTED'
  | 'RECONCILING'
  | 'CONFIRMED'
  | 'FAILED'
export type ReservationStatus = 'ACTIVE' | 'RELEASED'

export interface PaymentRecord {
  readonly id: string
  readonly payerAccountId: string
  readonly payerPublicKey: string | null
  readonly recipientId: string | null
  readonly kind: PaymentKind
  readonly amountAtomic: bigint
  readonly currency: string
  readonly status: PaymentStatus
  readonly description: string | null
  readonly externalReference: string | null
  readonly route: string | null
  readonly createdAt: Date
  readonly updatedAt: Date
  readonly confirmedAt: Date | null
  readonly failedAt: Date | null
  readonly failureCode: string | null
  readonly failureMessageSafe: string | null
  readonly destinationRail: string | null
  readonly destinationType: string | null
  readonly destinationReference: string | null
  readonly recipientManagedAccountId: string | null
  readonly originalPaymentId: string | null
  readonly counterpartyAccountId: string | null
  readonly counterpartyAddress: string | null
  readonly lastRecoveryAttemptAt: Date | null
  readonly nextRecoveryAt: Date | null
  readonly recoveryCount: number
  readonly stuckSince: Date | null
}

export type ReceiveRequestStatus = 'OPEN' | 'PAID' | 'EXPIRED' | 'CANCELLED'

export interface ReceiveRequestRecord {
  readonly id: string
  readonly accountId: string
  readonly amountAtomic: bigint | null
  readonly currency: string
  readonly reference: string
  readonly status: ReceiveRequestStatus
  readonly createdAt: Date
  readonly updatedAt: Date
  readonly expiresAt: Date | null
  readonly paidAt: Date | null
  readonly matchedIncomingPaymentId: string | null
}

export interface IncomingPaymentRecord {
  readonly id: string
  readonly accountId: string
  readonly signature: string
  readonly amountAtomic: bigint
  readonly tokenAtomicUnits: bigint
  readonly tokenDecimals: number
  readonly currency: string
  readonly sourceAddress: string | null
  readonly reference: string | null
  readonly tokenAccount: string
  readonly settlementMint: string
  readonly status: 'CONFIRMED'
  readonly createdAt: Date
  readonly confirmedAt: Date
  readonly receiveRequestId: string | null
}

export interface ActiveAccountSettlement {
  readonly accountId: string
  readonly solanaPublicKey: string
}

export interface IncomingCursor {
  readonly accountId: string
  readonly rail: string
  readonly address: string
  readonly cursorSignature: string | null
}

export interface CreateReceiveRequestInput {
  readonly id: string
  readonly accountId: string
  readonly amountAtomic?: bigint
  readonly currency: string
  readonly reference: string
  readonly createdAt?: Date
  readonly expiresAt?: Date
}

export interface CreateIncomingPaymentInput {
  readonly id: string
  readonly accountId: string
  readonly signature: string
  readonly amountAtomic: bigint
  readonly tokenAtomicUnits?: bigint
  readonly tokenDecimals?: number
  readonly currency: string
  readonly sourceAddress?: string
  readonly reference?: string
  readonly tokenAccount: string
  readonly settlementMint: string
  readonly confirmedAt: Date
}

interface IncomingMatchInput {
  readonly incomingPaymentId: string
  readonly accountId: string
  readonly amountAtomic: bigint
  readonly reference: string | null
  readonly confirmedAt: Date
}

export interface ReceiveRepository {
  createReceiveRequest(input: CreateReceiveRequestInput): Promise<ReceiveRequestRecord>
  findReceiveRequestForOwner(
    accountId: string,
    id: string,
  ): Promise<ReceiveRequestRecord | null>
  listReceiveRequests(accountId: string): Promise<readonly ReceiveRequestRecord[]>
  matchIncomingPayment(input: IncomingMatchInput): Promise<string | null>
  expireOpenReceiveRequests(accountId: string, now: Date): Promise<void>
}

export interface IncomingPaymentRepository {
  listActiveAccountSettlements(): Promise<readonly ActiveAccountSettlement[]>
  getIncomingCursor(
    accountId: string,
    rail: string,
    address: string,
  ): Promise<IncomingCursor | null>
  saveIncomingCursor(input: {
    readonly accountId: string
    readonly rail: string
    readonly address: string
    readonly cursorSignature: string
  }): Promise<void>
  createIncomingPayment(
    input: CreateIncomingPaymentInput,
  ): Promise<{ readonly payment: IncomingPaymentRecord; readonly created: boolean }>
  findIncomingPaymentForOwner(
    accountId: string,
    id: string,
  ): Promise<IncomingPaymentRecord | null>
  listIncomingPayments(accountId: string): Promise<readonly IncomingPaymentRecord[]>
  readonly listIncomingPaymentsPage?: (
    accountId: string,
    limit: number,
    cursor?: { readonly createdAt: Date; readonly id: string },
  ) => Promise<readonly IncomingPaymentRecord[]>
  readonly recordIncomingReconciliationIssue: (input: {
    readonly id: string
    readonly accountId: string
    readonly signature: string
    readonly reason: string
  }) => Promise<void>
  readonly claimIncomingReconciliationIssues: (
    limit: number,
    now?: Date,
  ) => Promise<readonly IncomingReconciliationIssueRecord[]>
  readonly resolveIncomingReconciliationIssue: (
    issueId: string,
    now?: Date,
  ) => Promise<void>
  readonly updateIncomingReconciliationIssueReason: (
    issueId: string,
    reason: string,
  ) => Promise<void>
}

export interface IncomingReconciliationIssueRecord {
  readonly id: string
  readonly accountId: string
  readonly accountPublicKey: string
  readonly signature: string
  readonly reason: string
  readonly retryCount: number
}

export interface PaymentAttemptRecord {
  readonly id: string
  readonly paymentId: string
  readonly attemptNumber: number
  readonly rail: string
  readonly status: PaymentAttemptStatus
  readonly railTransactionId: string | null
  readonly serializedPayloadSafe: string | null
  readonly durablePayload: string | null
  readonly expectedExternalId: string | null
  readonly recoveryMetadata: string | null
  readonly confirmationMetadata: string | null
  readonly createdAt: Date
  readonly updatedAt: Date
}

export interface CreatePaymentAttemptInput {
  readonly id: string
  readonly paymentId: string
  readonly rail: string
  readonly status: PaymentAttemptStatus
  readonly serializedPayloadSafe?: string
  readonly durablePayload?: string
  readonly expectedExternalId?: string
  readonly recoveryMetadata?: string
}

export interface CreatePaymentWithReservationInput {
  readonly paymentId: string
  readonly reservationId: string
  readonly idempotencyId: string
  readonly ownerAccountId: string
  readonly operation: PaymentKind
  readonly idempotencyKey: string
  readonly requestHash: string
  readonly payerAccountId: string
  readonly payerPublicKey?: string
  readonly recipientId: string | null
  readonly amountAtomic: bigint
  readonly currency: string
  readonly description?: string
  readonly externalReference?: string
  readonly route: string
  readonly destinationRail?: string
  readonly destinationType?: string
  readonly destinationReference?: string
  readonly recipientManagedAccountId?: string
  readonly originalPaymentId?: string
  readonly counterpartyAccountId?: string
  readonly counterpartyAddress?: string
  readonly settledAtomic: bigint
}

export interface CreatePaymentWithReservationResult {
  readonly payment: PaymentRecord
  readonly created: boolean
}

export interface PaymentRepository {
  createPaymentWithReservation(
    input: CreatePaymentWithReservationInput,
  ): Promise<CreatePaymentWithReservationResult>
  finalizeConfirmedPayment(input: {
    readonly paymentId: string
    readonly expectedPaymentStatus: PaymentStatus
    readonly attemptId: string
    readonly expectedAttemptStatus: PaymentAttemptStatus
    readonly railTransactionId?: string
    readonly confirmationMetadata?: string
  }): Promise<PaymentRecord>
  finalizeFailedPayment(input: {
    readonly paymentId: string
    readonly expectedPaymentStatus: PaymentStatus
    readonly attemptId: string
    readonly expectedAttemptStatus: PaymentAttemptStatus
    readonly failureCode: string
    readonly failureMessageSafe: string
  }): Promise<PaymentRecord>
  markPaymentSubmitted(input: {
    readonly paymentId: string
    readonly attemptId: string
    readonly expectedPaymentStatus: PaymentStatus
    readonly expectedAttemptStatus: PaymentAttemptStatus
    readonly railTransactionId?: string
  }): Promise<PaymentRecord>
  markPaymentReconciling(input: {
    readonly paymentId: string
    readonly attemptId: string
    readonly expectedPaymentStatus: PaymentStatus
    readonly expectedAttemptStatus: PaymentAttemptStatus
  }): Promise<PaymentRecord>
  transitionPayment(
    paymentId: string,
    currentStatus: PaymentStatus,
    nextStatus: PaymentStatus,
    fields?: Readonly<{
      confirmedAt?: Date | null
      failedAt?: Date | null
      failureCode?: string | null
      failureMessageSafe?: string | null
    }>,
  ): Promise<PaymentRecord>
  getOrCreatePaymentAttempt(
    input: CreatePaymentAttemptInput,
  ): Promise<{ readonly attempt: PaymentAttemptRecord; readonly created: boolean }>
  claimPaymentAttemptExecution(
    attemptId: string,
  ): Promise<{ readonly attempt: PaymentAttemptRecord; readonly claimed: boolean }>
  updatePaymentAttempt(
    attemptId: string,
    currentStatus: PaymentAttemptStatus,
    nextStatus: PaymentAttemptStatus,
    fields?: Readonly<{
      railTransactionId?: string | null
      serializedPayloadSafe?: string | null
      durablePayload?: string | null
      expectedExternalId?: string | null
      recoveryMetadata?: string | null
      confirmationMetadata?: string | null
    }>,
  ): Promise<PaymentAttemptRecord>
  listPaymentAttempts(paymentId: string): Promise<readonly PaymentAttemptRecord[]>
  readonly listLatestPaymentAttempts?: (
    paymentIds: readonly string[],
  ) => Promise<readonly PaymentAttemptRecord[]>
  releaseReservation(paymentId: string): Promise<void>
  findPaymentForOwner(
    ownerAccountId: string,
    paymentId: string,
  ): Promise<PaymentRecord | null>
  listPayments(ownerAccountId: string): Promise<readonly PaymentRecord[]>
  readonly listPaymentsPage?: (
    ownerAccountId: string,
    limit: number,
    cursor?: { readonly createdAt: Date; readonly id: string },
  ) => Promise<readonly PaymentRecord[]>
  listRecoverablePayments(limit: number): Promise<readonly PaymentRecord[]>
  readonly claimRecoverablePayments?: (
    limit: number,
    now?: Date,
  ) => Promise<readonly PaymentRecord[]>
  findPaymentForRefund(
    accountId: string,
    paymentId: string,
  ): Promise<PaymentRecord | null>
  createRefundWithReservation(
    input: CreateRefundWithReservationInput,
  ): Promise<CreatePaymentWithReservationResult>
}

export interface CreateRefundWithReservationInput extends CreatePaymentWithReservationInput {
  readonly originalPaymentId: string
  readonly refundInitiatorAccountId: string
}

export interface DatabaseClient
  extends
    AccountRepository,
    RecipientRepository,
    PaymentRepository,
    ReservationRepository,
    ReceiveRepository,
    IncomingPaymentRepository {
  initializeRuntimeIdentity(
    input: RuntimeIdentity,
    validateLegacyCustody?: (custody: AccountCustodyRecord) => Promise<void>,
  ): Promise<void>
  reserveFeeSponsorship(input: {
    readonly accountId: string
    readonly paymentId: string
    readonly lamports: bigint
    readonly maxLamportsPerDay: bigint
    readonly maxTransactionsPerHour: number
    readonly now?: Date
  }): Promise<void>
  findAccountCustody(accountId: string): Promise<AccountCustodyRecord | null>
  findAccountPublicKey(accountId: string): Promise<string | null>
  checkReadiness(): Promise<void>
  disconnect(): Promise<void>
}

export interface RuntimeIdentity {
  readonly rail: string
  readonly version: string
  readonly cluster: string
  readonly settlementMint: string
  readonly custodyKeyFingerprint: string
}

async function matchIncomingPaymentInTransaction(
  transaction: Prisma.TransactionClient,
  input: IncomingMatchInput,
): Promise<string | null> {
  if (input.amountAtomic <= 0n) return null
  if (input.reference === null) return null

  await transaction.receiveRequest.updateMany({
    where: {
      accountId: input.accountId,
      status: 'OPEN',
      expiresAt: { lte: input.confirmedAt },
    },
    data: { status: 'EXPIRED' },
  })

  const candidates = await transaction.$queryRaw<readonly { id: string }[]>`
    SELECT "id"
    FROM "receive_requests"
    WHERE "account_id" = ${input.accountId}
      AND "reference" = ${input.reference}
      AND "status" IN ('OPEN', 'EXPIRED')
      AND "matched_incoming_payment_id" IS NULL
      AND "created_at" <= ${input.confirmedAt}
      AND ("expires_at" IS NULL OR "expires_at" > ${input.confirmedAt})
      AND ("amount_atomic" IS NULL OR "amount_atomic" = ${input.amountAtomic})
    ORDER BY "created_at" ASC, "id" ASC
    LIMIT 1
    FOR UPDATE
  `
  const requestId = candidates[0]?.id
  if (requestId === undefined) return null

  const incomingResult = await transaction.incomingPayment.updateMany({
    where: { id: input.incomingPaymentId, receiveRequestId: null },
    data: { receiveRequestId: requestId },
  })
  if (incomingResult.count !== 1) return null

  const requestResult = await transaction.receiveRequest.updateMany({
    where: {
      id: requestId,
      status: { in: ['OPEN', 'EXPIRED'] },
      matchedIncomingPaymentId: null,
    },
    data: {
      status: 'PAID',
      paidAt: input.confirmedAt,
      matchedIncomingPaymentId: input.incomingPaymentId,
    },
  })
  if (requestResult.count !== 1) {
    throw new ConflictError('Receive request was claimed concurrently')
  }
  return requestId
}

export function createDatabaseClient(databaseUrl: string): DatabaseClient {
  const adapter = new PrismaPg({ connectionString: databaseUrl })
  const prisma = new PrismaClient({ adapter })

  return {
    async createAgentAccount(input): Promise<StoredAgentAccount> {
      return prisma.$transaction(async (transaction) => {
        const account = await transaction.agentAccount.create({
          data: {
            id: input.id,
            name: input.name,
            solanaPublicKey: input.solanaPublicKey,
            encryptedSolanaSecret: input.encryptedSolanaSecret,
            encryptionNonce: input.encryptionNonce,
            encryptionAuthTag: input.encryptionAuthTag,
          },
        })
        await transaction.apiCredential.create({
          data: {
            id: input.credentialId,
            accountId: account.id,
            keyHash: input.keyHash,
            keyPrefix: input.keyPrefix,
          },
        })
        return account
      })
    },
    async findAccountByCredentialHash(keyHash): Promise<AuthenticatedAccount | null> {
      const credential = await prisma.apiCredential.findUnique({
        where: { keyHash },
        select: {
          id: true,
          accountId: true,
          keyHash: true,
          keyPrefix: true,
          revokedAt: true,
          lastUsedAt: true,
          account: {
            select: {
              id: true,
              name: true,
              status: true,
              solanaPublicKey: true,
            },
          },
        },
      })
      if (credential === null) {
        return null
      }
      return {
        account: credential.account,
        credential: {
          id: credential.id,
          accountId: credential.accountId,
          keyHash: credential.keyHash,
          keyPrefix: credential.keyPrefix,
          revokedAt: credential.revokedAt,
          lastUsedAt: credential.lastUsedAt,
        },
      }
    },
    async findAccountCustody(accountId): Promise<AccountCustodyRecord | null> {
      const account = await prisma.agentAccount.findUnique({
        where: { id: accountId },
        select: {
          id: true,
          solanaPublicKey: true,
          encryptedSolanaSecret: true,
          encryptionNonce: true,
          encryptionAuthTag: true,
        },
      })
      return account === null
        ? null
        : {
            accountId: account.id,
            solanaPublicKey: account.solanaPublicKey,
            encryptedSolanaSecret: account.encryptedSolanaSecret,
            encryptionNonce: account.encryptionNonce,
            encryptionAuthTag: account.encryptionAuthTag,
          }
    },
    async markCredentialUsed(credentialId): Promise<void> {
      await prisma.apiCredential.update({
        where: { id: credentialId },
        data: { lastUsedAt: new Date() },
      })
    },
    async revokeCredential(accountId, credentialId): Promise<boolean> {
      const result = await prisma.apiCredential.updateMany({
        where: { id: credentialId, accountId, revokedAt: null },
        data: { revokedAt: new Date() },
      })
      return result.count === 1
    },
    async createApiCredential(input): Promise<StoredApiCredential> {
      const credential = await prisma.apiCredential.create({
        data: {
          id: input.id,
          accountId: input.accountId,
          keyHash: input.keyHash,
          keyPrefix: input.keyPrefix,
        },
      })
      return {
        id: credential.id,
        accountId: credential.accountId,
        keyPrefix: credential.keyPrefix,
        createdAt: credential.createdAt,
        revokedAt: credential.revokedAt,
      }
    },
    async listAccountSummaries() {
      const accounts = await prisma.agentAccount.findMany({
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        include: {
          credentials: {
            select: {
              id: true,
              accountId: true,
              keyPrefix: true,
              createdAt: true,
              revokedAt: true,
            },
            orderBy: { createdAt: 'asc' },
          },
        },
      })
      return accounts.map((account) => ({
        id: account.id,
        name: account.name,
        status: account.status,
        solanaPublicKey: account.solanaPublicKey,
        createdAt: account.createdAt,
        updatedAt: account.updatedAt,
        credentials: account.credentials,
      }))
    },
    async findAccountSummary(accountId) {
      const accounts = await prisma.agentAccount.findMany({
        where: { id: accountId },
        include: {
          credentials: {
            select: {
              id: true,
              accountId: true,
              keyPrefix: true,
              createdAt: true,
              revokedAt: true,
            },
            orderBy: { createdAt: 'asc' },
          },
        },
      })
      const account = accounts[0]
      return account === undefined
        ? null
        : {
            id: account.id,
            name: account.name,
            status: account.status,
            solanaPublicKey: account.solanaPublicKey,
            createdAt: account.createdAt,
            updatedAt: account.updatedAt,
            credentials: account.credentials,
          }
    },
    async findAccountPublicKey(accountId): Promise<string | null> {
      const account = await prisma.agentAccount.findFirst({
        where: { id: accountId, status: 'ACTIVE' },
        select: { solanaPublicKey: true },
      })
      return account?.solanaPublicKey ?? null
    },
    async createRecipient(input): Promise<RecipientRecord> {
      const recipient = await prisma.recipient.create({
        data: {
          id: input.id,
          ownerAccountId: input.ownerAccountId,
          displayName: input.displayName,
          type: input.type,
          ...(input.managedAccountId === undefined
            ? {}
            : { managedAccountId: input.managedAccountId }),
          destinations: {
            create: {
              id: input.destination.id,
              rail: input.destination.rail,
              type: input.destination.type,
              walletAddress: input.destination.walletAddress,
            },
          },
        },
        include: { destinations: true, ownerAccount: { select: { status: true } } },
      })
      return toRecipientRecord(recipient)
    },
    async findRecipientForOwner(
      ownerAccountId,
      recipientId,
    ): Promise<RecipientRecord | null> {
      const recipient = await prisma.recipient.findFirst({
        where: { id: recipientId, ownerAccountId },
        include: { destinations: true, ownerAccount: { select: { status: true } } },
      })
      return recipient === null ? null : toRecipientRecord(recipient)
    },
    async listRecipients(ownerAccountId): Promise<readonly RecipientRecord[]> {
      const recipients = await prisma.recipient.findMany({
        where: { ownerAccountId },
        orderBy: { createdAt: 'desc' },
        include: { destinations: true, ownerAccount: { select: { status: true } } },
      })
      return recipients.map(toRecipientRecord)
    },
    async listRecipientsPage(ownerAccountId, limit, cursor) {
      const recipients = await prisma.recipient.findMany({
        where: {
          ownerAccountId,
          ...(cursor === undefined
            ? {}
            : {
                OR: [
                  { createdAt: { lt: cursor.createdAt } },
                  { createdAt: cursor.createdAt, id: { lt: cursor.id } },
                ],
              }),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
        include: { destinations: true, ownerAccount: { select: { status: true } } },
      })
      return recipients.map(toRecipientRecord)
    },
    async findRecipientsForOwner(ownerAccountId, recipientIds) {
      if (recipientIds.length === 0) return []
      const recipients = await prisma.recipient.findMany({
        where: { ownerAccountId, id: { in: [...recipientIds] } },
        include: { destinations: true, ownerAccount: { select: { status: true } } },
      })
      return recipients.map(toRecipientRecord)
    },
    async updateRecipient(input): Promise<RecipientRecord | null> {
      return prisma.$transaction(async (transaction) => {
        if (input.destination !== undefined) {
          const destination = await transaction.recipientDestination.findFirst({
            where: { id: input.destination.id, recipientId: input.id },
            select: { id: true },
          })
          if (destination === null) {
            throw new RecipientResolutionError('Recipient destination was not found')
          }
        }
        const result = await transaction.recipient.updateMany({
          where: { id: input.id, ownerAccountId: input.ownerAccountId },
          data: {
            ...(input.displayName === undefined
              ? {}
              : { displayName: input.displayName }),
            ...(input.type === undefined ? {} : { type: input.type }),
            ...(input.managedAccountId === undefined
              ? {}
              : { managedAccountId: input.managedAccountId }),
          },
        })
        if (result.count !== 1) {
          return null
        }
        if (input.destination !== undefined) {
          const destinationResult = await transaction.recipientDestination.updateMany({
            where: { id: input.destination.id, recipientId: input.id },
            data: {
              rail: input.destination.rail,
              type: input.destination.type,
              walletAddress: input.destination.walletAddress,
            },
          })
          if (destinationResult.count !== 1) {
            throw new RecipientResolutionError('Recipient destination was not found')
          }
        }
        const recipient = await transaction.recipient.findFirst({
          where: { id: input.id, ownerAccountId: input.ownerAccountId },
          include: {
            destinations: true,
            ownerAccount: { select: { status: true } },
          },
        })
        return recipient === null ? null : toRecipientRecord(recipient)
      })
    },
    async createPaymentWithReservation(
      input,
    ): Promise<CreatePaymentWithReservationResult> {
      return prisma.$transaction(async (transaction) => {
        await transaction.$queryRaw`
          SELECT id FROM "agent_accounts" WHERE id = ${input.payerAccountId} FOR UPDATE
        `

        const existingIdempotency = await transaction.idempotencyRecord.findUnique({
          where: {
            ownerAccountId_operation_key: {
              ownerAccountId: input.ownerAccountId,
              operation: input.operation,
              key: input.idempotencyKey,
            },
          },
        })
        if (existingIdempotency !== null) {
          if (existingIdempotency.requestHash !== input.requestHash) {
            throw new ConflictError(
              'Idempotency key was already used for another request',
            )
          }
          const existingPayment = await transaction.payment.findUniqueOrThrow({
            where: { id: existingIdempotency.resourceId },
          })
          return { payment: toPaymentRecord(existingPayment), created: false }
        }

        const activeReservations = await transaction.outgoingReservation.aggregate({
          where: { ownerAccountId: input.ownerAccountId, status: 'ACTIVE' },
          _sum: { amountAtomic: true },
        })
        const reservedAtomic = activeReservations._sum.amountAtomic ?? 0n
        if (input.amountAtomic > input.settledAtomic - reservedAtomic) {
          throw new InsufficientFundsError()
        }

        const payment = await transaction.payment.create({
          data: {
            id: input.paymentId,
            payerAccountId: input.payerAccountId,
            ...(input.payerPublicKey === undefined
              ? {}
              : { payerPublicKey: input.payerPublicKey }),
            recipientId: input.recipientId,
            kind: input.operation,
            amountAtomic: input.amountAtomic,
            currency: input.currency,
            route: input.route,
            ...(input.description === undefined
              ? {}
              : { description: input.description }),
            ...(input.externalReference === undefined
              ? {}
              : { externalReference: input.externalReference }),
            ...(input.destinationRail === undefined
              ? {}
              : { destinationRail: input.destinationRail }),
            ...(input.destinationType === undefined
              ? {}
              : { destinationType: input.destinationType }),
            ...(input.destinationReference === undefined
              ? {}
              : { destinationReference: input.destinationReference }),
            ...(input.recipientManagedAccountId === undefined
              ? {}
              : { recipientManagedAccountId: input.recipientManagedAccountId }),
            ...(input.originalPaymentId === undefined
              ? {}
              : { originalPaymentId: input.originalPaymentId }),
            ...(input.counterpartyAccountId === undefined
              ? {}
              : { counterpartyAccountId: input.counterpartyAccountId }),
            ...(input.counterpartyAddress === undefined
              ? {}
              : { counterpartyAddress: input.counterpartyAddress }),
          },
        })
        await transaction.outgoingReservation.create({
          data: {
            id: input.reservationId,
            paymentId: payment.id,
            ownerAccountId: input.ownerAccountId,
            amountAtomic: input.amountAtomic,
            currency: input.currency,
          },
        })
        await transaction.idempotencyRecord.create({
          data: {
            id: input.idempotencyId,
            ownerAccountId: input.ownerAccountId,
            operation: input.operation,
            key: input.idempotencyKey,
            requestHash: input.requestHash,
            resourceId: payment.id,
          },
        })
        return { payment: toPaymentRecord(payment), created: true }
      })
    },
    async createRefundWithReservation(
      input,
    ): Promise<CreatePaymentWithReservationResult> {
      return prisma.$transaction(async (transaction) => {
        await transaction.$queryRaw`
          SELECT id FROM "payments" WHERE id = ${input.originalPaymentId} FOR UPDATE
        `
        await transaction.$queryRaw`
          SELECT id FROM "agent_accounts" WHERE id = ${input.payerAccountId} FOR UPDATE
        `
        const existingIdempotency = await transaction.idempotencyRecord.findUnique({
          where: {
            ownerAccountId_operation_key: {
              ownerAccountId: input.ownerAccountId,
              operation: 'REFUND',
              key: input.idempotencyKey,
            },
          },
        })
        if (existingIdempotency !== null) {
          if (existingIdempotency.requestHash !== input.requestHash) {
            throw new ConflictError(
              'Idempotency key was already used for another request',
            )
          }
          return {
            payment: toPaymentRecord(
              await transaction.payment.findUniqueOrThrow({
                where: { id: existingIdempotency.resourceId },
              }),
            ),
            created: false,
          }
        }
        const original = await transaction.payment.findUniqueOrThrow({
          where: { id: input.originalPaymentId },
        })
        if (
          original.status !== 'CONFIRMED' ||
          original.recipientManagedAccountId !== input.refundInitiatorAccountId
        ) {
          throw new RecipientResolutionError(
            'Original payment is not refundable by this account',
          )
        }
        const refunds = await transaction.payment.aggregate({
          where: {
            originalPaymentId: input.originalPaymentId,
            status: { not: 'FAILED' },
          },
          _sum: { amountAtomic: true },
        })
        const refundedAtomic = refunds._sum.amountAtomic ?? 0n
        const activeReservations = await transaction.outgoingReservation.aggregate({
          where: { ownerAccountId: input.ownerAccountId, status: 'ACTIVE' },
          _sum: { amountAtomic: true },
        })
        const reservedAtomic = activeReservations._sum.amountAtomic ?? 0n
        if (input.amountAtomic > original.amountAtomic - refundedAtomic) {
          throw new ConflictError('Refund amount exceeds the original payment amount')
        }
        if (input.amountAtomic > input.settledAtomic - reservedAtomic) {
          throw new InsufficientFundsError()
        }
        const payment = await transaction.payment.create({
          data: {
            id: input.paymentId,
            payerAccountId: input.payerAccountId,
            ...(input.payerPublicKey === undefined
              ? {}
              : { payerPublicKey: input.payerPublicKey }),
            recipientId: null,
            kind: 'REFUND',
            amountAtomic: input.amountAtomic,
            currency: input.currency,
            route: input.route,
            ...(input.description === undefined
              ? {}
              : { description: input.description }),
            ...(input.externalReference === undefined
              ? {}
              : { externalReference: input.externalReference }),
            ...(input.destinationRail === undefined
              ? {}
              : { destinationRail: input.destinationRail }),
            ...(input.destinationType === undefined
              ? {}
              : { destinationType: input.destinationType }),
            ...(input.destinationReference === undefined
              ? {}
              : { destinationReference: input.destinationReference }),
            ...(input.recipientManagedAccountId === undefined
              ? {}
              : { recipientManagedAccountId: input.recipientManagedAccountId }),
            originalPaymentId: input.originalPaymentId,
            ...(input.counterpartyAccountId === undefined
              ? {}
              : { counterpartyAccountId: input.counterpartyAccountId }),
            ...(input.counterpartyAddress === undefined
              ? {}
              : { counterpartyAddress: input.counterpartyAddress }),
          },
        })
        await transaction.outgoingReservation.create({
          data: {
            id: input.reservationId,
            paymentId: payment.id,
            ownerAccountId: input.ownerAccountId,
            amountAtomic: input.amountAtomic,
            currency: input.currency,
          },
        })
        await transaction.idempotencyRecord.create({
          data: {
            id: input.idempotencyId,
            ownerAccountId: input.ownerAccountId,
            operation: 'REFUND',
            key: input.idempotencyKey,
            requestHash: input.requestHash,
            resourceId: payment.id,
          },
        })
        return { payment: toPaymentRecord(payment), created: true }
      })
    },
    async findIdempotencyReplay(
      ownerAccountId,
      operation,
      key,
    ): Promise<IdempotencyReplay | null> {
      const record = await prisma.idempotencyRecord.findUnique({
        where: { ownerAccountId_operation_key: { ownerAccountId, operation, key } },
      })
      if (record === null) {
        return null
      }
      const payment = await prisma.payment.findUniqueOrThrow({
        where: { id: record.resourceId },
      })
      return { requestHash: record.requestHash, payment: toPaymentRecord(payment) }
    },
    async getActiveOutgoingReservationAtomic(
      ownerAccountId,
      currency,
    ): Promise<bigint> {
      const result = await prisma.outgoingReservation.aggregate({
        where: { ownerAccountId, currency, status: 'ACTIVE' },
        _sum: { amountAtomic: true },
      })
      return result._sum.amountAtomic ?? 0n
    },
    async reserveFeeSponsorship(input): Promise<void> {
      const now = input.now ?? new Date()
      const dayStart = new Date(now)
      dayStart.setUTCHours(0, 0, 0, 0)
      const hourStart = new Date(now.getTime() - 60 * 60 * 1000)
      await prisma.$transaction(async (transaction) => {
        await transaction.$queryRaw`
          SELECT id FROM "agent_accounts" WHERE id = ${input.accountId} FOR UPDATE
        `
        const existing = await transaction.feeSponsorship.findUnique({
          where: { paymentId: input.paymentId },
        })
        if (existing !== null && input.lamports <= existing.lamports) return
        const additionalLamports =
          existing === null ? input.lamports : input.lamports - existing.lamports
        const [daily, hourly] = await Promise.all([
          transaction.feeSponsorship.aggregate({
            where: { accountId: input.accountId, createdAt: { gte: dayStart } },
            _sum: { lamports: true },
          }),
          transaction.feeSponsorship.count({
            where: { accountId: input.accountId, createdAt: { gte: hourStart } },
          }),
        ])
        const dailyLamports = daily._sum.lamports ?? 0n
        if (
          dailyLamports + additionalLamports > input.maxLamportsPerDay ||
          (existing === null && hourly >= input.maxTransactionsPerHour)
        ) {
          throw new ExternalRailError(
            'Account sponsorship budget is exhausted',
            undefined,
            'DETERMINISTIC',
          )
        }
        if (existing === null) {
          await transaction.feeSponsorship.create({
            data: {
              id: `spon_${randomBytes(16).toString('hex')}`,
              accountId: input.accountId,
              paymentId: input.paymentId,
              lamports: input.lamports,
              createdAt: now,
            },
          })
        } else {
          await transaction.feeSponsorship.update({
            where: { id: existing.id },
            data: { lamports: input.lamports },
          })
        }
      })
    },
    async transitionPayment(paymentId, currentStatus, nextStatus, fields) {
      assertPaymentStatusTransition(currentStatus, nextStatus)
      const result = await prisma.payment.updateMany({
        where: { id: paymentId, status: currentStatus },
        data: {
          status: nextStatus,
          ...(fields?.confirmedAt === undefined
            ? {}
            : { confirmedAt: fields.confirmedAt }),
          ...(fields?.failedAt === undefined ? {} : { failedAt: fields.failedAt }),
          ...(fields?.failureCode === undefined
            ? {}
            : { failureCode: fields.failureCode }),
          ...(fields?.failureMessageSafe === undefined
            ? {}
            : { failureMessageSafe: fields.failureMessageSafe }),
        },
      })
      if (result.count !== 1) {
        throw new ConflictError('Payment state changed concurrently')
      }
      const payment = await prisma.payment.findUniqueOrThrow({
        where: { id: paymentId },
      })
      return toPaymentRecord(payment)
    },
    async getOrCreatePaymentAttempt(input) {
      return prisma.$transaction(async (transaction) => {
        await transaction.$queryRaw`
          SELECT id FROM "payments" WHERE id = ${input.paymentId} FOR UPDATE
        `
        const latest = await transaction.paymentAttempt.findFirst({
          where: { paymentId: input.paymentId },
          orderBy: { attemptNumber: 'desc' },
        })
        if (latest !== null) {
          return { attempt: toPaymentAttemptRecord(latest), created: false }
        }
        const attempt = await transaction.paymentAttempt.create({
          data: {
            id: input.id,
            paymentId: input.paymentId,
            attemptNumber: 1,
            rail: input.rail,
            status: input.status,
            ...(input.serializedPayloadSafe === undefined
              ? {}
              : { serializedPayloadSafe: input.serializedPayloadSafe }),
            ...(input.durablePayload === undefined
              ? {}
              : { durablePayload: input.durablePayload }),
            ...(input.expectedExternalId === undefined
              ? {}
              : { expectedExternalId: input.expectedExternalId }),
            ...(input.recoveryMetadata === undefined
              ? {}
              : { recoveryMetadata: input.recoveryMetadata }),
          },
        })
        return { attempt: toPaymentAttemptRecord(attempt), created: true }
      })
    },
    async claimPaymentAttemptExecution(attemptId) {
      return prisma.$transaction(async (transaction) => {
        const attempt = await transaction.paymentAttempt.findUniqueOrThrow({
          where: { id: attemptId },
        })
        await transaction.$queryRaw`
          SELECT id FROM "payments" WHERE id = ${attempt.paymentId} FOR UPDATE
        `
        const result = await transaction.paymentAttempt.updateMany({
          where: { id: attemptId, status: 'PREPARED' },
          data: { status: 'EXECUTING' },
        })
        const current = await transaction.paymentAttempt.findUniqueOrThrow({
          where: { id: attemptId },
        })
        return {
          attempt: toPaymentAttemptRecord(current),
          claimed: result.count === 1,
        }
      })
    },
    async finalizeConfirmedPayment(input): Promise<PaymentRecord> {
      if (
        input.expectedAttemptStatus === 'PREPARED' ||
        input.expectedAttemptStatus === 'EXECUTING'
      ) {
        assertPaymentAttemptStatusTransition(input.expectedAttemptStatus, 'SUBMITTED')
      } else {
        assertPaymentAttemptStatusTransition(input.expectedAttemptStatus, 'CONFIRMED')
      }
      if (input.expectedPaymentStatus === 'ROUTING') {
        assertPaymentStatusTransition('ROUTING', 'SUBMITTED')
      } else {
        assertPaymentStatusTransition(input.expectedPaymentStatus, 'CONFIRMED')
      }
      return prisma.$transaction(async (transaction) => {
        const currentAttempt = await transaction.paymentAttempt.findUniqueOrThrow({
          where: { id: input.attemptId },
          select: { expectedExternalId: true },
        })
        let attemptStatus = input.expectedAttemptStatus
        if (attemptStatus === 'PREPARED' || attemptStatus === 'EXECUTING') {
          const submittedAttempt = await transaction.paymentAttempt.updateMany({
            where: { id: input.attemptId, status: attemptStatus },
            data: {
              status: 'SUBMITTED',
              ...(input.railTransactionId === undefined
                ? {}
                : { railTransactionId: input.railTransactionId }),
            },
          })
          if (submittedAttempt.count !== 1) {
            throw new ConflictError('Payment attempt state changed concurrently')
          }
          attemptStatus = 'SUBMITTED'
        }
        const attemptResult = await transaction.paymentAttempt.updateMany({
          where: { id: input.attemptId, status: attemptStatus },
          data: {
            status: 'CONFIRMED',
            ...(input.railTransactionId === undefined &&
            currentAttempt.expectedExternalId === null
              ? {}
              : {
                  railTransactionId:
                    input.railTransactionId ?? currentAttempt.expectedExternalId,
                }),
            ...(input.confirmationMetadata === undefined
              ? {}
              : { confirmationMetadata: input.confirmationMetadata }),
          },
        })
        if (attemptResult.count !== 1) {
          throw new ConflictError('Payment attempt state changed concurrently')
        }
        let paymentStatus = input.expectedPaymentStatus
        if (paymentStatus === 'ROUTING') {
          const submittedPayment = await transaction.payment.updateMany({
            where: { id: input.paymentId, status: 'ROUTING' },
            data: { status: 'SUBMITTED' },
          })
          if (submittedPayment.count !== 1) {
            throw new ConflictError('Payment state changed concurrently')
          }
          paymentStatus = 'SUBMITTED'
        }
        const paymentResult = await transaction.payment.updateMany({
          where: { id: input.paymentId, status: paymentStatus },
          data: { status: 'CONFIRMED', confirmedAt: new Date() },
        })
        if (paymentResult.count !== 1) {
          throw new ConflictError('Payment state changed concurrently')
        }
        await transaction.outgoingReservation.updateMany({
          where: { paymentId: input.paymentId, status: 'ACTIVE' },
          data: { status: 'RELEASED', releasedAt: new Date() },
        })
        return toPaymentRecord(
          await transaction.payment.findUniqueOrThrow({
            where: { id: input.paymentId },
          }),
        )
      })
    },
    async finalizeFailedPayment(input): Promise<PaymentRecord> {
      assertPaymentAttemptStatusTransition(input.expectedAttemptStatus, 'FAILED')
      assertPaymentStatusTransition(input.expectedPaymentStatus, 'FAILED')
      return prisma.$transaction(async (transaction) => {
        const attemptResult = await transaction.paymentAttempt.updateMany({
          where: { id: input.attemptId, status: input.expectedAttemptStatus },
          data: { status: 'FAILED' },
        })
        if (attemptResult.count !== 1) {
          throw new ConflictError('Payment attempt state changed concurrently')
        }
        const paymentResult = await transaction.payment.updateMany({
          where: { id: input.paymentId, status: input.expectedPaymentStatus },
          data: {
            status: 'FAILED',
            failedAt: new Date(),
            failureCode: input.failureCode,
            failureMessageSafe: input.failureMessageSafe,
          },
        })
        if (paymentResult.count !== 1) {
          throw new ConflictError('Payment state changed concurrently')
        }
        await transaction.outgoingReservation.updateMany({
          where: { paymentId: input.paymentId, status: 'ACTIVE' },
          data: { status: 'RELEASED', releasedAt: new Date() },
        })
        return toPaymentRecord(
          await transaction.payment.findUniqueOrThrow({
            where: { id: input.paymentId },
          }),
        )
      })
    },
    async markPaymentSubmitted(input): Promise<PaymentRecord> {
      assertPaymentAttemptStatusTransition(input.expectedAttemptStatus, 'SUBMITTED')
      assertPaymentStatusTransition(input.expectedPaymentStatus, 'SUBMITTED')
      return prisma.$transaction(async (transaction) => {
        const attemptResult = await transaction.paymentAttempt.updateMany({
          where: { id: input.attemptId, status: input.expectedAttemptStatus },
          data: {
            status: 'SUBMITTED',
            ...(input.railTransactionId === undefined
              ? {}
              : { railTransactionId: input.railTransactionId }),
          },
        })
        if (attemptResult.count !== 1) {
          throw new ConflictError('Payment attempt state changed concurrently')
        }
        const paymentResult = await transaction.payment.updateMany({
          where: { id: input.paymentId, status: input.expectedPaymentStatus },
          data: { status: 'SUBMITTED' },
        })
        if (paymentResult.count !== 1) {
          throw new ConflictError('Payment state changed concurrently')
        }
        return toPaymentRecord(
          await transaction.payment.findUniqueOrThrow({
            where: { id: input.paymentId },
          }),
        )
      })
    },
    async markPaymentReconciling(input): Promise<PaymentRecord> {
      assertPaymentAttemptStatusTransition(input.expectedAttemptStatus, 'RECONCILING')
      assertPaymentStatusTransition(input.expectedPaymentStatus, 'RECONCILING')
      return prisma.$transaction(async (transaction) => {
        const attemptResult = await transaction.paymentAttempt.updateMany({
          where: { id: input.attemptId, status: input.expectedAttemptStatus },
          data: { status: 'RECONCILING' },
        })
        if (attemptResult.count !== 1) {
          throw new ConflictError('Payment attempt state changed concurrently')
        }
        const paymentResult = await transaction.payment.updateMany({
          where: { id: input.paymentId, status: input.expectedPaymentStatus },
          data: { status: 'RECONCILING' },
        })
        if (paymentResult.count !== 1) {
          throw new ConflictError('Payment state changed concurrently')
        }
        return toPaymentRecord(
          await transaction.payment.findUniqueOrThrow({
            where: { id: input.paymentId },
          }),
        )
      })
    },
    async updatePaymentAttempt(attemptId, currentStatus, nextStatus, fields) {
      const result = await prisma.paymentAttempt.updateMany({
        where: { id: attemptId, status: currentStatus },
        data: {
          status: nextStatus,
          ...(fields?.railTransactionId === undefined
            ? {}
            : { railTransactionId: fields.railTransactionId }),
          ...(fields?.serializedPayloadSafe === undefined
            ? {}
            : { serializedPayloadSafe: fields.serializedPayloadSafe }),
          ...(fields?.durablePayload === undefined
            ? {}
            : { durablePayload: fields.durablePayload }),
          ...(fields?.expectedExternalId === undefined
            ? {}
            : { expectedExternalId: fields.expectedExternalId }),
          ...(fields?.recoveryMetadata === undefined
            ? {}
            : { recoveryMetadata: fields.recoveryMetadata }),
          ...(fields?.confirmationMetadata === undefined
            ? {}
            : { confirmationMetadata: fields.confirmationMetadata }),
        },
      })
      if (result.count !== 1) {
        throw new ConflictError('Payment attempt state changed concurrently')
      }
      const attempt = await prisma.paymentAttempt.findUniqueOrThrow({
        where: { id: attemptId },
      })
      return toPaymentAttemptRecord(attempt)
    },
    async listPaymentAttempts(paymentId): Promise<readonly PaymentAttemptRecord[]> {
      const attempts = await prisma.paymentAttempt.findMany({
        where: { paymentId },
        orderBy: { attemptNumber: 'asc' },
      })
      return attempts.map(toPaymentAttemptRecord)
    },
    async listLatestPaymentAttempts(paymentIds) {
      if (paymentIds.length === 0) return []
      const attempts = await prisma.paymentAttempt.findMany({
        where: { paymentId: { in: [...paymentIds] } },
        orderBy: { attemptNumber: 'desc' },
      })
      return attempts.map(toPaymentAttemptRecord)
    },
    async releaseReservation(paymentId): Promise<void> {
      await prisma.outgoingReservation.updateMany({
        where: { paymentId, status: 'ACTIVE' },
        data: { status: 'RELEASED', releasedAt: new Date() },
      })
    },
    async findPaymentForOwner(
      ownerAccountId,
      paymentId,
    ): Promise<PaymentRecord | null> {
      const payment = await prisma.payment.findFirst({
        where: { id: paymentId, payerAccountId: ownerAccountId },
      })
      return payment === null ? null : toPaymentRecord(payment)
    },
    async listPayments(ownerAccountId): Promise<readonly PaymentRecord[]> {
      const payments = await prisma.payment.findMany({
        where: { payerAccountId: ownerAccountId },
        orderBy: { createdAt: 'desc' },
      })
      return payments.map(toPaymentRecord)
    },
    async listPaymentsPage(ownerAccountId, limit, cursor) {
      const payments = await prisma.payment.findMany({
        where: {
          payerAccountId: ownerAccountId,
          ...(cursor === undefined
            ? {}
            : {
                OR: [
                  { createdAt: { lt: cursor.createdAt } },
                  { createdAt: cursor.createdAt, id: { lt: cursor.id } },
                ],
              }),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
      })
      return payments.map(toPaymentRecord)
    },
    async listRecoverablePayments(limit): Promise<readonly PaymentRecord[]> {
      const payments = await prisma.payment.findMany({
        where: {
          status: { in: ['CREATED', 'ROUTING', 'SUBMITTED', 'RECONCILING'] },
          OR: [{ nextRecoveryAt: null }, { nextRecoveryAt: { lte: new Date() } }],
        },
        orderBy: [
          { lastRecoveryAttemptAt: { sort: 'asc', nulls: 'first' } },
          { id: 'asc' },
        ],
        take: limit,
      })
      return payments.map(toPaymentRecord)
    },
    async claimRecoverablePayments(limit, now = new Date()) {
      const nextRecoveryAt = new Date(now.getTime() + 30_000)
      return prisma.$transaction(async (transaction) => {
        const candidates = await transaction.payment.findMany({
          where: {
            status: { in: ['CREATED', 'ROUTING', 'SUBMITTED', 'RECONCILING'] },
            OR: [{ nextRecoveryAt: null }, { nextRecoveryAt: { lte: now } }],
          },
          orderBy: [
            { lastRecoveryAttemptAt: { sort: 'asc', nulls: 'first' } },
            { id: 'asc' },
          ],
          take: limit,
        })
        const claimedIds: string[] = []
        for (const candidate of candidates) {
          const updated = await transaction.payment.updateMany({
            where: {
              id: candidate.id,
              status: { in: ['CREATED', 'ROUTING', 'SUBMITTED', 'RECONCILING'] },
              OR: [{ nextRecoveryAt: null }, { nextRecoveryAt: { lte: now } }],
            },
            data: {
              lastRecoveryAttemptAt: now,
              nextRecoveryAt,
              recoveryCount: { increment: 1 },
              stuckSince: candidate.stuckSince ?? now,
            },
          })
          if (updated.count === 1) claimedIds.push(candidate.id)
        }
        if (claimedIds.length === 0) return []
        const claimed = await transaction.payment.findMany({
          where: { id: { in: claimedIds } },
        })
        return claimed.map(toPaymentRecord)
      })
    },
    async findPaymentForRefund(accountId, paymentId): Promise<PaymentRecord | null> {
      const payment = await prisma.payment.findFirst({ where: { id: paymentId } })
      if (payment === null || payment.recipientManagedAccountId !== accountId) {
        return null
      }
      return toPaymentRecord(payment)
    },
    async createReceiveRequest(input): Promise<ReceiveRequestRecord> {
      try {
        const request = await prisma.receiveRequest.create({
          data: {
            id: input.id,
            accountId: input.accountId,
            ...(input.amountAtomic === undefined
              ? {}
              : { amountAtomic: input.amountAtomic }),
            currency: input.currency,
            reference: input.reference,
            ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
            ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
          },
        })
        return toReceiveRequestRecord(request)
      } catch (error) {
        if (isPrismaUniqueConstraintError(error)) {
          throw new ConflictError('Receive reference is already in use')
        }
        throw error
      }
    },
    async findReceiveRequestForOwner(accountId, id) {
      const request = await prisma.receiveRequest.findFirst({
        where: { id, accountId },
      })
      return request === null ? null : toReceiveRequestRecord(request)
    },
    async listReceiveRequests(accountId) {
      const requests = await prisma.receiveRequest.findMany({
        where: { accountId },
        orderBy: { createdAt: 'desc' },
      })
      return requests.map(toReceiveRequestRecord)
    },
    async expireOpenReceiveRequests(accountId, now) {
      await prisma.receiveRequest.updateMany({
        where: { accountId, status: 'OPEN', expiresAt: { lte: now } },
        data: { status: 'EXPIRED' },
      })
    },
    async matchIncomingPayment(input): Promise<string | null> {
      return prisma.$transaction((transaction) =>
        matchIncomingPaymentInTransaction(transaction, input),
      )
    },
    async listActiveAccountSettlements() {
      const accounts = await prisma.agentAccount.findMany({
        where: { status: 'ACTIVE' },
        select: { id: true, solanaPublicKey: true },
      })
      return accounts.map((account) => ({
        accountId: account.id,
        solanaPublicKey: account.solanaPublicKey,
      }))
    },
    async getIncomingCursor(accountId, rail, address) {
      const cursor = await prisma.indexerCheckpoint.findUnique({
        where: { accountId_rail_address: { accountId, rail, address } },
      })
      return cursor === null ? null : cursor
    },
    async saveIncomingCursor(input) {
      await prisma.indexerCheckpoint.upsert({
        where: {
          accountId_rail_address: {
            accountId: input.accountId,
            rail: input.rail,
            address: input.address,
          },
        },
        create: { id: `idx_${randomBytes(16).toString('hex')}`, ...input },
        update: { cursorSignature: input.cursorSignature },
      })
    },
    async recordIncomingReconciliationIssue(input): Promise<void> {
      const now = new Date()
      await prisma.incomingReconciliationIssue.upsert({
        where: {
          accountId_signature: {
            accountId: input.accountId,
            signature: input.signature,
          },
        },
        create: {
          id: input.id,
          accountId: input.accountId,
          signature: input.signature,
          status: 'PENDING',
          reason: input.reason,
          firstSeenAt: now,
          nextRetryAt: now,
          retryCount: 0,
        },
        update: {
          reason: input.reason,
        },
      })
    },
    async claimIncomingReconciliationIssues(limit, now = new Date()) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new Error('Incoming reconciliation issue batch limit must be 1 to 100')
      }
      return prisma.$transaction(async (transaction) => {
        const issues = await transaction.$queryRaw<
          {
            id: string
            account_id: string
            account_public_key: string
            signature: string
            reason: string
            retry_count: number
          }[]
        >`
          SELECT issue.id,
                 issue.account_id,
                 account.solana_public_key AS account_public_key,
                 issue.signature,
                 issue.reason,
                 issue.retry_count
          FROM "incoming_reconciliation_issues" issue
          JOIN "agent_accounts" account ON account.id = issue.account_id
          WHERE issue.status = 'PENDING'
            AND issue.next_retry_at <= ${now}
          ORDER BY issue.next_retry_at ASC, issue.id ASC
          LIMIT ${limit}
          FOR UPDATE OF issue SKIP LOCKED
        `
        for (const issue of issues) {
          const retryCount = issue.retry_count + 1
          const backoffMilliseconds = Math.min(
            5 * 60_000,
            5_000 * 2 ** Math.min(retryCount - 1, 6),
          )
          await transaction.incomingReconciliationIssue.update({
            where: { id: issue.id },
            data: {
              lastTriedAt: now,
              nextRetryAt: new Date(now.getTime() + backoffMilliseconds),
              retryCount,
            },
          })
        }
        return issues.map((issue) => ({
          id: issue.id,
          accountId: issue.account_id,
          accountPublicKey: issue.account_public_key,
          signature: issue.signature,
          reason: issue.reason,
          retryCount: issue.retry_count + 1,
        }))
      })
    },
    async resolveIncomingReconciliationIssue(issueId, now = new Date()) {
      await prisma.incomingReconciliationIssue.updateMany({
        where: { id: issueId, status: 'PENDING' },
        data: { status: 'RESOLVED', resolvedAt: now },
      })
    },
    async updateIncomingReconciliationIssueReason(issueId, reason) {
      await prisma.incomingReconciliationIssue.updateMany({
        where: { id: issueId, status: 'PENDING' },
        data: { reason },
      })
    },
    async createIncomingPayment(input) {
      return prisma.$transaction(async (transaction) => {
        const existing = await transaction.incomingPayment.findUnique({
          where: {
            accountId_signature: {
              accountId: input.accountId,
              signature: input.signature,
            },
          },
        })
        if (existing !== null) {
          return { payment: toIncomingPaymentRecord(existing), created: false }
        }
        const incoming = await transaction.incomingPayment.create({
          data: {
            id: input.id,
            accountId: input.accountId,
            signature: input.signature,
            amountAtomic: input.amountAtomic,
            tokenAtomicUnits: input.tokenAtomicUnits ?? input.amountAtomic,
            tokenDecimals: input.tokenDecimals ?? 2,
            currency: input.currency,
            ...(input.sourceAddress === undefined
              ? {}
              : { sourceAddress: input.sourceAddress }),
            ...(input.reference === undefined ? {} : { reference: input.reference }),
            tokenAccount: input.tokenAccount,
            settlementMint: input.settlementMint,
            confirmedAt: input.confirmedAt,
          },
        })
        await matchIncomingPaymentInTransaction(transaction, {
          incomingPaymentId: incoming.id,
          accountId: input.accountId,
          amountAtomic: input.amountAtomic,
          reference: input.reference ?? null,
          confirmedAt: input.confirmedAt,
        })
        return {
          payment: toIncomingPaymentRecord(
            await transaction.incomingPayment.findUniqueOrThrow({
              where: { id: incoming.id },
            }),
          ),
          created: true,
        }
      })
    },
    async findIncomingPaymentForOwner(accountId, id) {
      const payment = await prisma.incomingPayment.findFirst({
        where: { id, accountId },
      })
      return payment === null ? null : toIncomingPaymentRecord(payment)
    },
    async listIncomingPayments(accountId) {
      const payments = await prisma.incomingPayment.findMany({
        where: { accountId },
        orderBy: { createdAt: 'desc' },
      })
      return payments.map(toIncomingPaymentRecord)
    },
    async listIncomingPaymentsPage(accountId, limit, cursor) {
      const payments = await prisma.incomingPayment.findMany({
        where: {
          accountId,
          ...(cursor === undefined
            ? {}
            : {
                OR: [
                  { createdAt: { lt: cursor.createdAt } },
                  { createdAt: cursor.createdAt, id: { lt: cursor.id } },
                ],
              }),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
      })
      return payments.map(toIncomingPaymentRecord)
    },
    async checkReadiness(): Promise<void> {
      await prisma.$queryRaw`SELECT 1`
    },
    async initializeRuntimeIdentity(input, validateLegacyCustody): Promise<void> {
      const value = JSON.stringify(input)
      await prisma.$transaction(async (transaction) => {
        await transaction.$queryRaw`
          SELECT pg_advisory_xact_lock(764895321) IS NULL AS locked
        `
        const existing = await transaction.runtimeMetadata.findUnique({
          where: { key: 'runtime_identity' },
        })
        if (existing === null) {
          let afterId: string | undefined
          while (true) {
            const accounts = await transaction.agentAccount.findMany({
              ...(afterId === undefined ? {} : { cursor: { id: afterId }, skip: 1 }),
              orderBy: { id: 'asc' },
              take: 100,
              select: {
                id: true,
                solanaPublicKey: true,
                encryptedSolanaSecret: true,
                encryptionNonce: true,
                encryptionAuthTag: true,
              },
            })
            if (accounts.length === 0) break
            if (validateLegacyCustody === undefined) {
              throw new Error(
                'Runtime financial identity is missing for a database with existing accounts; custody validation is required',
              )
            }
            for (const account of accounts) {
              await validateLegacyCustody({
                accountId: account.id,
                solanaPublicKey: account.solanaPublicKey,
                encryptedSolanaSecret: account.encryptedSolanaSecret,
                encryptionNonce: account.encryptionNonce,
                encryptionAuthTag: account.encryptionAuthTag,
              })
            }
            if (accounts.length < 100) break
            afterId = accounts.at(-1)!.id
          }
          await transaction.runtimeMetadata.create({
            data: { key: 'runtime_identity', value },
          })
          return
        }
        if (existing.value !== value) {
          throw new Error(
            'Runtime financial identity mismatch; configured rail, cluster, settlement mint, or custody key differs from the database',
          )
        }
      })
    },
    async disconnect(): Promise<void> {
      await prisma.$disconnect()
    },
  }
}

function toRecipientRecord(recipient: {
  id: string
  ownerAccountId: string
  managedAccountId: string | null
  displayName: string
  type: string
  createdAt: Date
  updatedAt: Date
  ownerAccount: { status: AgentAccountStatus }
  destinations: readonly {
    id: string
    rail: string
    type: string
    walletAddress: string
  }[]
}): RecipientRecord {
  return {
    id: recipient.id,
    ownerAccountId: recipient.ownerAccountId,
    displayName: recipient.displayName,
    type: recipient.type,
    managedAccountId: recipient.managedAccountId,
    ownerStatus: recipient.ownerAccount.status,
    destinations: recipient.destinations.map((destination) => ({
      id: destination.id,
      rail: destination.rail,
      type: destination.type,
      walletAddress: destination.walletAddress,
    })),
    createdAt: recipient.createdAt,
    updatedAt: recipient.updatedAt,
  }
}

function toPaymentRecord(payment: {
  id: string
  payerAccountId: string
  payerPublicKey: string | null
  recipientId: string | null
  kind: PaymentKind
  amountAtomic: bigint
  currency: string
  status: PaymentStatus
  description: string | null
  externalReference: string | null
  route: string | null
  createdAt: Date
  updatedAt: Date
  confirmedAt: Date | null
  failedAt: Date | null
  failureCode: string | null
  failureMessageSafe: string | null
  destinationRail: string | null
  destinationType: string | null
  destinationReference: string | null
  recipientManagedAccountId: string | null
  originalPaymentId: string | null
  counterpartyAccountId: string | null
  counterpartyAddress: string | null
  lastRecoveryAttemptAt: Date | null
  nextRecoveryAt: Date | null
  recoveryCount: number
  stuckSince: Date | null
}): PaymentRecord {
  return payment
}

function toReceiveRequestRecord(request: {
  id: string
  accountId: string
  amountAtomic: bigint | null
  currency: string
  reference: string
  status: ReceiveRequestStatus
  createdAt: Date
  updatedAt: Date
  expiresAt: Date | null
  paidAt: Date | null
  matchedIncomingPaymentId: string | null
}): ReceiveRequestRecord {
  return request
}

function toIncomingPaymentRecord(payment: {
  id: string
  accountId: string
  signature: string
  amountAtomic: bigint
  tokenAtomicUnits: bigint
  tokenDecimals: number
  currency: string
  sourceAddress: string | null
  reference: string | null
  tokenAccount: string
  settlementMint: string
  status: 'CONFIRMED'
  createdAt: Date
  confirmedAt: Date
  receiveRequestId: string | null
}): IncomingPaymentRecord {
  return payment
}

function toPaymentAttemptRecord(attempt: {
  id: string
  paymentId: string
  attemptNumber: number
  rail: string
  status: PaymentAttemptStatus
  railTransactionId: string | null
  serializedPayloadSafe: string | null
  durablePayload: string | null
  expectedExternalId: string | null
  recoveryMetadata: string | null
  confirmationMetadata: string | null
  createdAt: Date
  updatedAt: Date
}): PaymentAttemptRecord {
  return attempt
}

function isPrismaUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === 'P2002'
  )
}
