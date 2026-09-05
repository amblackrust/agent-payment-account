import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import {
  ConflictError,
  createMoney,
  ExternalRailError,
  RefundNotSupportedError,
  ValidationError,
  type PaymentRail,
} from '@agent-payment/core'
import { createDatabaseClient, type AuthenticatedAccount } from '@agent-payment/db'
import { PaymentService } from './payments.js'
import { TransactionService } from './transactions.js'

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
        serializedPayload: 'signed-bytes',
        expectedExternalId: 'transaction-signature',
        recoveryMetadata: JSON.stringify({
          version: 1,
          blockhash: 'blockhash',
          lastValidBlockHeight: '100',
          payerOwner: 'payer-owner',
          recipientOwner: 'recipient-owner',
          payerAta: 'payer-ata',
          recipientAta: 'recipient-ata',
          settlementMint: 'settlement-mint',
          tokenDecimals: 6,
          tokenAmount: '2000000',
          createsRecipientAta: false,
        }),
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

function railThatConfirmsDurably(executions: { count: number }): PaymentRail {
  return {
    name: 'SOLANA_SPL',
    canRoute: (request) => request.destination.rail === 'SOLANA_SPL',
    quote: async (request) => ({ rail: 'SOLANA_SPL', amount: request.amount }),
    prepare: async () => ({
      rail: 'SOLANA_SPL',
      durableExecution: {
        serializedPayload: 'signed-bytes',
        expectedExternalId: 'transaction-signature',
        recoveryMetadata: JSON.stringify({ version: 1 }),
      },
    }),
    execute: async () => {
      executions.count += 1
      return {
        status: 'CONFIRMED',
        railTransactionId: 'transaction-signature',
      }
    },
    getStatus: async () => ({
      status: 'CONFIRMED',
      railTransactionId: 'transaction-signature',
    }),
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

    it('keeps the reservation recoverable when confirmed finalization persistence fails', async () => {
      const database = createDatabaseClient(databaseUrl as string)
      const account = await createAccount(database)
      const recipient = await database.createRecipient({
        id: id('rcpt'),
        ownerAccountId: account.account.id,
        displayName: 'finalization recipient',
        type: 'BUSINESS',
        destination: {
          id: id('dest'),
          rail: 'SOLANA_SPL',
          type: 'SOLANA_SPL',
          walletAddress: 'wallet-address',
        },
      })
      const executions = { count: 0 }
      const rail = railThatConfirmsDurably(executions)
      const failingRepository = {
        ...database,
        finalizeConfirmedPayment: async () => {
          throw new Error('simulated finalization outage')
        },
      }

      try {
        await expect(
          new PaymentService(
            failingRepository,
            { getSettlementBalance: async () => ({ settled: createMoney('10.00') }) },
            [rail],
          ).createPayment(
            account,
            'SEND',
            { recipientId: recipient.id, amount: '2.00', currency: 'USD' },
            'finalization-outage-key',
          ),
        ).rejects.toMatchObject({
          code: 'EXTERNAL_RAIL_FAILURE',
          kind: 'AMBIGUOUS',
        })

        const pending = (await database.listPayments(account.account.id))[0]
        expect(pending?.status).toBe('RECONCILING')
        expect(
          await database.getActiveOutgoingReservationAtomic(account.account.id, 'USD'),
        ).toBe(200n)

        const recovered = await new PaymentService(
          database,
          { getSettlementBalance: async () => ({ settled: createMoney('0.00') }) },
          [rail],
        ).getPayment(account.account.id, pending?.id ?? '')

        expect(recovered.status).toBe('CONFIRMED')
        expect(executions.count).toBe(1)
        expect(
          await database.getActiveOutgoingReservationAtomic(account.account.id, 'USD'),
        ).toBe(0n)
      } finally {
        await database.disconnect()
      }
    })

    it('rejects malformed rail destinations before creating a reservation', async () => {
      const database = createDatabaseClient(databaseUrl as string)
      const account = await createAccount(database)
      const recipient = await database.createRecipient({
        id: id('rcpt'),
        ownerAccountId: account.account.id,
        displayName: 'invalid destination recipient',
        type: 'BUSINESS',
        destination: {
          id: id('dest'),
          rail: 'SOLANA_SPL',
          type: 'SOLANA_SPL',
          walletAddress: 'malformed-wallet-address',
        },
      })
      const rail: PaymentRail = {
        ...railThatConfirms(),
        validateDestination: () => {
          throw new ValidationError('Recipient Solana wallet address is invalid')
        },
      }

      try {
        await expect(
          new PaymentService(
            database,
            { getSettlementBalance: async () => ({ settled: createMoney('10.00') }) },
            [rail],
          ).createPayment(
            account,
            'SEND',
            { recipientId: recipient.id, amount: '1.00', currency: 'USD' },
            'invalid-destination-key',
          ),
        ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
        expect(await database.listPayments(account.account.id)).toHaveLength(0)
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

    it('supports only managed-account refunds and applies refund idempotency', async () => {
      const database = createDatabaseClient(databaseUrl as string)
      const payer = await createAccount(database)
      const recipientAccount = await createAccount(database)
      const recipient = await database.createRecipient({
        id: id('rcpt'),
        ownerAccountId: payer.account.id,
        managedAccountId: recipientAccount.account.id,
        displayName: 'managed recipient',
        type: 'AGENT',
        destination: {
          id: id('dest'),
          rail: 'SOLANA_SPL',
          type: 'SOLANA_SPL',
          walletAddress: recipientAccount.account.solanaPublicKey,
        },
      })
      const service = new PaymentService(
        database,
        { getSettlementBalance: async () => ({ settled: createMoney('10.00') }) },
        [railThatConfirms()],
      )

      try {
        const original = await service.createPayment(
          payer,
          'PAY',
          { recipientId: recipient.id, amount: '2.00', currency: 'USD' },
          'managed-payment',
        )
        const refund = await service.createRefund(
          recipientAccount,
          { originalPaymentId: original.payment.id, amount: '1.25', currency: 'USD' },
          'refund-key',
        )
        const replay = await new PaymentService(
          database,
          {
            getSettlementBalance: async () => {
              throw new Error('replay must not read balance')
            },
          },
          [],
        ).createRefund(
          recipientAccount,
          { originalPaymentId: original.payment.id, amount: '1.25', currency: 'USD' },
          'refund-key',
        )

        expect(refund.payment.kind).toBe('REFUND')
        expect(refund.payment.status).toBe('CONFIRMED')
        expect(refund.payment.recipientId).toBeNull()
        expect(refund.payment.counterpartyAccountId).toBe(payer.account.id)
        expect(refund.payment.counterpartyAddress).toBe(payer.account.solanaPublicKey)
        expect(replay.created).toBe(false)
        expect(replay.payment.id).toBe(refund.payment.id)
        const recipientHistory = await new TransactionService(
          database,
        ).listTransactions(recipientAccount.account.id)
        const refundHistory = recipientHistory.find(
          (transaction) => transaction.id === refund.payment.id,
        )
        expect(refundHistory?.counterparty).toMatchObject({
          recipient_id: null,
          account_id: payer.account.id,
          address: payer.account.solanaPublicKey,
        })
        const payerHistory = await new TransactionService(database).listTransactions(
          payer.account.id,
        )
        const originalHistory = payerHistory.find(
          (transaction) => transaction.id === original.payment.id,
        )
        expect(originalHistory?.counterparty).toMatchObject({
          account_id: recipientAccount.account.id,
          address: recipientAccount.account.solanaPublicKey,
        })
        await expect(
          service.createRefund(
            recipientAccount,
            { originalPaymentId: original.payment.id, amount: '0.76', currency: 'USD' },
            'another-refund',
          ),
        ).rejects.toThrow(ConflictError)
        await expect(
          service.createRefund(
            payer,
            { originalPaymentId: original.payment.id, amount: '0.01', currency: 'USD' },
            'payer-refund',
          ),
        ).rejects.toThrow(RefundNotSupportedError)
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
