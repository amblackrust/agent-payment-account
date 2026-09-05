import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { createMoney, type PaymentRail } from '@agent-payment/core'
import { createDatabaseClient, type AuthenticatedAccount } from '@agent-payment/db'
import type { SolanaRail } from '@agent-payment/solana-rail'
import { AccountService } from './accounts.js'
import { buildApp } from './app.js'
import type { AppConfig } from './config.js'
import { hashApiKey } from './auth.js'
import { WalletSecretCipher } from './custody.js'
import { PaymentService } from './payments.js'
import { RecipientService } from './recipients.js'

const databaseUrl = process.env.DATABASE_URL?.trim()
const masterKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

const testConfig: AppConfig = {
  databaseUrl: databaseUrl ?? 'postgresql://postgres:postgres@localhost:5432/test',
  port: 3000,
  nodeEnv: 'test',
  adminApiKey: 'test-admin-key',
  solanaRpcUrl: 'http://127.0.0.1:8899',
  solanaCluster: 'localnet',
  solanaSettlementMint: 'test-mint',
  solanaFeePayerSecret: 'test-fee-payer-secret',
  walletMasterKey: masterKey,
  allowMainnet: false,
}

function id(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`
}

function paymentRail(): PaymentRail {
  return {
    name: 'SOLANA_SPL',
    canRoute: (request) => request.destination.rail === 'SOLANA_SPL',
    quote: async (request) => ({ rail: 'SOLANA_SPL', amount: request.amount }),
    prepare: async () => ({ rail: 'SOLANA_SPL' }),
    execute: async () => ({
      status: 'CONFIRMED',
      railTransactionId: 'test-transaction',
    }),
    getStatus: async () => ({
      status: 'CONFIRMED',
      railTransactionId: 'test-transaction',
    }),
  }
}

describe.skipIf(databaseUrl === undefined || databaseUrl.length === 0)(
  'payment HTTP API with PostgreSQL',
  () => {
    it('scopes recipients and payments to the authenticated account and honors idempotency', async () => {
      const database = createDatabaseClient(databaseUrl as string)
      const rawKey = id('api-key')
      const account = await createAccount(database, rawKey)
      const solanaRail: SolanaRail = {
        getSettlementBalance: async () => {
          throw new Error('not used')
        },
        getReceiveDestination: async (owner) => ({
          owner,
          tokenAccount: 'token-account',
          settlementMint: 'settlement-mint',
        }),
      }
      const app = buildApp({
        config: testConfig,
        readinessDependency: database,
        accountRepository: database,
        accountService: new AccountService(
          database,
          new WalletSecretCipher(masterKey),
          solanaRail,
        ),
        solanaRail,
        recipientService: new RecipientService(database),
        paymentService: new PaymentService(
          database,
          { getSettlementBalance: async () => ({ settled: createMoney('10.00') }) },
          [paymentRail()],
        ),
      })

      try {
        const authHeaders = { authorization: `Bearer ${rawKey}` }
        const missingKey = await app.inject({
          method: 'POST',
          url: '/v1/send',
          headers: authHeaders,
          payload: { recipient_id: 'rcpt_missing', amount: '1.00', currency: 'USD' },
        })
        expect(missingKey.statusCode).toBe(400)

        const recipientResponse = await app.inject({
          method: 'POST',
          url: '/v1/recipients',
          headers: authHeaders,
          payload: {
            display_name: 'API recipient',
            type: 'BUSINESS',
            destination: { type: 'SOLANA_SPL', wallet_address: 'wallet-address' },
          },
        })
        expect(recipientResponse.statusCode).toBe(201)
        const recipient = recipientResponse.json<{ id: string }>()

        const first = await app.inject({
          method: 'POST',
          url: '/v1/pay',
          headers: { ...authHeaders, 'idempotency-key': 'http-key' },
          payload: {
            recipient_id: recipient.id,
            amount: '1.2',
            currency: 'USD',
            external_reference: 'order-1',
            description: 'dataset access',
          },
        })
        const duplicate = await app.inject({
          method: 'POST',
          url: '/v1/pay',
          headers: { ...authHeaders, 'idempotency-key': 'http-key' },
          payload: {
            description: 'dataset access',
            currency: 'USD',
            amount: '1.20',
            external_reference: 'order-1',
            recipient_id: recipient.id,
          },
        })
        const payments = await app.inject({
          method: 'GET',
          url: '/v1/payments',
          headers: authHeaders,
        })

        expect(first.statusCode).toBe(201)
        expect(first.json().amount).toBe('1.20')
        expect(first.json().status).toBe('CONFIRMED')
        expect(duplicate.statusCode).toBe(200)
        expect(duplicate.json().id).toBe(first.json().id)
        expect(payments.statusCode).toBe(200)
        expect(payments.json().payments).toHaveLength(1)
        expect(account.account.id).toMatch(/^acct_/)
      } finally {
        await app.close()
        await database.disconnect()
      }
    })

    it('rejects an unknown agent credential before reaching payment routes', async () => {
      const database = createDatabaseClient(databaseUrl as string)
      const solanaRail: SolanaRail = {
        getSettlementBalance: async () => {
          throw new Error('not used')
        },
        getReceiveDestination: async () => ({
          owner: 'owner',
          tokenAccount: 'token-account',
          settlementMint: 'settlement-mint',
        }),
      }
      const app = buildApp({
        config: testConfig,
        readinessDependency: database,
        accountRepository: database,
        accountService: new AccountService(
          database,
          new WalletSecretCipher(masterKey),
          solanaRail,
        ),
        solanaRail,
        recipientService: new RecipientService(database),
        paymentService: new PaymentService(
          database,
          { getSettlementBalance: async () => ({ settled: createMoney('10.00') }) },
          [paymentRail()],
        ),
      })

      try {
        const response = await app.inject({
          method: 'GET',
          url: '/v1/payments',
          headers: { authorization: 'Bearer unknown-key' },
        })
        expect(response.statusCode).toBe(401)
      } finally {
        await app.close()
        await database.disconnect()
      }
    })
  },
)

async function createAccount(
  database: ReturnType<typeof createDatabaseClient>,
  rawKey: string,
): Promise<AuthenticatedAccount> {
  const accountId = id('acct')
  await database.createAgentAccount({
    id: accountId,
    name: 'payment-http-agent',
    solanaPublicKey: `${accountId}_public`,
    encryptedSolanaSecret: 'ciphertext',
    encryptionNonce: 'bm9uY2U=',
    encryptionAuthTag: 'dGFn',
    credentialId: id('cred'),
    keyHash: hashApiKey(rawKey),
    keyPrefix: 'apa_integration',
  })
  const account = await database.findAccountByCredentialHash(hashApiKey(rawKey))
  if (account === null) {
    throw new Error('HTTP integration account was not created')
  }
  return account
}
