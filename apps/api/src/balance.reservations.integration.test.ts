import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { createDatabaseClient, type AuthenticatedAccount } from '@agent-payment/db'
import type { SolanaRail } from '@agent-payment/solana-rail'
import { createMoney } from '@agent-payment/core'
import { AccountService } from './accounts.js'
import { buildApp } from './app.js'
import type { AppConfig } from './config.js'
import { hashApiKey } from './auth.js'
import { WalletSecretCipher } from './custody.js'

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

describe.skipIf(databaseUrl === undefined || databaseUrl.length === 0)(
  'balance reservations with PostgreSQL',
  () => {
    it('counts only active reservations for the owner and clamps stale available balance', async () => {
      const database = createDatabaseClient(databaseUrl as string)
      const rawKey = id('api-key')
      const account = await createAccount(database, rawKey)
      const recipient = await database.createRecipient({
        id: id('rcpt'),
        ownerAccountId: account.account.id,
        displayName: 'balance recipient',
        type: 'BUSINESS',
        destination: {
          id: id('dest'),
          rail: 'SOLANA_SPL',
          type: 'SOLANA_SPL',
          walletAddress: 'wallet-address',
        },
      })
      const otherRawKey = id('other-key')
      const otherAccount = await createAccount(database, otherRawKey)
      const otherRecipient = await database.createRecipient({
        id: id('rcpt'),
        ownerAccountId: otherAccount.account.id,
        displayName: 'other balance recipient',
        type: 'BUSINESS',
        destination: {
          id: id('dest'),
          rail: 'SOLANA_SPL',
          type: 'SOLANA_SPL',
          walletAddress: 'other-wallet-address',
        },
      })
      const first = await database.createPaymentWithReservation({
        paymentId: id('pay'),
        reservationId: id('resv'),
        idempotencyId: id('idem'),
        ownerAccountId: account.account.id,
        operation: 'SEND',
        idempotencyKey: id('key'),
        requestHash: 'a'.repeat(64),
        payerAccountId: account.account.id,
        recipientId: recipient.id,
        amountAtomic: 250n,
        currency: 'USD',
        route: 'SOLANA_SPL',
        settledAtomic: 1000n,
      })
      await database.createPaymentWithReservation({
        paymentId: id('pay'),
        reservationId: id('resv'),
        idempotencyId: id('idem'),
        ownerAccountId: otherAccount.account.id,
        operation: 'SEND',
        idempotencyKey: id('key'),
        requestHash: 'd'.repeat(64),
        payerAccountId: otherAccount.account.id,
        recipientId: otherRecipient.id,
        amountAtomic: 900n,
        currency: 'USD',
        route: 'SOLANA_SPL',
        settledAtomic: 1000n,
      })
      const released = await database.createPaymentWithReservation({
        paymentId: id('pay'),
        reservationId: id('resv'),
        idempotencyId: id('idem'),
        ownerAccountId: account.account.id,
        operation: 'SEND',
        idempotencyKey: id('key'),
        requestHash: 'b'.repeat(64),
        payerAccountId: account.account.id,
        recipientId: recipient.id,
        amountAtomic: 100n,
        currency: 'USD',
        route: 'SOLANA_SPL',
        settledAtomic: 1000n,
      })
      await database.releaseReservation(released.payment.id)

      const app = buildBalanceApp(database, account)
      try {
        const normal = await app.inject({
          method: 'GET',
          url: '/v1/balance',
          headers: { authorization: `Bearer ${rawKey}` },
        })
        expect(normal.statusCode).toBe(200)
        expect(normal.json()).toMatchObject({
          settled: '10.00',
          pending_outgoing: '2.50',
          available: '7.50',
        })

        await database.createPaymentWithReservation({
          paymentId: id('pay'),
          reservationId: id('resv'),
          idempotencyId: id('idem'),
          ownerAccountId: account.account.id,
          operation: 'SEND',
          idempotencyKey: id('key'),
          requestHash: 'c'.repeat(64),
          payerAccountId: account.account.id,
          recipientId: recipient.id,
          amountAtomic: 800n,
          currency: 'USD',
          route: 'SOLANA_SPL',
          settledAtomic: 2000n,
        })
        const stale = await app.inject({
          method: 'GET',
          url: '/v1/balance',
          headers: { authorization: `Bearer ${rawKey}` },
        })
        expect(stale.json()).toMatchObject({
          settled: '10.00',
          pending_outgoing: '10.50',
          available: '0.00',
        })
        expect(first.created).toBe(true)
      } finally {
        await app.close()
        await database.disconnect()
      }
    })
  },
)

function buildBalanceApp(
  database: ReturnType<typeof createDatabaseClient>,
  _account: AuthenticatedAccount,
) {
  const solanaRail: SolanaRail = {
    getSettlementBalance: async () => ({
      currency: 'USD',
      settled: createMoney('10.00'),
      tokenAtomicUnits: 10_000_000n,
      tokenDecimals: 6,
      ata: 'ata',
      ataStatus: 'PRESENT',
    }),
    getReceiveDestination: async (owner) => ({
      owner,
      tokenAccount: 'token-account',
      settlementMint: 'settlement-mint',
    }),
  }
  return buildApp({
    config: testConfig,
    readinessDependency: database,
    accountRepository: database,
    accountService: new AccountService(
      database,
      new WalletSecretCipher(masterKey),
      solanaRail,
    ),
    solanaRail,
    reservationRepository: database,
  })
}

async function createAccount(
  database: ReturnType<typeof createDatabaseClient>,
  rawKey: string,
): Promise<AuthenticatedAccount> {
  const accountId = id('acct')
  await database.createAgentAccount({
    id: accountId,
    name: 'balance-agent',
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
    throw new Error('Balance integration account was not created')
  }
  return account
}
