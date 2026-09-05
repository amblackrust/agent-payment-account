import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import {
  ConflictError,
  createMoney,
  ExternalRailError,
  type PaymentRail,
} from '@agent-payment/core'
import { createDatabaseClient, type AuthenticatedAccount } from '@agent-payment/db'
import { PaymentService } from './payments.js'

const databaseUrl = process.env.DATABASE_URL?.trim()

function id(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`
}

function railThatConfirms(): PaymentRail {
  return {
    name: 'SOLANA_SPL',
    canRoute: (request) => request.destination.rail === 'SOLANA_SPL',
    quote: async (request) => ({ rail: 'SOLANA_SPL', amount: request.amount }),
    prepare: async () => ({ rail: 'SOLANA_SPL', payloadSafe: '{"kind":"prepared"}' }),
    execute: async () => ({ status: 'CONFIRMED', railTransactionId: 'rail-tx-1' }),
    getStatus: async () => ({ status: 'CONFIRMED', railTransactionId: 'rail-tx-1' }),
  }
}

function railThatFails(): PaymentRail {
  return {
    ...railThatConfirms(),
    quote: async () => {
      throw new ExternalRailError('quote unavailable')
    },
  }
}

function railThatHasAmbiguousExecution(): PaymentRail {
  return {
    ...railThatConfirms(),
    prepare: async () => ({
      rail: 'SOLANA_SPL',
      payloadSafe: '{"kind":"prepared"}',
      durableExecution: {
        serializedTransactionBase64: 'signed-bytes',
        expectedTransactionId: 'transaction-signature',
        blockhash: 'blockhash',
        lastValidBlockHeight: 100n,
      },
    }),
    execute: async () => {
      throw new ExternalRailError(
        'transaction outcome is unknown',
        undefined,
        'AMBIGUOUS',
      )
    },
  }
}

describe.skipIf(databaseUrl === undefined || databaseUrl.length === 0)(
  'PaymentService with PostgreSQL',
  () => {
    it('shares the pay pipeline, canonicalizes idempotent requests and survives a new service instance', async () => {
      const database = createDatabaseClient(databaseUrl as string)
      const account = await createAccount(database)
      const recipient = await database.createRecipient({
        id: id('rcpt'),
        ownerAccountId: account.account.id,
        displayName: 'service recipient',
        type: 'BUSINESS',
        destination: {
          id: id('dest'),
          rail: 'SOLANA_SPL',
          type: 'SOLANA_SPL',
          walletAddress: 'wallet-address',
        },
      })
      const input = {
        recipientId: recipient.id,
        amount: '1.20',
        currency: 'USD',
        description: 'dataset access',
        externalReference: 'order-1',
      }

      try {
        const first = await new PaymentService(
          database,
          { getSettlementBalance: async () => ({ settled: createMoney('10.00') }) },
          [railThatConfirms()],
        ).createPayment(account, 'PAY', input, 'payment-key')
        const second = await new PaymentService(
          database,
          {
            getSettlementBalance: async () => {
              throw new Error('balance reader must not be called on replay')
            },
          },
          [],
        ).createPayment(account, 'PAY', { ...input, amount: '1.2' }, 'payment-key')

        expect(first.created).toBe(true)
        expect(first.payment.status).toBe('CONFIRMED')
        expect(first.payment.amountAtomic).toBe(120n)
        expect(second.created).toBe(false)
        expect(second.payment.id).toBe(first.payment.id)

        await expect(
          new PaymentService(
            database,
            {
              getSettlementBalance: async () => {
                throw new Error('balance reader must not be called on conflict')
              },
            },
            [],
          ).createPayment(account, 'PAY', { ...input, amount: '1.21' }, 'payment-key'),
        ).rejects.toThrow(ConflictError)
      } finally {
        await database.disconnect()
      }
    })

    it('releases a reservation when execution fails before submission', async () => {
      const database = createDatabaseClient(databaseUrl as string)
      const account = await createAccount(database)
      const recipient = await database.createRecipient({
        id: id('rcpt'),
        ownerAccountId: account.account.id,
        displayName: 'failure recipient',
        type: 'BUSINESS',
        destination: {
          id: id('dest'),
          rail: 'SOLANA_SPL',
          type: 'SOLANA_SPL',
          walletAddress: 'wallet-address',
        },
      })

      try {
        const failingService = new PaymentService(
          database,
          { getSettlementBalance: async () => ({ settled: createMoney('10.00') }) },
          [railThatFails()],
        )
        await expect(
          failingService.createPayment(
            account,
            'SEND',
            { recipientId: recipient.id, amount: '10.00', currency: 'USD' },
            'failed-payment-key',
          ),
        ).rejects.toThrow(ExternalRailError)

        const successful = await new PaymentService(
          database,
          { getSettlementBalance: async () => ({ settled: createMoney('10.00') }) },
          [railThatConfirms()],
        ).createPayment(
          account,
          'SEND',
          { recipientId: recipient.id, amount: '10.00', currency: 'USD' },
          'retry-after-failure-key',
        )
        expect(successful.payment.status).toBe('CONFIRMED')
      } finally {
        await database.disconnect()
      }
    })

    it('keeps an ambiguous execution in reconciliation with its reservation active', async () => {
      const database = createDatabaseClient(databaseUrl as string)
      const account = await createAccount(database)
      const recipient = await database.createRecipient({
        id: id('rcpt'),
        ownerAccountId: account.account.id,
        displayName: 'ambiguous recipient',
        type: 'BUSINESS',
        destination: {
          id: id('dest'),
          rail: 'SOLANA_SPL',
          type: 'SOLANA_SPL',
          walletAddress: 'wallet-address',
        },
      })

      try {
        const service = new PaymentService(
          database,
          { getSettlementBalance: async () => ({ settled: createMoney('10.00') }) },
          [railThatHasAmbiguousExecution()],
        )
        await expect(
          service.createPayment(
            account,
            'SEND',
            { recipientId: recipient.id, amount: '2.00', currency: 'USD' },
            'ambiguous-payment-key',
          ),
        ).rejects.toMatchObject({
          code: 'EXTERNAL_RAIL_FAILURE',
          kind: 'AMBIGUOUS',
          details: { payment_id: expect.any(String) },
        })

        const payment = await database.listPayments(account.account.id)
        const attempts = await database.listPaymentAttempts(payment[0]?.id ?? '')
        expect(payment[0]?.status).toBe('RECONCILING')
        expect(attempts[0]?.status).toBe('RECONCILING')
        expect(
          await database.getActiveOutgoingReservationAtomic(account.account.id, 'USD'),
        ).toBe(200n)

        const recovered = await service.getPayment(
          account.account.id,
          payment[0]?.id ?? '',
        )
        expect(recovered.status).toBe('CONFIRMED')
        expect(
          await database.getActiveOutgoingReservationAtomic(account.account.id, 'USD'),
        ).toBe(0n)
      } finally {
        await database.disconnect()
      }
    })

    it('serializes competing full-balance service requests and does not execute the rejected one', async () => {
      const database = createDatabaseClient(databaseUrl as string)
      const account = await createAccount(database)
      const recipient = await database.createRecipient({
        id: id('rcpt'),
        ownerAccountId: account.account.id,
        displayName: 'concurrency recipient',
        type: 'BUSINESS',
        destination: {
          id: id('dest'),
          rail: 'SOLANA_SPL',
          type: 'SOLANA_SPL',
          walletAddress: 'wallet-address',
        },
      })
      let executions = 0
      const submittingRail: PaymentRail = {
        ...railThatConfirms(),
        execute: async () => {
          executions += 1
          return { status: 'SUBMITTED', railTransactionId: 'submitted-tx' }
        },
      }
      const service = new PaymentService(
        database,
        { getSettlementBalance: async () => ({ settled: createMoney('10.00') }) },
        [submittingRail],
      )

      try {
        const results = await Promise.allSettled([
          service.createPayment(
            account,
            'SEND',
            { recipientId: recipient.id, amount: '10.00', currency: 'USD' },
            'competing-key-1',
          ),
          service.createPayment(
            account,
            'SEND',
            { recipientId: recipient.id, amount: '10.00', currency: 'USD' },
            'competing-key-2',
          ),
        ])
        const fulfilled = results.filter((result) => result.status === 'fulfilled')
        const rejected = results.filter((result) => result.status === 'rejected')

        expect(fulfilled).toHaveLength(1)
        expect(rejected).toHaveLength(1)
        expect(executions).toBe(1)
        expect(
          await database.getActiveOutgoingReservationAtomic(account.account.id, 'USD'),
        ).toBe(1000n)
      } finally {
        await database.disconnect()
      }
    })

    it('deduplicates concurrent identical service requests into one logical payment', async () => {
      const database = createDatabaseClient(databaseUrl as string)
      const account = await createAccount(database)
      const recipient = await database.createRecipient({
        id: id('rcpt'),
        ownerAccountId: account.account.id,
        displayName: 'duplicate recipient',
        type: 'BUSINESS',
        destination: {
          id: id('dest'),
          rail: 'SOLANA_SPL',
          type: 'SOLANA_SPL',
          walletAddress: 'wallet-address',
        },
      })
      let executions = 0
      const rail: PaymentRail = {
        ...railThatConfirms(),
        execute: async () => {
          executions += 1
          return { status: 'SUBMITTED', railTransactionId: 'duplicate-tx' }
        },
      }
      const service = new PaymentService(
        database,
        { getSettlementBalance: async () => ({ settled: createMoney('10.00') }) },
        [rail],
      )

      try {
        const results = await Promise.all([
          service.createPayment(
            account,
            'PAY',
            { recipientId: recipient.id, amount: '10.00', currency: 'USD' },
            'identical-key',
          ),
          service.createPayment(
            account,
            'PAY',
            { recipientId: recipient.id, amount: '10.00', currency: 'USD' },
            'identical-key',
          ),
        ])

        expect(results.map((result) => result.payment.id)).toEqual([
          results[0]?.payment.id,
          results[0]?.payment.id,
        ])
        expect(results.filter((result) => result.created)).toHaveLength(1)
        expect(executions).toBe(1)
        expect(
          await database.getActiveOutgoingReservationAtomic(account.account.id, 'USD'),
        ).toBe(1000n)
      } finally {
        await database.disconnect()
      }
    })
  },
)

async function createAccount(
  database: ReturnType<typeof createDatabaseClient>,
): Promise<AuthenticatedAccount> {
  const accountId = id('acct')
  const credentialId = id('cred')
  await database.createAgentAccount({
    id: accountId,
    name: 'payment-service-agent',
    solanaPublicKey: `${accountId}_public`,
    encryptedSolanaSecret: 'ciphertext',
    encryptionNonce: 'bm9uY2U=',
    encryptionAuthTag: 'dGFn',
    credentialId,
    keyHash: `${accountId}_hash`,
    keyPrefix: 'apa_integration',
  })
  const authenticated = await database.findAccountByCredentialHash(`${accountId}_hash`)
  if (authenticated === null) {
    throw new Error('Integration account was not created')
  }
  return authenticated
}
