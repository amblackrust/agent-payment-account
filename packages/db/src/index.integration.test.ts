import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { ConflictError, RecipientResolutionError } from '@agent-payment/core'
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

    it('rolls back every recipient field when the destination target is invalid', async () => {
      const database = createDatabaseClient(databaseUrl as string)
      const accountId = `acct_${randomUUID().replaceAll('-', '')}`
      const credentialId = `cred_${randomUUID().replaceAll('-', '')}`
      const recipientId = `rcpt_${randomUUID().replaceAll('-', '')}`
      const destinationId = `dest_${randomUUID().replaceAll('-', '')}`

      try {
        await database.createAgentAccount({
          id: accountId,
          name: 'recipient-atomic-agent',
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
          displayName: 'original name',
          type: 'BUSINESS',
          destination: {
            id: destinationId,
            rail: 'SOLANA_SPL',
            type: 'SOLANA_SPL',
            walletAddress: 'original-wallet',
          },
        })

        await expect(
          database.updateRecipient({
            id: recipientId,
            ownerAccountId: accountId,
            displayName: 'must not persist',
            destination: {
              id: `dest_${randomUUID().replaceAll('-', '')}`,
              rail: 'SOLANA_SPL',
              type: 'SOLANA_SPL',
              walletAddress: 'new-wallet',
            },
          }),
        ).rejects.toThrow(RecipientResolutionError)

        const recipient = await database.findRecipientForOwner(accountId, recipientId)
        expect(recipient?.displayName).toBe('original name')
        expect(recipient?.destinations[0]?.walletAddress).toBe('original-wallet')
      } finally {
        await database.disconnect()
      }
    })

    it('matches receive references atomically and deduplicates a signature per account', async () => {
      const database = createDatabaseClient(databaseUrl as string)
      const accountId = `acct_${randomUUID().replaceAll('-', '')}`
      const credentialId = `cred_${randomUUID().replaceAll('-', '')}`
      const receiveId = `recv_${randomUUID().replaceAll('-', '')}`
      const incomingId = `in_${randomUUID().replaceAll('-', '')}`
      try {
        await database.createAgentAccount({
          id: accountId,
          name: 'receive-integration-agent',
          solanaPublicKey: `${accountId}_public`,
          encryptedSolanaSecret: 'ciphertext',
          encryptionNonce: 'bm9uY2U=',
          encryptionAuthTag: 'dGFn',
          credentialId,
          keyHash: `${accountId}_hash`,
          keyPrefix: 'apa_integration',
        })
        const request = await database.createReceiveRequest({
          id: receiveId,
          accountId,
          amountAtomic: 1250n,
          currency: 'USD',
          reference: 'invoice-42',
        })
        await expect(
          database.createReceiveRequest({
            id: `recv_${randomUUID().replaceAll('-', '')}`,
            accountId,
            amountAtomic: 1250n,
            currency: 'USD',
            reference: 'invoice-42',
          }),
        ).rejects.toThrow(ConflictError)
        const first = await database.createIncomingPayment({
          id: incomingId,
          accountId,
          signature: 'chain-signature-42',
          amountAtomic: 1250n,
          currency: 'USD',
          sourceAddress: 'source-wallet',
          reference: request.reference,
          tokenAccount: 'destination-token-account',
          settlementMint: 'settlement-mint',
          confirmedAt: new Date(),
        })
        const duplicate = await database.createIncomingPayment({
          id: `in_${randomUUID().replaceAll('-', '')}`,
          accountId: first.payment.accountId,
          signature: first.payment.signature,
          amountAtomic: first.payment.amountAtomic,
          currency: first.payment.currency,
          ...(first.payment.sourceAddress === null
            ? {}
            : { sourceAddress: first.payment.sourceAddress }),
          ...(first.payment.reference === null
            ? {}
            : { reference: first.payment.reference }),
          tokenAccount: first.payment.tokenAccount,
          settlementMint: first.payment.settlementMint,
          confirmedAt: new Date(),
        })
        expect(first.created).toBe(true)
        expect(duplicate.created).toBe(false)
        expect(
          (await database.findReceiveRequestForOwner(accountId, receiveId))?.status,
        ).toBe('PAID')
        expect(await database.listIncomingPayments(accountId)).toHaveLength(1)
      } finally {
        await database.disconnect()
      }
    })

    it('matches by chain confirmation time even when reconciliation runs later', async () => {
      const database = createDatabaseClient(databaseUrl as string)
      const accountId = `acct_${randomUUID().replaceAll('-', '')}`
      const credentialId = `cred_${randomUUID().replaceAll('-', '')}`
      const receiveId = `recv_${randomUUID().replaceAll('-', '')}`
      const confirmedAt = new Date('2026-01-01T00:00:00.000Z')
      const expiresAt = new Date('2026-01-01T00:00:01.000Z')

      try {
        await database.createAgentAccount({
          id: accountId,
          name: 'receive-confirmation-time-agent',
          solanaPublicKey: `${accountId}_public`,
          encryptedSolanaSecret: 'ciphertext',
          encryptionNonce: 'bm9uY2U=',
          encryptionAuthTag: 'dGFn',
          credentialId,
          keyHash: `${accountId}_hash`,
          keyPrefix: 'apa_integration',
        })
        await database.createReceiveRequest({
          id: receiveId,
          accountId,
          amountAtomic: 100n,
          currency: 'USD',
          reference: 'confirmed-before-expiry',
          expiresAt,
        })

        const incoming = await database.createIncomingPayment({
          id: `in_${randomUUID().replaceAll('-', '')}`,
          accountId,
          signature: `confirmed-before-expiry-${randomUUID()}`,
          amountAtomic: 100n,
          currency: 'USD',
          sourceAddress: 'external-wallet',
          reference: 'confirmed-before-expiry',
          tokenAccount: 'destination-token-account',
          settlementMint: 'settlement-mint',
          confirmedAt,
        })

        expect(incoming.payment.receiveRequestId).toBe(receiveId)
        expect(
          (await database.findReceiveRequestForOwner(accountId, receiveId))?.status,
        ).toBe('PAID')
        expect(
          (await database.findReceiveRequestForOwner(accountId, receiveId))?.paidAt,
        ).toEqual(confirmedAt)

        const exactBoundaryReceiveId = `recv_${randomUUID().replaceAll('-', '')}`
        await database.createReceiveRequest({
          id: exactBoundaryReceiveId,
          accountId,
          amountAtomic: 100n,
          currency: 'USD',
          reference: 'confirmed-at-expiry',
          expiresAt: confirmedAt,
        })
        const exactBoundaryIncoming = await database.createIncomingPayment({
          id: `in_${randomUUID().replaceAll('-', '')}`,
          accountId,
          signature: `confirmed-at-expiry-${randomUUID()}`,
          amountAtomic: 100n,
          currency: 'USD',
          sourceAddress: 'external-wallet',
          reference: 'confirmed-at-expiry',
          tokenAccount: 'destination-token-account',
          settlementMint: 'settlement-mint',
          confirmedAt,
        })
        expect(exactBoundaryIncoming.payment.receiveRequestId).toBeNull()
        expect(
          (await database.findReceiveRequestForOwner(accountId, exactBoundaryReceiveId))
            ?.status,
        ).toBe('EXPIRED')
      } finally {
        await database.disconnect()
      }
    })

    it('expires receive requests and keeps late or unmatched incoming payments in history', async () => {
      const database = createDatabaseClient(databaseUrl as string)
      const accountId = `acct_${randomUUID().replaceAll('-', '')}`
      const credentialId = `cred_${randomUUID().replaceAll('-', '')}`
      const receiveId = `recv_${randomUUID().replaceAll('-', '')}`
      const confirmedAt = new Date()

      try {
        await database.createAgentAccount({
          id: accountId,
          name: 'receive-expiry-agent',
          solanaPublicKey: `${accountId}_public`,
          encryptedSolanaSecret: 'ciphertext',
          encryptionNonce: 'bm9uY2U=',
          encryptionAuthTag: 'dGFn',
          credentialId,
          keyHash: `${accountId}_hash`,
          keyPrefix: 'apa_integration',
        })
        await database.createReceiveRequest({
          id: receiveId,
          accountId,
          amountAtomic: 100n,
          currency: 'USD',
          reference: 'expired-reference',
          expiresAt: new Date(confirmedAt.getTime() - 1_000),
        })

        await database.expireOpenReceiveRequests(accountId, confirmedAt)
        expect(
          (await database.findReceiveRequestForOwner(accountId, receiveId))?.status,
        ).toBe('EXPIRED')

        const lateIncoming = await database.createIncomingPayment({
          id: `in_${randomUUID().replaceAll('-', '')}`,
          accountId,
          signature: `late-${randomUUID()}`,
          amountAtomic: 100n,
          currency: 'USD',
          sourceAddress: 'external-wallet',
          reference: 'expired-reference',
          tokenAccount: 'destination-token-account',
          settlementMint: 'settlement-mint',
          confirmedAt,
        })

        expect(lateIncoming.created).toBe(true)
        expect(lateIncoming.payment.receiveRequestId).toBeNull()
        expect(
          (await database.findReceiveRequestForOwner(accountId, receiveId))?.status,
        ).toBe('EXPIRED')
      } finally {
        await database.disconnect()
      }
    })

    it('revives a wall-clock expired request when the chain confirmed before expiry', async () => {
      const database = createDatabaseClient(databaseUrl as string)
      const accountId = `acct_${randomUUID().replaceAll('-', '')}`
      const credentialId = `cred_${randomUUID().replaceAll('-', '')}`
      const receiveId = `recv_${randomUUID().replaceAll('-', '')}`
      const expiresAt = new Date('2026-09-06T12:00:00.000Z')
      const confirmedAt = new Date('2026-09-06T11:59:00.000Z')

      try {
        await database.createAgentAccount({
          id: accountId,
          name: 'receive-revival-agent',
          solanaPublicKey: `${accountId}_public`,
          encryptedSolanaSecret: 'ciphertext',
          encryptionNonce: 'bm9uY2U=',
          encryptionAuthTag: 'dGFn',
          credentialId,
          keyHash: `${accountId}_hash`,
          keyPrefix: 'apa_integration',
        })
        await database.createReceiveRequest({
          id: receiveId,
          accountId,
          amountAtomic: 500n,
          currency: 'USD',
          reference: 'late-reconciled-before-expiry',
          expiresAt,
        })
        await database.expireOpenReceiveRequests(
          accountId,
          new Date('2026-09-06T12:01:00.000Z'),
        )
        expect(
          (await database.findReceiveRequestForOwner(accountId, receiveId))?.status,
        ).toBe('EXPIRED')

        const incoming = await database.createIncomingPayment({
          id: `in_${randomUUID().replaceAll('-', '')}`,
          accountId,
          signature: `revival-${randomUUID()}`,
          amountAtomic: 500n,
          currency: 'USD',
          sourceAddress: 'external-wallet',
          reference: 'late-reconciled-before-expiry',
          tokenAccount: 'destination-token-account',
          settlementMint: 'settlement-mint',
          confirmedAt,
        })

        expect(incoming.payment.receiveRequestId).toBe(receiveId)
        expect(
          (await database.findReceiveRequestForOwner(accountId, receiveId))?.status,
        ).toBe('PAID')
        expect(
          (await database.findReceiveRequestForOwner(accountId, receiveId))?.paidAt,
        ).toEqual(confirmedAt)
      } finally {
        await database.disconnect()
      }
    })

    it('atomically claims a receive request once for concurrent incoming signatures', async () => {
      const database = createDatabaseClient(databaseUrl as string)
      const accountId = `acct_${randomUUID().replaceAll('-', '')}`
      const credentialId = `cred_${randomUUID().replaceAll('-', '')}`
      const receiveId = `recv_${randomUUID().replaceAll('-', '')}`

      try {
        await database.createAgentAccount({
          id: accountId,
          name: 'receive-concurrency-agent',
          solanaPublicKey: `${accountId}_public`,
          encryptedSolanaSecret: 'ciphertext',
          encryptionNonce: 'bm9uY2U=',
          encryptionAuthTag: 'dGFn',
          credentialId,
          keyHash: `${accountId}_hash`,
          keyPrefix: 'apa_integration',
        })
        await database.createReceiveRequest({
          id: receiveId,
          accountId,
          amountAtomic: 700n,
          currency: 'USD',
          reference: 'concurrent-receive-reference',
        })
        const createIncoming = (signature: string) =>
          database.createIncomingPayment({
            id: `in_${randomUUID().replaceAll('-', '')}`,
            accountId,
            signature,
            amountAtomic: 700n,
            currency: 'USD',
            sourceAddress: 'external-wallet',
            reference: 'concurrent-receive-reference',
            tokenAccount: 'destination-token-account',
            settlementMint: 'settlement-mint',
            confirmedAt: new Date(),
          })
        const [first, second] = await Promise.all([
          createIncoming(`concurrent-a-${randomUUID()}`),
          createIncoming(`concurrent-b-${randomUUID()}`),
        ])

        expect(
          [first.payment.receiveRequestId, second.payment.receiveRequestId].filter(
            (value) => value === receiveId,
          ),
        ).toHaveLength(1)
        expect(
          (await database.listIncomingPayments(accountId)).filter(
            (payment) => payment.receiveRequestId === receiveId,
          ),
        ).toHaveLength(1)
      } finally {
        await database.disconnect()
      }
    })

    it('persists sub-cent incoming settlement events for audit', async () => {
      const database = createDatabaseClient(databaseUrl as string)
      const accountId = `acct_${randomUUID().replaceAll('-', '')}`
      const credentialId = `cred_${randomUUID().replaceAll('-', '')}`

      try {
        await database.createAgentAccount({
          id: accountId,
          name: 'sub-cent-audit-agent',
          solanaPublicKey: `${accountId}_public`,
          encryptedSolanaSecret: 'ciphertext',
          encryptionNonce: 'bm9uY2U=',
          encryptionAuthTag: 'dGFn',
          credentialId,
          keyHash: `${accountId}_hash`,
          keyPrefix: 'apa_integration',
        })
        const incoming = await database.createIncomingPayment({
          id: `in_${randomUUID().replaceAll('-', '')}`,
          accountId,
          signature: `dust-${randomUUID()}`,
          amountAtomic: 0n,
          tokenAtomicUnits: 1n,
          tokenDecimals: 6,
          currency: 'USD',
          sourceAddress: 'external-wallet',
          tokenAccount: 'destination-token-account',
          settlementMint: 'settlement-mint',
          confirmedAt: new Date(),
        })

        expect(incoming.payment.amountAtomic).toBe(0n)
        expect(incoming.payment.tokenAtomicUnits).toBe(1n)
        expect(incoming.payment.tokenDecimals).toBe(6)
        expect(await database.listIncomingPayments(accountId)).toHaveLength(1)
      } finally {
        await database.disconnect()
      }
    })

    it('keeps distinct incoming signatures distinct even when amounts match', async () => {
      const database = createDatabaseClient(databaseUrl as string)
      const accountId = `acct_${randomUUID().replaceAll('-', '')}`
      const credentialId = `cred_${randomUUID().replaceAll('-', '')}`

      try {
        await database.createAgentAccount({
          id: accountId,
          name: 'incoming-dedup-agent',
          solanaPublicKey: `${accountId}_public`,
          encryptedSolanaSecret: 'ciphertext',
          encryptionNonce: 'bm9uY2U=',
          encryptionAuthTag: 'dGFn',
          credentialId,
          keyHash: `${accountId}_hash`,
          keyPrefix: 'apa_integration',
        })
        const common = {
          accountId,
          amountAtomic: 100n,
          currency: 'USD',
          tokenAccount: 'destination-token-account',
          settlementMint: 'settlement-mint',
          confirmedAt: new Date(),
        }
        const first = await database.createIncomingPayment({
          ...common,
          id: `in_${randomUUID().replaceAll('-', '')}`,
          signature: `signature-${randomUUID()}`,
        })
        const second = await database.createIncomingPayment({
          ...common,
          id: `in_${randomUUID().replaceAll('-', '')}`,
          signature: `signature-${randomUUID()}`,
        })

        expect(first.created).toBe(true)
        expect(second.created).toBe(true)
        expect(await database.listIncomingPayments(accountId)).toHaveLength(2)
      } finally {
        await database.disconnect()
      }
    })
  },
)
