import { randomBytes } from 'node:crypto'
import { PrismaPg } from '@prisma/adapter-pg'
import {
  assertPaymentAttemptStatusTransition,
  assertPaymentStatusTransition,
  ConflictError,
  InsufficientFundsError,
  RecipientResolutionError,
} from '@agent-payment/core'
import { PrismaClient } from './generated/client/client.js'

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
}

export type PaymentKind = 'PAY' | 'SEND' | 'REFUND'
export type PaymentStatus =
  'CREATED' | 'ROUTING' | 'SUBMITTED' | 'RECONCILING' | 'CONFIRMED' | 'FAILED'
export type PaymentAttemptStatus =
  'CREATED' | 'PREPARED' | 'SUBMITTED' | 'RECONCILING' | 'CONFIRMED' | 'FAILED'
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
  readonly expiresAt?: Date
}

export interface CreateIncomingPaymentInput {
  readonly id: string
  readonly accountId: string
  readonly signature: string
  readonly amountAtomic: bigint
  readonly currency: string
  readonly sourceAddress?: string
  readonly reference?: string
  readonly tokenAccount: string
  readonly settlementMint: string
  readonly confirmedAt: Date
}

export interface ReceiveRepository {
  createReceiveRequest(input: CreateReceiveRequestInput): Promise<ReceiveRequestRecord>
  findReceiveRequestForOwner(
    accountId: string,
    id: string,
  ): Promise<ReceiveRequestRecord | null>
  listReceiveRequests(accountId: string): Promise<readonly ReceiveRequestRecord[]>
  matchIncomingPayment(input: {
    readonly incomingPaymentId: string
    readonly accountId: string
    readonly amountAtomic: bigint
    readonly reference: string | null
  }): Promise<string | null>
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
  createReplacementPaymentAttempt(input: {
    readonly attemptId: string
    readonly paymentId: string
    readonly previousAttemptId: string
    readonly rail: string
    readonly durablePayload: string
    readonly expectedExternalId: string
    readonly recoveryMetadata: string
    readonly serializedPayloadSafe?: string
  }): Promise<{ readonly attempt: PaymentAttemptRecord; readonly created: boolean }>
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
  createPaymentAttempt(input: CreatePaymentAttemptInput): Promise<PaymentAttemptRecord>
  getOrCreatePaymentAttempt(
    input: CreatePaymentAttemptInput,
  ): Promise<{ readonly attempt: PaymentAttemptRecord; readonly created: boolean }>
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
  releaseReservation(paymentId: string): Promise<void>
  findPaymentForOwner(
    ownerAccountId: string,
    paymentId: string,
  ): Promise<PaymentRecord | null>
  listPayments(ownerAccountId: string): Promise<readonly PaymentRecord[]>
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
  findAccountCustody(accountId: string): Promise<AccountCustodyRecord | null>
  findAccountPublicKey(accountId: string): Promise<string | null>
  checkReadiness(): Promise<void>
  disconnect(): Promise<void>
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
    async createPaymentAttempt(input): Promise<PaymentAttemptRecord> {
      const attempt = await prisma.$transaction(async (transaction) => {
        await transaction.$queryRaw`
          SELECT id FROM "payments" WHERE id = ${input.paymentId} FOR UPDATE
        `
        const latest = await transaction.paymentAttempt.findFirst({
          where: { paymentId: input.paymentId },
          orderBy: { attemptNumber: 'desc' },
          select: { attemptNumber: true },
        })
        return transaction.paymentAttempt.create({
          data: {
            id: input.id,
            paymentId: input.paymentId,
            attemptNumber: (latest?.attemptNumber ?? 0) + 1,
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
      })
      return toPaymentAttemptRecord(attempt)
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
    async createReplacementPaymentAttempt(input) {
      return prisma.$transaction(async (transaction) => {
        await transaction.$queryRaw`
          SELECT id FROM "payments" WHERE id = ${input.paymentId} FOR UPDATE
        `
        const latest = await transaction.paymentAttempt.findFirst({
          where: { paymentId: input.paymentId },
          orderBy: { attemptNumber: 'desc' },
        })
        if (latest === null || latest.id !== input.previousAttemptId) {
          if (latest === null) {
            throw new ConflictError('Payment attempt history is unavailable')
          }
          return { attempt: toPaymentAttemptRecord(latest), created: false }
        }
        const replacement = await transaction.paymentAttempt.create({
          data: {
            id: input.attemptId,
            paymentId: input.paymentId,
            attemptNumber: latest.attemptNumber + 1,
            rail: input.rail,
            status: 'PREPARED',
            ...(input.serializedPayloadSafe === undefined
              ? {}
              : { serializedPayloadSafe: input.serializedPayloadSafe }),
            durablePayload: input.durablePayload,
            expectedExternalId: input.expectedExternalId,
            recoveryMetadata: input.recoveryMetadata,
          },
        })
        return { attempt: toPaymentAttemptRecord(replacement), created: true }
      })
    },
    async finalizeConfirmedPayment(input): Promise<PaymentRecord> {
      if (input.expectedAttemptStatus === 'PREPARED') {
        assertPaymentAttemptStatusTransition('PREPARED', 'SUBMITTED')
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
        if (attemptStatus === 'PREPARED') {
          const submittedAttempt = await transaction.paymentAttempt.updateMany({
            where: { id: input.attemptId, status: 'PREPARED' },
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
    async findPaymentForRefund(accountId, paymentId): Promise<PaymentRecord | null> {
      const payment = await prisma.payment.findFirst({ where: { id: paymentId } })
      if (payment === null || payment.recipientManagedAccountId !== accountId) {
        return null
      }
      return toPaymentRecord(payment)
    },
    async createReceiveRequest(input): Promise<ReceiveRequestRecord> {
      const request = await prisma.receiveRequest.create({
        data: {
          id: input.id,
          accountId: input.accountId,
          ...(input.amountAtomic === undefined
            ? {}
            : { amountAtomic: input.amountAtomic }),
          currency: input.currency,
          reference: input.reference,
          ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
        },
      })
      return toReceiveRequestRecord(request)
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
      return prisma.$transaction(async (transaction) => {
        if (input.reference === null) {
          return null
        }
        await transaction.receiveRequest.updateMany({
          where: {
            accountId: input.accountId,
            status: 'OPEN',
            expiresAt: { lte: new Date() },
          },
          data: { status: 'EXPIRED' },
        })
        const request = await transaction.receiveRequest.findFirst({
          where: {
            accountId: input.accountId,
            reference: input.reference,
            status: 'OPEN',
            AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }],
            OR: [{ amountAtomic: null }, { amountAtomic: input.amountAtomic }],
          },
          orderBy: { createdAt: 'asc' },
        })
        if (request === null) {
          return null
        }
        const result = await transaction.receiveRequest.updateMany({
          where: { id: request.id, status: 'OPEN' },
          data: {
            status: 'PAID',
            paidAt: new Date(),
            matchedIncomingPaymentId: input.incomingPaymentId,
          },
        })
        return result.count === 1 ? request.id : null
      })
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
        await transaction.receiveRequest.updateMany({
          where: {
            accountId: input.accountId,
            status: 'OPEN',
            expiresAt: { lte: input.confirmedAt },
          },
          data: { status: 'EXPIRED' },
        })
        const request =
          input.reference === undefined
            ? null
            : await transaction.receiveRequest.findFirst({
                where: {
                  accountId: input.accountId,
                  reference: input.reference,
                  status: 'OPEN',
                  AND: [
                    { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
                  ],
                  OR: [{ amountAtomic: null }, { amountAtomic: input.amountAtomic }],
                },
                orderBy: { createdAt: 'asc' },
              })
        if (request !== null) {
          await transaction.receiveRequest.update({
            where: { id: request.id },
            data: {
              status: 'PAID',
              paidAt: input.confirmedAt,
              matchedIncomingPaymentId: incoming.id,
            },
          })
          await transaction.incomingPayment.update({
            where: { id: incoming.id },
            data: { receiveRequestId: request.id },
          })
        }
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
    async checkReadiness(): Promise<void> {
      await prisma.$queryRaw`SELECT 1`
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
