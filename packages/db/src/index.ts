import { PrismaPg } from '@prisma/adapter-pg'
import {
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

export interface AccountRepository {
  createAgentAccount(input: CreateAgentAccountInput): Promise<StoredAgentAccount>
  findAccountByCredentialHash(keyHash: string): Promise<AuthenticatedAccount | null>
  markCredentialUsed(credentialId: string): Promise<void>
  revokeCredential(accountId: string, credentialId: string): Promise<boolean>
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

export type PaymentKind = 'PAY' | 'SEND'
export type PaymentStatus = 'CREATED' | 'ROUTING' | 'SUBMITTED' | 'CONFIRMED' | 'FAILED'
export type PaymentAttemptStatus =
  'CREATED' | 'PREPARED' | 'SUBMITTED' | 'CONFIRMED' | 'FAILED'
export type ReservationStatus = 'ACTIVE' | 'RELEASED'

export interface PaymentRecord {
  readonly id: string
  readonly payerAccountId: string
  readonly recipientId: string
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
}

export interface PaymentAttemptRecord {
  readonly id: string
  readonly paymentId: string
  readonly attemptNumber: number
  readonly rail: string
  readonly status: PaymentAttemptStatus
  readonly railTransactionId: string | null
  readonly serializedPayloadSafe: string | null
  readonly createdAt: Date
  readonly updatedAt: Date
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
  readonly recipientId: string
  readonly amountAtomic: bigint
  readonly currency: string
  readonly description?: string
  readonly externalReference?: string
  readonly route: string
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
  createPaymentAttempt(input: {
    readonly id: string
    readonly paymentId: string
    readonly attemptNumber: number
    readonly rail: string
    readonly status: PaymentAttemptStatus
    readonly serializedPayloadSafe?: string
  }): Promise<PaymentAttemptRecord>
  updatePaymentAttempt(
    attemptId: string,
    currentStatus: PaymentAttemptStatus,
    nextStatus: PaymentAttemptStatus,
    fields?: Readonly<{
      railTransactionId?: string | null
      serializedPayloadSafe?: string | null
    }>,
  ): Promise<PaymentAttemptRecord>
  releaseReservation(paymentId: string): Promise<void>
  findPaymentForOwner(
    ownerAccountId: string,
    paymentId: string,
  ): Promise<PaymentRecord | null>
  listPayments(ownerAccountId: string): Promise<readonly PaymentRecord[]>
}

export interface DatabaseClient
  extends
    AccountRepository,
    RecipientRepository,
    PaymentRepository,
    ReservationRepository {
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
    async createRecipient(input): Promise<RecipientRecord> {
      const recipient = await prisma.recipient.create({
        data: {
          id: input.id,
          ownerAccountId: input.ownerAccountId,
          displayName: input.displayName,
          type: input.type,
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
      const attempt = await prisma.paymentAttempt.create({
        data: {
          id: input.id,
          paymentId: input.paymentId,
          attemptNumber: input.attemptNumber,
          rail: input.rail,
          status: input.status,
          ...(input.serializedPayloadSafe === undefined
            ? {}
            : { serializedPayloadSafe: input.serializedPayloadSafe }),
        },
      })
      return toPaymentAttemptRecord(attempt)
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
  recipientId: string
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
}): PaymentRecord {
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
  createdAt: Date
  updatedAt: Date
}): PaymentAttemptRecord {
  return attempt
}
