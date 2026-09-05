import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from './generated/client/client.js'

export interface DatabaseClient {
  checkReadiness(): Promise<void>
  disconnect(): Promise<void>
}

export function createDatabaseClient(databaseUrl: string): DatabaseClient {
  const adapter = new PrismaPg({ connectionString: databaseUrl })
  const prisma = new PrismaClient({ adapter })

  return {
    async checkReadiness(): Promise<void> {
      await prisma.$queryRaw`SELECT 1`
    },
    async disconnect(): Promise<void> {
      await prisma.$disconnect()
    },
  }
}
