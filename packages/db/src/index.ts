import { PrismaPg } from '@prisma/adapter-pg'
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

export interface DatabaseClient extends AccountRepository {
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
    async checkReadiness(): Promise<void> {
      await prisma.$queryRaw`SELECT 1`
    },
    async disconnect(): Promise<void> {
      await prisma.$disconnect()
    },
  }
}
