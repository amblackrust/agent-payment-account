import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { ConflictError } from '@agent-payment/core'
import { createDatabaseClient } from './index.js'

const databaseUrl = process.env.DATABASE_URL?.trim()

describe.skipIf(databaseUrl === undefined || databaseUrl.length === 0)(
  'database account repository',
  () => {
    it('persists accounts, authenticates credentials, tracks use and revokes credentials', async () => {
      const database = createDatabaseClient(databaseUrl as string)
      const accountId = `acct_${randomUUID().replaceAll('-', '')}`
      const credentialId = `cred_${randomUUID().replaceAll('-', '')}`

      try {
        const created = await database.createAgentAccount({
          id: accountId,
          name: 'integration-agent',
          solanaPublicKey: `${accountId}_public`,
          encryptedSolanaSecret: 'ciphertext',
          encryptionNonce: 'bm9uY2U=',
          encryptionAuthTag: 'dGFn',
          credentialId,
          keyHash: `${accountId}_hash`,
          keyPrefix: 'apa_integration',
        })
        const authenticated = await database.findAccountByCredentialHash(
          `${accountId}_hash`,
        )

        expect(created.id).toBe(accountId)
        expect(authenticated?.account.id).toBe(accountId)
        expect(authenticated?.credential.id).toBe(credentialId)
        await database.markCredentialUsed(credentialId)
        expect(await database.revokeCredential(accountId, credentialId)).toBe(true)
        expect(await database.revokeCredential(accountId, credentialId)).toBe(false)
      } finally {
        await database.disconnect()
      }
    })

    it('serializes reservations and persists idempotency across concurrent calls', async () => {
      const database = createDatabaseClient(databaseUrl as string)
      const accountId = `acct_${randomUUID().replaceAll('-', '')}`
      const credentialId = `cred_${randomUUID().replaceAll('-', '')}`
      const recipientId = `rcpt_${randomUUID().replaceAll('-', '')}`
      const paymentId = `pay_${randomUUID().replaceAll('-', '')}`
      const reservationId = `resv_${randomUUID().replaceAll('-', '')}`
      const idempotencyId = `idem_${randomUUID().replaceAll('-', '')}`

      try {
        await database.createAgentAccount({
          id: accountId,
          name: 'payment-integration-agent',
          solanaPublicKey: `${accountId}_public`,
          encryptedSolanaSecret: 'ciphertext',
          encryptionNonce: 'bm9uY2U=',
          encryptionAuthTag: 'dGFn',
          credentialId,
          keyHash: `${accountId}_hash`,
          keyPrefix: 'apa_integration',
        })
        await database.createRecipient({
          id: recipientId,
          ownerAccountId: accountId,
          displayName: 'Integration recipient',
          type: 'BUSINESS',
          destination: {
            id: `dest_${randomUUID().replaceAll('-', '')}`,
            rail: 'SOLANA_SPL',
            type: 'SOLANA_SPL',
            walletAddress: 'wallet-address',
          },
        })

        const input = {
          paymentId,
          reservationId,
          idempotencyId,
          ownerAccountId: accountId,
          operation: 'SEND' as const,
          idempotencyKey: 'same-key',
          requestHash: 'a'.repeat(64),
          payerAccountId: accountId,
          recipientId,
          amountAtomic: 1000n,
          currency: 'USD',
          route: 'SOLANA_SPL',
          settledAtomic: 1000n,
        }
        const duplicateInput = {
          ...input,
          paymentId: `pay_${randomUUID().replaceAll('-', '')}`,
          reservationId: `resv_${randomUUID().replaceAll('-', '')}`,
          idempotencyId: `idem_${randomUUID().replaceAll('-', '')}`,
        }
        const duplicateResults = await Promise.all([
          database.createPaymentWithReservation(input),
          database.createPaymentWithReservation(duplicateInput),
        ])

        expect(duplicateResults.filter((result) => result.created)).toHaveLength(1)
        expect(duplicateResults[0]?.payment.id).toBe(duplicateResults[1]?.payment.id)

        await expect(
          database.createPaymentWithReservation({
            ...duplicateInput,
            paymentId: `pay_${randomUUID().replaceAll('-', '')}`,
            reservationId: `resv_${randomUUID().replaceAll('-', '')}`,
            idempotencyId: `idem_${randomUUID().replaceAll('-', '')}`,
            requestHash: 'b'.repeat(64),
          }),
        ).rejects.toThrow(ConflictError)

        const competingInput = {
          ...input,
          paymentId: `pay_${randomUUID().replaceAll('-', '')}`,
          reservationId: `resv_${randomUUID().replaceAll('-', '')}`,
          idempotencyId: `idem_${randomUUID().replaceAll('-', '')}`,
          idempotencyKey: 'competing-key',
        }
        await expect(
          database.createPaymentWithReservation(competingInput),
        ).rejects.toThrow('Insufficient funds')
      } finally {
        await database.disconnect()
      }
    })
  },
)
