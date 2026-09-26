import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { Client } from 'pg'

import {
  ConflictError,
  IdempotencyConflictError,
  IdempotencyKeyReusedError,
  InvalidStateError,
  NotFoundError,
  RecipientResolutionError,
} from '@agent-payment/core'
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

    it('creates the V1 default receive request atomically and rolls back on failure', async () => {
      const database = createDatabaseClient(databaseUrl as string)
      const accountId = `acct_${randomUUID().replaceAll('-', '')}`
      const credentialId = `cred_${randomUUID().replaceAll('-', '')}`
      const receiveId = `recv_${randomUUID().replaceAll('-', '')}`
      const keyHash = `${accountId}_atomic_hash`
      const invalidReference = 'x'.repeat(256)

      try {
        await expect(
          database.createAgentAccount({
            id: accountId,
            name: 'atomic-provisioning-agent',
            solanaPublicKey: `${accountId}_public`,
            encryptedSolanaSecret: 'ciphertext',
            encryptionNonce: 'bm9uY2U=',
            encryptionAuthTag: 'dGFn',
            credentialId,
            keyHash,
            keyPrefix: 'apa_integration',
            initialReceiveRequest: {
              id: receiveId,
              currency: 'USD',
              reference: invalidReference,
            },
          }),
        ).rejects.toThrow()

        expect(await database.findAccountByCredentialHash(keyHash)).toBeNull()
        expect(await database.listReceiveRequests(accountId)).toHaveLength(0)

        const retried = await database.createAgentAccount({
          id: accountId,
          name: 'atomic-provisioning-agent',
          solanaPublicKey: `${accountId}_public`,
          encryptedSolanaSecret: 'ciphertext',
          encryptionNonce: 'bm9uY2U=',
          encryptionAuthTag: 'dGFn',
          credentialId,
          keyHash,
          keyPrefix: 'apa_integration',
          initialReceiveRequest: {
            id: receiveId,
            currency: 'USD',
            reference: `account:${accountId}`,
          },
        })
        const requests = await database.listReceiveRequests(accountId)

        expect(retried.id).toBe(accountId)
        expect(requests).toHaveLength(1)
        expect(requests[0]).toMatchObject({
          id: receiveId,
          accountId,
          reference: `account:${accountId}`,
          status: 'OPEN',
        })
      } finally {
        await database.disconnect()
      }
    })

    it('globally prunes stale rate-limit history in bounded batches', async () => {
      const database = createDatabaseClient(databaseUrl as string)
      const sql = new Client({ connectionString: databaseUrl as string })
      const subjectId = `ip:rate-retention-${randomUUID()}`
      const otherSubjectId = `ip:rate-retention-other-${randomUUID()}`
      const bucket = `request-${randomUUID()}`
      const windowSeconds = 60
      const currentWindow = new Date('2026-09-18T00:10:00.000Z')
      const staleWindow = new Date(currentWindow.getTime() - 3 * 24 * 60 * 60 * 1_000)
      let sqlConnected = false

      try {
        await sql.connect()
        sqlConnected = true
        const staleSeed = randomUUID()
        await sql.query(
          `INSERT INTO rate_limit_buckets
             (id, subject_type, subject_id, bucket, window_started_at, request_count, updated_at)
           SELECT 'rate-stale-' || $1 || '-' || item::text,
                  'HTTP_CLIENT',
                  'ip:inactive-' || $1 || '-' || item::text,
                  'request-stale', $2, 1, $2
             FROM generate_series(1, 40) AS item`,
          [staleSeed, staleWindow],
        )
        for (const windowStartedAt of ['2026-09-18 00:08:00', '2026-09-18 00:09:00']) {
          await sql.query(
            `INSERT INTO rate_limit_buckets
               (id, subject_type, subject_id, bucket, window_started_at, request_count, updated_at)
             VALUES ($1, 'HTTP_CLIENT', $2, $3, $4, 1, $4),
                    ($5, 'HTTP_CLIENT', $6, $3, $4, 1, $4)`,
            [
              `rate-target-${randomUUID()}`,
              subjectId,
              bucket,
              windowStartedAt,
              `rate-other-${randomUUID()}`,
              otherSubjectId,
            ],
          )
        }

        const first = await database.v2Admin.consumeRateLimit({
          subjectType: 'HTTP_CLIENT',
          subjectId,
          bucket,
          windowSeconds,
          limit: 20,
          now: currentWindow,
        })
        const remainingAfterOneBatch = await sql.query<{ count: number }>(
          `SELECT COUNT(*)::int AS count FROM rate_limit_buckets
            WHERE subject_type = 'HTTP_CLIENT'
              AND subject_id LIKE 'ip:inactive-' || $1 || '-%'
              AND window_started_at < $2`,
          [staleSeed, new Date(currentWindow.getTime() - 2 * 24 * 60 * 60 * 1_000)],
        )
        expect(first).toMatchObject({ allowed: true, count: 1 })
        expect(remainingAfterOneBatch.rows[0]?.count).toBe(8)

        const concurrent = await Promise.all(
          Array.from({ length: 20 }, () =>
            database.v2Admin.consumeRateLimit({
              subjectType: 'HTTP_CLIENT',
              subjectId,
              bucket,
              windowSeconds,
              limit: 20,
              now: currentWindow,
            }),
          ),
        )
        expect(concurrent.filter((result) => !result.allowed)).toHaveLength(1)
        expect(concurrent.find((result) => !result.allowed)?.count).toBe(21)

        await expect(
          database.v2Admin.consumeRateLimit({
            subjectType: 'HTTP_CLIENT',
            subjectId,
            bucket,
            windowSeconds: 86_401,
            limit: 20,
            now: currentWindow,
          }),
        ).rejects.toThrow('Rate limit window')

        const retained = await sql.query<{
          window_started_at: string
          request_count: number
        }>(
          `SELECT window_started_at::text AS window_started_at, request_count
             FROM rate_limit_buckets
            WHERE subject_type = 'HTTP_CLIENT' AND subject_id = $1 AND bucket = $2
            ORDER BY window_started_at`,
          [subjectId, bucket],
        )
        const other = await sql.query(
          `SELECT COUNT(*)::int AS count
             FROM rate_limit_buckets
            WHERE subject_type = 'HTTP_CLIENT' AND subject_id = $1 AND bucket = $2`,
          [otherSubjectId, bucket],
        )
        const stale = await sql.query<{ count: number }>(
          `SELECT COUNT(*)::int AS count FROM rate_limit_buckets
            WHERE subject_type = 'HTTP_CLIENT'
              AND subject_id LIKE 'ip:inactive-' || $1 || '-%'
              AND window_started_at < $2`,
          [staleSeed, new Date(currentWindow.getTime() - 2 * 24 * 60 * 60 * 1_000)],
        )

        expect(retained.rows).toHaveLength(3)
        expect(retained.rows.map((row) => row.window_started_at)).toEqual([
          '2026-09-18 00:08:00',
          '2026-09-18 00:09:00',
          '2026-09-18 00:10:00',
        ])
        expect(retained.rows.at(-1)?.request_count).toBe(21)
        expect(other.rows[0]?.count).toBe(2)
        expect(stale.rows[0]?.count).toBe(0)
      } finally {
        if (sqlConnected) await sql.end()
        await database.disconnect()
      }
    })

    it('keeps trusted refund reads separate from payer-scoped payment reads', async () => {
      const database = createDatabaseClient(databaseUrl as string)
      const sql = new Client({ connectionString: databaseUrl as string })
      const payerAccountId = `acct_${randomUUID().replaceAll('-', '')}`
      const recipientAccountId = `acct_${randomUUID().replaceAll('-', '')}`
      const paymentId = `pay_${randomUUID().replaceAll('-', '')}`
      let sqlConnected = false

      try {
        await database.createAgentAccount({
          id: payerAccountId,
          name: 'refund-scope-payer',
          solanaPublicKey: `${payerAccountId}_public`,
          encryptedSolanaSecret: 'ciphertext',
          encryptionNonce: 'bm9uY2U=',
          encryptionAuthTag: 'dGFn',
          credentialId: `cred_${randomUUID().replaceAll('-', '')}`,
          keyHash: `${payerAccountId}_hash`,
          keyPrefix: 'apa_integration',
        })
        await database.createAgentAccount({
          id: recipientAccountId,
          name: 'refund-scope-recipient',
          solanaPublicKey: `${recipientAccountId}_public`,
          encryptedSolanaSecret: 'ciphertext',
          encryptionNonce: 'bm9uY2U=',
          encryptionAuthTag: 'dGFn',
          credentialId: `cred_${randomUUID().replaceAll('-', '')}`,
          keyHash: `${recipientAccountId}_hash`,
          keyPrefix: 'apa_integration',
        })
        await sql.connect()
        sqlConnected = true
        await sql.query(
          `INSERT INTO payments
             (id, payer_account_id, recipient_managed_account_id, kind,
              amount_atomic, currency, status, updated_at)
           VALUES ($1, $2, $3, 'PAY', 125, 'USD', 'CONFIRMED', NOW())`,
          [paymentId, payerAccountId, recipientAccountId],
        )

        expect(await database.v2.findPayment(payerAccountId, paymentId)).not.toBeNull()
        expect(
          await database.v2.findPaymentView(payerAccountId, paymentId),
        ).not.toBeNull()
        expect(await database.v2.findPayment(recipientAccountId, paymentId)).toBeNull()
        expect(
          await database.v2.findPaymentView(recipientAccountId, paymentId),
        ).toBeNull()
        expect(await database.v2.findPaymentForRefund(paymentId)).toMatchObject({
          id: paymentId,
          payerAccountId,
          recipientManagedAccountId: recipientAccountId,
          status: 'CONFIRMED',
        })
      } finally {
        if (sqlConnected) await sql.end()
        await database.disconnect()
      }
    })

    it('does not consume work-item retries for repeated capacity deferrals', async () => {
      const database = createDatabaseClient(databaseUrl as string)
      const sql = new Client({ connectionString: databaseUrl as string })
      const workItemId = `work_${randomUUID().replaceAll('-', '')}`
      const kind = `CAPACITY_TEST_${randomUUID().replaceAll('-', '')}`
      const workResourceId = `resource_${randomUUID().replaceAll('-', '')}`
      const recoveryWorkItemId = `work_${randomUUID().replaceAll('-', '')}`
      const recoveryKind = `RECOVERY_TEST_${randomUUID().replaceAll('-', '')}`
      const recoveryResourceId = `resource_${randomUUID().replaceAll('-', '')}`
      const failedWorkItemId = `work_${randomUUID().replaceAll('-', '')}`
      const failedKind = `FAILURE_TEST_${randomUUID().replaceAll('-', '')}`
      const failedResourceId = `resource_${randomUUID().replaceAll('-', '')}`
      let sqlConnected = false

      try {
        await sql.connect()
        sqlConnected = true
        await sql.query(
          `INSERT INTO durable_work_items
             (id, kind, resource_type, resource_id, status, available_at,
              attempt_count, max_attempts, lease_recovery_count, updated_at)
           VALUES ($1, $2, 'CAPACITY_TEST', $3, 'AVAILABLE', NOW() - INTERVAL '1 second',
                   0, 3, 0, NOW())`,
          [workItemId, kind, workResourceId],
        )

        for (let attempt = 0; attempt < 12; attempt += 1) {
          const owner = `capacity-owner-${attempt}`
          const claim = await database.v2.claimWorkItem({
            kind,
            owner,
            leaseSeconds: 60,
          })
          expect(claim).toMatchObject({ id: workItemId, attemptCount: 1 })
          await database.v2.deferWorkItem({
            id: workItemId,
            owner,
            retryAt: new Date(Date.now() - 1_000),
            errorCode: 'CAPACITY_BACKPRESSURE',
            errorSafe: 'Test capacity backpressure',
          })
        }

        const deferredState = await sql.query<{
          status: string
          attempt_count: number
          lease_recovery_count: number
        }>(
          'SELECT status, attempt_count, lease_recovery_count FROM durable_work_items WHERE id = $1',
          [workItemId],
        )
        expect(deferredState.rows[0]).toMatchObject({
          status: 'RETRY_WAIT',
          attempt_count: 0,
          lease_recovery_count: 0,
        })

        await sql.query(
          `INSERT INTO durable_work_items
             (id, kind, resource_type, resource_id, status, available_at,
              lease_owner, lease_expires_at, attempt_count, max_attempts,
              lease_recovery_count, updated_at)
           VALUES ($1, $2, 'RECOVERY_TEST', $3, 'CLAIMED', NOW() - INTERVAL '1 second',
                   'expired-owner', NOW() - INTERVAL '1 second', 3, 3, 0, NOW())`,
          [recoveryWorkItemId, recoveryKind, recoveryResourceId],
        )
        const recoveredClaim = await database.v2.claimWorkItem({
          kind: recoveryKind,
          owner: 'capacity-recovery-owner-1',
          leaseSeconds: 60,
        })
        expect(recoveredClaim).toMatchObject({
          id: recoveryWorkItemId,
          attemptCount: 3,
        })
        await database.v2.deferWorkItem({
          id: recoveryWorkItemId,
          owner: 'capacity-recovery-owner-1',
          retryAt: new Date(Date.now() - 1_000),
          errorCode: 'CAPACITY_BACKPRESSURE',
          errorSafe: 'Test recovery capacity backpressure',
        })
        const afterRecoveryDeferral = await sql.query<{
          status: string
          attempt_count: number
          lease_recovery_count: number
        }>(
          'SELECT status, attempt_count, lease_recovery_count FROM durable_work_items WHERE id = $1',
          [recoveryWorkItemId],
        )
        expect(afterRecoveryDeferral.rows[0]).toMatchObject({
          status: 'RETRY_WAIT',
          attempt_count: 3,
          lease_recovery_count: 0,
        })
        const repeatedRecoveryClaim = await database.v2.claimWorkItem({
          kind: recoveryKind,
          owner: 'capacity-recovery-owner-2',
          leaseSeconds: 60,
        })
        expect(repeatedRecoveryClaim).toMatchObject({
          id: recoveryWorkItemId,
          attemptCount: 3,
        })
        await database.v2.completeWorkItem(
          recoveryWorkItemId,
          'capacity-recovery-owner-2',
        )

        await sql.query(
          `INSERT INTO durable_work_items
             (id, kind, resource_type, resource_id, status, available_at,
              attempt_count, max_attempts, lease_recovery_count, updated_at)
           VALUES ($1, $2, 'FAILURE_TEST', $3, 'AVAILABLE', NOW() - INTERVAL '1 second',
                   0, 3, 0, NOW())`,
          [failedWorkItemId, failedKind, failedResourceId],
        )
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          const owner = `failure-owner-${attempt}`
          const claim = await database.v2.claimWorkItem({
            kind: failedKind,
            owner,
            leaseSeconds: 60,
          })
          expect(claim).toMatchObject({ id: failedWorkItemId, attemptCount: attempt })
          await database.v2.retryWorkItem({
            id: failedWorkItemId,
            owner,
            retryAt: new Date(Date.now() - 1_000),
            errorCode: 'EXTERNAL_FAILURE',
            errorSafe: 'Test external failure',
          })
        }
        const failedState = await sql.query<{
          status: string
          attempt_count: number
        }>('SELECT status, attempt_count FROM durable_work_items WHERE id = $1', [
          failedWorkItemId,
        ])
        expect(failedState.rows[0]).toMatchObject({
          status: 'EXHAUSTED',
          attempt_count: 3,
        })
      } finally {
        if (sqlConnected) {
          await sql.query(
            'DELETE FROM operational_exceptions WHERE resource_id = ANY($1::text[])',
            [[workResourceId, failedResourceId]],
          )
          await sql.query('DELETE FROM durable_work_items WHERE id IN ($1, $2)', [
            workItemId,
            failedWorkItemId,
          ])
          await sql.query('DELETE FROM durable_work_items WHERE id = $1', [
            recoveryWorkItemId,
          ])
          await sql.end()
        }
        await database.disconnect()
      }
    })

    it('does not let a stale worker overwrite a replacement work-item lease', async () => {
      const database = createDatabaseClient(databaseUrl as string)
      const sql = new Client({ connectionString: databaseUrl as string })
      const workItemId = `work_${randomUUID().replaceAll('-', '')}`
      let sqlConnected = false

      try {
        await sql.connect()
        sqlConnected = true
        await sql.query(
          `INSERT INTO durable_work_items
             (id, kind, resource_type, resource_id, status, available_at,
              lease_owner, lease_expires_at, attempt_count, max_attempts,
              lease_recovery_count, updated_at)
           VALUES ($1, 'STALE_LEASE_TEST', 'TEST', $2, 'CLAIMED', NOW(),
                   'new-owner', NOW() + INTERVAL '1 minute', 1, 3, 0, NOW())`,
          [workItemId, `resource_${randomUUID().replaceAll('-', '')}`],
        )

        await expect(
          database.v2.deferWorkItem({
            id: workItemId,
            owner: 'old-owner',
            retryAt: new Date(Date.now() + 10_000),
            errorCode: 'CAPACITY_BACKPRESSURE',
            errorSafe: 'Test stale lease deferral',
          }),
        ).rejects.toThrow('lease is no longer owned')
        const state = await sql.query<{
          status: string
          lease_owner: string | null
          attempt_count: number
        }>(
          `SELECT status, lease_owner, attempt_count
             FROM durable_work_items WHERE id = $1`,
          [workItemId],
        )
        expect(state.rows[0]).toMatchObject({
          status: 'CLAIMED',
          lease_owner: 'new-owner',
          attempt_count: 1,
        })
      } finally {
        if (sqlConnected) {
          await sql.query('DELETE FROM durable_work_items WHERE id = $1', [workItemId])
          await sql.end()
        }
        await database.disconnect()
      }
    })

    it('emits durable webhook events for non-payment resources and incoming facts', async () => {
      const database = createDatabaseClient(databaseUrl as string)
      const sql = new Client({ connectionString: databaseUrl as string })
      const accountId = `acct_${randomUUID().replaceAll('-', '')}`
      const credentialId = `cred_${randomUUID().replaceAll('-', '')}`
      const subscriptionId = `sub_${randomUUID().replaceAll('-', '')}`
      const recipientId = `rcpt_${randomUUID().replaceAll('-', '')}`
      const incomingId = `in_${randomUUID().replaceAll('-', '')}`
      let sqlConnected = false

      try {
        await database.createAgentAccount({
          id: accountId,
          name: 'webhook-integration-agent',
          solanaPublicKey: `${accountId}_public`,
          encryptedSolanaSecret: 'ciphertext',
          encryptionNonce: 'bm9uY2U=',
          encryptionAuthTag: 'dGFn',
          credentialId,
          keyHash: `${accountId}_hash`,
          keyPrefix: 'apa_integration',
        })
        await database.v2Operations.createWebhookSubscription({
          id: subscriptionId,
          accountId,
          endpoint: 'https://merchant.example.test/webhook',
          eventTypes: ['recipient.created', 'incoming.created'],
          signingKeyRef: 'secret/webhook/integration',
          signingKeyVersion: 1,
        })
        await database.createRecipient({
          id: recipientId,
          ownerAccountId: accountId,
          displayName: 'Webhook recipient',
          type: 'BUSINESS',
          destination: {
            id: `dest_${randomUUID().replaceAll('-', '')}`,
            rail: 'SOLANA_SPL',
            type: 'SOLANA_SPL',
            walletAddress: 'webhook-recipient-wallet',
          },
        })
        await database.createIncomingPayment({
          id: incomingId,
          accountId,
          signature: `webhook-signature-${randomUUID()}`,
          amountAtomic: 100n,
          currency: 'USD',
          reference: 'webhook-incoming',
          tokenAccount: 'webhook-token-account',
          settlementMint: 'webhook-settlement-mint',
          confirmedAt: new Date('2026-09-18T00:00:00.000Z'),
        })

        await sql.connect()
        sqlConnected = true
        const result = await sql.query<{
          event_type: string
          resource_type: string
          delivery_id: string
          raw_body: string
        }>(
          `SELECT event.event_type, event.resource_type, delivery.id AS delivery_id,
                  event.raw_body
             FROM webhook_events event
             JOIN webhook_deliveries delivery ON delivery.event_id = event.event_id
             JOIN webhook_subscriptions subscription
               ON subscription.id = delivery.subscription_id
            WHERE subscription.account_id = $1
            ORDER BY event.created_at, event.event_id`,
          [accountId],
        )

        expect(result.rows.map((row) => row.event_type)).toEqual([
          'recipient.created',
          'incoming.created',
        ])
        expect(result.rows.map((row) => row.resource_type)).toEqual([
          'RECIPIENT',
          'INCOMING_PAYMENT',
        ])
        expect(new Set(result.rows.map((row) => row.delivery_id)).size).toBe(2)
        expect(JSON.parse(result.rows[1]?.raw_body ?? '{}')).toMatchObject({
          type: 'incoming.created',
          version: 'v2',
          resource: { id: incomingId, receive_request_id: null },
        })
      } finally {
        if (sqlConnected) await sql.end()
        await database.disconnect()
      }
    })

    it('allows only one concurrent credential rotation to revoke the active source', async () => {
      const database = createDatabaseClient(databaseUrl as string)
      const accountId = `acct_${randomUUID().replaceAll('-', '')}`
      const credentialId = `cred_${randomUUID().replaceAll('-', '')}`
      const recoveryIdempotencyKey = `CREDENTIAL_ROTATION:${accountId}:race`

      try {
        await database.createAgentAccount({
          id: accountId,
          name: 'rotation-race-agent',
          solanaPublicKey: `${accountId}_public`,
          encryptedSolanaSecret: 'ciphertext',
          encryptionNonce: 'bm9uY2U=',
          encryptionAuthTag: 'dGFn',
          credentialId,
          keyHash: `${accountId}_hash`,
          keyPrefix: 'apa_integration',
        })

        const rotate = (suffix: string) => ({
          accountId,
          oldCredentialId: credentialId,
          newCredentialId: `cred_${randomUUID().replaceAll('-', '')}`,
          keyHash: `${accountId}_${suffix}_hash`,
          keyPrefix: `apa_${suffix}`,
          scopes: ['payments:read'],
          recoveryCiphertext: `ciphertext-${suffix}`,
          recoveryNonce: 'bm9uY2U=',
          recoveryAuthTag: 'dGFn',
          recoveryIdempotencyKey,
          recoveryExpiresAt: new Date('2026-09-19T00:00:00.000Z'),
        })
        const results = await Promise.allSettled([
          database.v2Admin.rotateCredential(rotate('one')),
          database.v2Admin.rotateCredential(rotate('two')),
        ])

        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(
          1,
        )
        const rejected = results.find((result) => result.status === 'rejected')
        expect(rejected?.reason).toBeInstanceOf(NotFoundError)
        const credentials = await database.v2Admin.listCredentials(accountId)
        expect(credentials.filter((item) => item.status === 'ACTIVE')).toHaveLength(1)
        expect(
          credentials.filter((item) => item.rotatedFromId === credentialId),
        ).toHaveLength(1)
        const envelope = await database.v2Admin.consumeRecoveryEnvelope(
          accountId,
          recoveryIdempotencyKey,
          new Date('2026-09-18T00:00:00.000Z'),
        )
        expect(envelope?.credentialId).toBe(
          credentials.find((item) => item.status === 'ACTIVE')?.id,
        )
      } finally {
        await database.disconnect()
      }
    })

    it('creates one delegated credential per idempotency key and removes its recovery envelope', async () => {
      const database = createDatabaseClient(databaseUrl as string)
      const accountId = `acct_${randomUUID().replaceAll('-', '')}`
      const credentialId = `cred_${randomUUID().replaceAll('-', '')}`
      const requestHash = 'a'.repeat(64)
      const recoveryIdempotencyKey = `CREDENTIAL_CREATE:${accountId}:recovery`

      try {
        await database.createAgentAccount({
          id: accountId,
          name: 'credential-issuance-integration-agent',
          solanaPublicKey: `${accountId}_public`,
          encryptedSolanaSecret: 'ciphertext',
          encryptionNonce: 'bm9uY2U=',
          encryptionAuthTag: 'dGFn',
          credentialId,
          keyHash: `${accountId}_hash`,
          keyPrefix: 'apa_integration',
        })

        const createInput = (suffix: string) => ({
          accountId,
          idempotencyKey: 'delegated-credential-key',
          requestHash,
          fingerprint: requestHash,
          credentialId: `cred_${suffix}_${randomUUID().replaceAll('-', '')}`,
          keyHash: `${accountId}_${suffix}_hash`,
          keyPrefix: `apa_${suffix}`,
          scopes: ['history:read', 'payments:read'],
          recoveryCiphertext: `ciphertext-${suffix}`,
          recoveryNonce: 'bm9uY2U=',
          recoveryAuthTag: 'dGFn',
          recoveryIdempotencyKey,
          recoveryExpiresAt: new Date('2026-09-19T00:00:00.000Z'),
          actorId: 'platform-operator:integration',
        })

        const results = await Promise.all([
          database.v2Admin.createCredential(createInput('one')),
          database.v2Admin.createCredential(createInput('two')),
        ])

        expect(results.filter((result) => result.created)).toHaveLength(1)
        expect(results[0]?.credential.id).toBe(results[1]?.credential.id)
        expect(await database.v2Admin.listCredentials(accountId)).toHaveLength(2)

        await expect(
          database.v2Admin.createCredential({
            ...createInput('conflict'),
            requestHash: 'b'.repeat(64),
            fingerprint: 'b'.repeat(64),
          }),
        ).rejects.toBeInstanceOf(IdempotencyKeyReusedError)

        const envelope = await database.v2Admin.consumeRecoveryEnvelope(
          accountId,
          recoveryIdempotencyKey,
          new Date('2026-09-18T00:00:00.000Z'),
        )
        expect(envelope?.credentialId).toBe(results[0]?.credential.id)
        await database.v2Admin.acknowledgeRecoveryEnvelope(
          accountId,
          recoveryIdempotencyKey,
        )
        await expect(
          database.v2Admin.consumeRecoveryEnvelope(
            accountId,
            recoveryIdempotencyKey,
            new Date('2026-09-18T00:00:00.000Z'),
          ),
        ).resolves.toBeNull()
      } finally {
        await database.disconnect()
      }
    })

    it('keeps the credential and idempotency resource after recovery TTL expiry', async () => {
      const database = createDatabaseClient(databaseUrl as string)
      const accountId = `acct_${randomUUID().replaceAll('-', '')}`
      const credentialId = `cred_${randomUUID().replaceAll('-', '')}`
      const delegatedCredentialId = `cred_${randomUUID().replaceAll('-', '')}`
      const recoveryIdempotencyKey = `CREDENTIAL_CREATE:${accountId}:expired`
      const requestHash = 'd'.repeat(64)

      try {
        await database.createAgentAccount({
          id: accountId,
          name: 'expired-recovery-integration-agent',
          solanaPublicKey: `${accountId}_public`,
          encryptedSolanaSecret: 'ciphertext',
          encryptionNonce: 'bm9uY2U=',
          encryptionAuthTag: 'dGFn',
          credentialId,
          keyHash: `${accountId}_hash`,
          keyPrefix: 'apa_integration',
        })
        await database.v2Admin.createCredential({
          accountId,
          idempotencyKey: 'expired-credential-key',
          requestHash,
          fingerprint: requestHash,
          credentialId: delegatedCredentialId,
          keyHash: `${accountId}_delegated_hash`,
          keyPrefix: 'apa_expired',
          scopes: ['payments:read'],
          recoveryCiphertext: 'expired-recovery-ciphertext',
          recoveryNonce: 'bm9uY2U=',
          recoveryAuthTag: 'dGFn',
          recoveryIdempotencyKey,
          recoveryExpiresAt: new Date('2026-09-19T00:00:00.000Z'),
          actorId: 'platform-operator:integration',
        })

        await expect(
          database.v2Admin.consumeRecoveryEnvelope(
            accountId,
            recoveryIdempotencyKey,
            new Date('2026-09-20T00:00:00.000Z'),
          ),
        ).resolves.toBeNull()
        await expect(
          database.v2Admin.findCredentialIdempotency({
            accountId,
            idempotencyKey: 'expired-credential-key',
          }),
        ).resolves.toMatchObject({
          credential: { id: delegatedCredentialId, status: 'ACTIVE' },
        })
        await expect(
          database.findAccountByCredentialHash(`${accountId}_delegated_hash`),
        ).resolves.toMatchObject({
          account: { id: accountId, status: 'ACTIVE' },
          credential: { id: delegatedCredentialId, status: 'ACTIVE' },
        })
      } finally {
        await database.disconnect()
      }
    })

    it('serializes account provisioning by the global idempotency key', async () => {
      const database = createDatabaseClient(databaseUrl as string)
      const idempotencyKey = `account-provision-${randomUUID()}`
      const requestHash = 'e'.repeat(64)
      const input = (suffix: string) => {
        const accountId = `acct_${suffix}_${randomUUID().replaceAll('-', '')}`
        return {
          idempotencyKey,
          requestHash,
          accountId,
          name: 'concurrent-provisioned-agent',
          solanaPublicKey: `${accountId}_public`,
          encryptedSolanaSecret: `ciphertext-${suffix}`,
          encryptionNonce: 'bm9uY2U=',
          encryptionAuthTag: 'dGFn',
          credentialId: `cred_${suffix}_${randomUUID().replaceAll('-', '')}`,
          keyHash: `${accountId}_hash`,
          keyPrefix: `apa_${suffix}`,
          scopes: ['payments:read'],
          recoveryCiphertext: `recovery-${suffix}`,
          recoveryNonce: 'bm9uY2U=',
          recoveryAuthTag: 'dGFn',
          recoveryExpiresAt: new Date('2026-09-19T00:00:00.000Z'),
          receiveRequestId: `recv_${suffix}_${randomUUID().replaceAll('-', '')}`,
          receiveReference: `account:${accountId}`,
        }
      }

      try {
        const results = await Promise.all([
          database.v2Admin.provisionAccount(input('one')),
          database.v2Admin.provisionAccount(input('two')),
        ])

        expect(results.filter((result) => result.created)).toHaveLength(1)
        expect(results[0]?.account.id).toBe(results[1]?.account.id)
        expect(results[0]?.credential.id).toBe(results[1]?.credential.id)

        await expect(
          database.v2Admin.provisionAccount({
            ...input('conflict'),
            requestHash: 'f'.repeat(64),
          }),
        ).rejects.toBeInstanceOf(IdempotencyConflictError)
      } finally {
        await database.disconnect()
      }
    })

    it('records append-only timeline events without storing recovery ciphertext', async () => {
      const database = createDatabaseClient(databaseUrl as string)
      const sql = new Client({ connectionString: databaseUrl as string })
      const accountId = `acct_${randomUUID().replaceAll('-', '')}`
      const credentialId = `cred_${randomUUID().replaceAll('-', '')}`
      const recipientId = `rcpt_${randomUUID().replaceAll('-', '')}`
      const delegatedCredentialId = `cred_${randomUUID().replaceAll('-', '')}`
      const recoveryKey = `CREDENTIAL_CREATE:${accountId}:timeline`
      let sqlConnected = false

      try {
        await database.createAgentAccount({
          id: accountId,
          name: 'timeline-integration-agent',
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
          displayName: 'Timeline recipient',
          type: 'BUSINESS',
          destination: {
            id: `dest_${randomUUID().replaceAll('-', '')}`,
            rail: 'SOLANA_SPL',
            type: 'SOLANA_SPL',
            walletAddress: 'timeline-recipient-wallet',
          },
        })
        await database.v2Admin.createCredential({
          accountId,
          idempotencyKey: 'timeline-credential-key',
          requestHash: 'c'.repeat(64),
          fingerprint: 'c'.repeat(64),
          credentialId: delegatedCredentialId,
          keyHash: `${accountId}_delegated_hash`,
          keyPrefix: 'apa_delegated',
          scopes: ['history:read'],
          recoveryCiphertext: 'timeline-recovery-ciphertext',
          recoveryNonce: 'bm9uY2U=',
          recoveryAuthTag: 'dGFn',
          recoveryIdempotencyKey: recoveryKey,
          recoveryExpiresAt: new Date('2026-09-19T00:00:00.000Z'),
          actorId: 'platform-operator:integration',
        })
        await database.v2Admin.acknowledgeRecoveryEnvelope(accountId, recoveryKey)
        await database.v2Admin.acknowledgeRecoveryEnvelope(accountId, recoveryKey)
        await database.v2Operations.createWebhookSubscription({
          id: `sub_${randomUUID().replaceAll('-', '')}`,
          accountId,
          endpoint: 'https://merchant.example.test/timeline',
          eventTypes: ['recipient.created'],
          signingKeyRef: 'secret/webhook/timeline',
          signingKeyVersion: 1,
        })

        await sql.connect()
        sqlConnected = true
        const result = await sql.query<{
          id: string
          event_type: string
          new_state_json: string | null
          event_count: string
        }>(
          `SELECT id, event_type, new_state_json,
                  COUNT(*) OVER (PARTITION BY event_type) AS event_count
             FROM operation_timeline_events
            WHERE account_id = $1
            ORDER BY created_at, id`,
          [accountId],
        )

        expect(result.rows.map((row) => row.event_type)).toEqual(
          expect.arrayContaining([
            'ACCOUNT_CREATED',
            'CREDENTIAL_CREATED',
            'RECIPIENT_CREATED',
            'CREDENTIAL_RECOVERY_ACKNOWLEDGED',
            'WEBHOOK_SUBSCRIPTION_CREATED',
          ]),
        )
        expect(
          result.rows.find(
            (row) => row.event_type === 'CREDENTIAL_RECOVERY_ACKNOWLEDGED',
          )?.event_count,
        ).toBe('1')
        expect(
          result.rows.map((row) => row.new_state_json ?? '').join('\n'),
        ).not.toContain('timeline-recovery-ciphertext')
        const acknowledgement = result.rows.find(
          (row) => row.event_type === 'CREDENTIAL_RECOVERY_ACKNOWLEDGED',
        )
        expect(acknowledgement).toBeDefined()
        await expect(
          sql.query(
            'UPDATE operation_timeline_events SET metadata_json = $1 WHERE id = $2',
            ['{"tampered":true}', acknowledgement?.id],
          ),
        ).rejects.toThrow('operation timeline events are append-only')
        await expect(
          sql.query('DELETE FROM operation_timeline_events WHERE id = $1', [
            acknowledgement?.id,
          ]),
        ).rejects.toThrow('operation timeline events are append-only')
      } finally {
        if (sqlConnected) await sql.end()
        await database.disconnect()
      }
    })

    it('keeps platform cost estimates separate from reconciled actuals', async () => {
      const database = createDatabaseClient(databaseUrl as string)
      const accountId = `acct_${randomUUID().replaceAll('-', '')}`
      const credentialId = `cred_${randomUUID().replaceAll('-', '')}`
      const costId = `cost_${randomUUID().replaceAll('-', '')}`

      try {
        await database.createAgentAccount({
          id: accountId,
          name: 'platform-cost-integration-agent',
          solanaPublicKey: `${accountId}_public`,
          encryptedSolanaSecret: 'ciphertext',
          encryptionNonce: 'bm9uY2U=',
          encryptionAuthTag: 'dGFn',
          credentialId,
          keyHash: `${accountId}_hash`,
          keyPrefix: 'apa_integration',
        })

        const input = {
          id: costId,
          accountId,
          assetId: 'asset_sol',
          estimatedAmount: 7n,
        }
        const estimate = await database.v2Operations.createPlatformCostEstimate(input)
        expect(estimate).toMatchObject({
          id: costId,
          estimatedAmount: 7n,
          actualAmount: null,
          reconciliationStatus: 'ESTIMATED',
        })
        await expect(
          database.v2Operations.createPlatformCostEstimate(input),
        ).resolves.toMatchObject({ id: costId, actualAmount: null })

        const observedAt = new Date('2026-09-18T00:00:00.000Z')
        const reconciled = await database.v2Operations.reconcilePlatformCost({
          id: costId,
          actualAmount: 4n,
          observedAt,
        })
        expect(reconciled).toMatchObject({
          estimatedAmount: 7n,
          actualAmount: 4n,
          reconciliationStatus: 'RECONCILED',
          observedAt,
        })
        await expect(
          database.v2Operations.reconcilePlatformCost({
            id: costId,
            actualAmount: 4n,
            observedAt,
          }),
        ).resolves.toMatchObject({ id: costId, actualAmount: 4n })
        await expect(
          database.v2Operations.reconcilePlatformCost({
            id: costId,
            actualAmount: 5n,
            observedAt,
          }),
        ).rejects.toBeInstanceOf(ConflictError)

        const timeline = await database.v2Operations.listTimeline({
          accountId,
          limit: 10,
        })
        expect(timeline.map((event) => event.eventType)).toEqual(
          expect.arrayContaining([
            'PLATFORM_COST_ESTIMATED',
            'PLATFORM_COST_RECONCILED',
          ]),
        )
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
        const [first, duplicate] = await Promise.all([
          database.createIncomingPayment({
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
          }),
          database.createIncomingPayment({
            id: `in_${randomUUID().replaceAll('-', '')}`,
            accountId,
            signature: 'chain-signature-42',
            amountAtomic: 1250n,
            currency: 'USD',
            sourceAddress: 'source-wallet',
            reference: request.reference,
            tokenAccount: 'destination-token-account',
            settlementMint: 'settlement-mint',
            confirmedAt: new Date(),
          }),
        ])
        expect([first.created, duplicate.created].sort()).toEqual([false, true])
        expect(first.payment.id).toBe(duplicate.payment.id)
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
      const confirmedAt = new Date(Date.now() + 1_000)
      const expiresAt = new Date(confirmedAt.getTime() + 1_000)

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

    it('reconciles a managed receive after a resumed validator reports an old block time', async () => {
      const database = createDatabaseClient(databaseUrl as string)
      const sql = new Client({ connectionString: databaseUrl as string })
      const payerId = `acct_${randomUUID().replaceAll('-', '')}`
      const merchantId = `acct_${randomUUID().replaceAll('-', '')}`
      const receiveId = `recv_${randomUUID().replaceAll('-', '')}`
      const incomingId = `in_${randomUUID().replaceAll('-', '')}`
      const paymentId = `pay_${randomUUID().replaceAll('-', '')}`
      const attemptId = `att_${randomUUID().replaceAll('-', '')}`
      const signature = `signature-${randomUUID()}`
      const reference = `order-${randomUUID()}`
      await sql.connect()
      try {
        for (const accountId of [payerId, merchantId]) {
          await database.createAgentAccount({
            id: accountId,
            name: 'resumed-validator-integration-agent',
            solanaPublicKey: `${accountId}_public`,
            encryptedSolanaSecret: 'ciphertext',
            encryptionNonce: 'bm9uY2U=',
            encryptionAuthTag: 'dGFn',
            credentialId: `cred_${randomUUID().replaceAll('-', '')}`,
            keyHash: `${accountId}_hash`,
            keyPrefix: 'apa_integration',
          })
        }
        await database.createReceiveRequest({
          id: receiveId,
          accountId: merchantId,
          amountAtomic: 3n,
          currency: 'USD',
          reference,
        })
        const incoming = await database.createIncomingPayment({
          id: incomingId,
          accountId: merchantId,
          signature,
          amountAtomic: 3n,
          currency: 'USD',
          reference,
          tokenAccount: 'merchant-token-account',
          settlementMint: 'local-mint',
          confirmedAt: new Date('2020-01-01T00:00:00.000Z'),
        })
        expect(incoming.payment.receiveRequestId).toBeNull()

        const confirmedAt = new Date(Date.now() + 1_000)
        await sql.query(
          `INSERT INTO payments
             (id, payer_account_id, kind, amount_atomic, denomination_id, amount_scale,
              currency, status, external_reference, recipient_managed_account_id,
              confirmed_at, updated_at)
           VALUES ($1, $2, 'PAY', 30000, 'localnet_usd', 6, 'USD', 'CONFIRMED',
                   $3, $4, $5, NOW())`,
          [paymentId, payerId, reference, merchantId, confirmedAt],
        )
        await sql.query(
          `INSERT INTO payment_attempts
             (id, payment_id, attempt_number, rail, status, rail_transaction_id, updated_at)
           VALUES ($1, $2, 1, 'SOLANA_SPL', 'CONFIRMED', $3, NOW())`,
          [attemptId, paymentId, signature],
        )

        expect(
          await database.reconcileUnmatchedManagedIncoming?.(50),
        ).toBeGreaterThanOrEqual(1)
        const receive = await database.findReceiveRequestForOwner(merchantId, receiveId)
        expect(receive?.status).toBe('PAID')
        expect(receive?.matchedIncomingPaymentId).toBe(incomingId)
        const timestamps = await sql.query<{ same: boolean }>(
          `SELECT receive.paid_at = payment.confirmed_at AS same
           FROM receive_requests receive, payments payment
           WHERE receive.id = $1 AND payment.id = $2`,
          [receiveId, paymentId],
        )
        expect(timestamps.rows[0]?.same).toBe(true)
      } finally {
        await sql.query(
          'UPDATE incoming_payments SET receive_request_id = NULL WHERE id = $1',
          [incomingId],
        )
        await sql.query(
          'UPDATE receive_requests SET matched_incoming_payment_id = NULL WHERE id = $1',
          [receiveId],
        )
        await sql.query('DELETE FROM receive_requests WHERE id = $1', [receiveId])
        await sql.query('DELETE FROM incoming_payments WHERE id = $1', [incomingId])
        await sql.query('DELETE FROM payment_attempts WHERE id = $1', [attemptId])
        await sql.query('DELETE FROM payments WHERE id = $1', [paymentId])
        await sql.query('DELETE FROM api_credentials WHERE account_id = ANY($1)', [
          [payerId, merchantId],
        ])
        await sql.query('DELETE FROM agent_accounts WHERE id = ANY($1)', [
          [payerId, merchantId],
        ])
        await sql.end()
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
          createdAt: new Date('2026-09-06T11:00:00.000Z'),
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

    it('defers webhook capacity pressure without exhausting real delivery retries', async () => {
      const database = createDatabaseClient(databaseUrl as string)
      const sql = new Client({ connectionString: databaseUrl as string })
      const accountId = `acct_${randomUUID().replaceAll('-', '')}`
      const subscriptionId = `sub_${randomUUID().replaceAll('-', '')}`
      const eventId = `evt_${randomUUID().replaceAll('-', '')}`
      let deliveryId: string | undefined
      let sqlConnected = false

      try {
        await database.createAgentAccount({
          id: accountId,
          name: 'webhook-capacity-agent',
          solanaPublicKey: `${accountId}_public`,
          encryptedSolanaSecret: 'ciphertext',
          encryptionNonce: 'bm9uY2U=',
          encryptionAuthTag: 'dGFn',
          credentialId: `cred_${randomUUID().replaceAll('-', '')}`,
          keyHash: `${accountId}_hash`,
          keyPrefix: 'apa_integration',
        })
        await database.v2Operations.createWebhookSubscription({
          id: subscriptionId,
          accountId,
          endpoint: 'https://merchant.example.test/capacity',
          eventTypes: ['test.capacity'],
          signingKeyRef: 'secret/webhook/capacity',
          signingKeyVersion: 1,
        })
        await database.v2Operations.createWebhookEvent({
          id: `webhook_event_${randomUUID().replaceAll('-', '')}`,
          eventId,
          accountId,
          resourceType: 'TEST_RESOURCE',
          resourceId: `resource_${randomUUID().replaceAll('-', '')}`,
          resourceVersion: 1,
          eventType: 'test.capacity',
          eventVersion: '1',
          rawBody: JSON.stringify({ event_id: eventId }),
        })
        await sql.connect()
        sqlConnected = true
        const delivery = await sql.query<{ id: string }>(
          'SELECT id FROM webhook_deliveries WHERE event_id = $1 AND subscription_id = $2',
          [eventId, subscriptionId],
        )
        deliveryId = delivery.rows[0]?.id
        expect(deliveryId).toBeDefined()

        for (let attempt = 0; attempt < 12; attempt += 1) {
          const owner = `webhook-capacity-owner-${attempt}`
          await sql.query(
            `UPDATE webhook_deliveries
                SET status = 'CLAIMED', attempt_count = attempt_count + 1,
                    lease_owner = $2, lease_expires_at = NOW() + INTERVAL '1 minute'
              WHERE id = $1`,
            [deliveryId, owner],
          )
          await database.v2Operations.deferWebhookDelivery({
            id: deliveryId!,
            owner,
            retryAt: new Date(Date.now() - 1_000),
            errorSafe: 'Test webhook capacity backpressure',
          })
        }

        const deferred = await sql.query<{
          status: string
          attempt_count: number
          lease_owner: string | null
          lease_expires_at: Date | null
        }>(
          'SELECT status, attempt_count, lease_owner, lease_expires_at FROM webhook_deliveries WHERE id = $1',
          [deliveryId],
        )
        expect(deferred.rows[0]).toMatchObject({
          status: 'RETRY_WAIT',
          attempt_count: 0,
          lease_owner: null,
          lease_expires_at: null,
        })

        await sql.query(
          `UPDATE webhook_deliveries
              SET status = 'CLAIMED', attempt_count = 3,
                  lease_owner = 'real-failure-owner',
                  lease_expires_at = NOW() + INTERVAL '1 minute'
            WHERE id = $1`,
          [deliveryId],
        )
        await database.v2Operations.retryWebhookDelivery({
          id: deliveryId!,
          owner: 'real-failure-owner',
          retryAt: new Date(Date.now() - 1_000),
          errorSafe: 'Test actual delivery failure',
          maxAttempts: 3,
        })
        const exhausted = await sql.query<{
          status: string
          attempt_count: number
        }>('SELECT status, attempt_count FROM webhook_deliveries WHERE id = $1', [
          deliveryId,
        ])
        expect(exhausted.rows[0]).toMatchObject({
          status: 'EXHAUSTED',
          attempt_count: 3,
        })
      } finally {
        if (sqlConnected) {
          if (deliveryId !== undefined) {
            await sql.query(
              'DELETE FROM operational_exceptions WHERE resource_id = $1',
              [deliveryId],
            )
            // Operation timeline rows are append-only by design.
            await sql.query('DELETE FROM webhook_deliveries WHERE id = $1', [
              deliveryId,
            ])
          }
          await sql.query('DELETE FROM webhook_events WHERE event_id = $1', [eventId])
          await sql.query('DELETE FROM webhook_subscriptions WHERE id = $1', [
            subscriptionId,
          ])
          await sql.end()
        }
        await database.disconnect()
      }
    })

    it('accounts sponsorship deltas once per logical payment and serializes quota', async () => {
      const database = createDatabaseClient(databaseUrl as string)
      const accountId = `acct_${randomUUID().replaceAll('-', '')}`

      try {
        await database.createAgentAccount({
          id: accountId,
          name: 'platform-fee-accounting-agent',
          solanaPublicKey: `${accountId}_public`,
          encryptedSolanaSecret: 'ciphertext',
          encryptionNonce: 'bm9uY2U=',
          encryptionAuthTag: 'dGFn',
          credentialId: `cred_${randomUUID().replaceAll('-', '')}`,
          keyHash: `${accountId}_hash`,
          keyPrefix: 'mux_integration',
        })
        const policy = {
          accountId,
          maxLamportsPerDay: 10n,
          maxTransactionsPerHour: 3,
        }
        const firstPaymentId = `pay_${randomUUID().replaceAll('-', '')}`
        await database.reserveFeeSponsorship({
          ...policy,
          paymentId: firstPaymentId,
          lamports: 4n,
        })
        await database.reserveFeeSponsorship({
          ...policy,
          paymentId: firstPaymentId,
          lamports: 7n,
        })
        await database.reserveFeeSponsorship({
          ...policy,
          paymentId: `pay_${randomUUID().replaceAll('-', '')}`,
          lamports: 3n,
        })
        await expect(
          database.reserveFeeSponsorship({
            ...policy,
            paymentId: `pay_${randomUUID().replaceAll('-', '')}`,
            lamports: 1n,
          }),
        ).rejects.toThrow('sponsorship budget is exhausted')
      } finally {
        await database.disconnect()
      }
    })

    it('does not allow concurrent sponsorship reservations to exceed quota', async () => {
      const database = createDatabaseClient(databaseUrl as string)
      const accountId = `acct_${randomUUID().replaceAll('-', '')}`

      try {
        await database.createAgentAccount({
          id: accountId,
          name: 'concurrent-platform-fee-agent',
          solanaPublicKey: `${accountId}_public`,
          encryptedSolanaSecret: 'ciphertext',
          encryptionNonce: 'bm9uY2U=',
          encryptionAuthTag: 'dGFn',
          credentialId: `cred_${randomUUID().replaceAll('-', '')}`,
          keyHash: `${accountId}_hash`,
          keyPrefix: 'mux_integration',
        })
        const results = await Promise.allSettled(
          [1, 2].map((suffix) =>
            database.reserveFeeSponsorship({
              accountId,
              paymentId: `pay_${suffix}_${randomUUID().replaceAll('-', '')}`,
              lamports: 6n,
              maxLamportsPerDay: 10n,
              maxTransactionsPerHour: 10,
            }),
          ),
        )

        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(
          1,
        )
        expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
      } finally {
        await database.disconnect()
      }
    })

    it('enforces the hourly platform-fee limit per logical payment', async () => {
      const database = createDatabaseClient(databaseUrl as string)
      const accountId = `acct_${randomUUID().replaceAll('-', '')}`

      try {
        await database.createAgentAccount({
          id: accountId,
          name: 'hourly-platform-fee-agent',
          solanaPublicKey: `${accountId}_public`,
          encryptedSolanaSecret: 'ciphertext',
          encryptionNonce: 'bm9uY2U=',
          encryptionAuthTag: 'dGFn',
          credentialId: `cred_${randomUUID().replaceAll('-', '')}`,
          keyHash: `${accountId}_hash`,
          keyPrefix: 'mux_integration',
        })
        const firstPaymentId = `pay_${randomUUID().replaceAll('-', '')}`
        const policy = {
          accountId,
          maxLamportsPerDay: 1_000n,
          maxTransactionsPerHour: 2,
        }
        await database.reserveFeeSponsorship({
          ...policy,
          paymentId: firstPaymentId,
          lamports: 1n,
        })
        await database.reserveFeeSponsorship({
          ...policy,
          paymentId: firstPaymentId,
          lamports: 2n,
        })
        await database.reserveFeeSponsorship({
          ...policy,
          paymentId: `pay_${randomUUID().replaceAll('-', '')}`,
          lamports: 1n,
        })
        await expect(
          database.reserveFeeSponsorship({
            ...policy,
            paymentId: `pay_${randomUUID().replaceAll('-', '')}`,
            lamports: 1n,
          }),
        ).rejects.toThrow('sponsorship budget is exhausted')
      } finally {
        await database.disconnect()
      }
    })

    it('claims incoming reconciliation issues once with bounded retry backoff', async () => {
      const database = createDatabaseClient(databaseUrl as string)
      const accountId = `acct_${randomUUID().replaceAll('-', '')}`
      const signature = `signature-${randomUUID()}`

      try {
        await database.createAgentAccount({
          id: accountId,
          name: 'incoming-issue-agent',
          solanaPublicKey: `${accountId}_public`,
          encryptedSolanaSecret: 'ciphertext',
          encryptionNonce: 'bm9uY2U=',
          encryptionAuthTag: 'dGFn',
          credentialId: `cred_${randomUUID().replaceAll('-', '')}`,
          keyHash: `${accountId}_hash`,
          keyPrefix: 'mux_integration',
        })
        await database.recordIncomingReconciliationIssue({
          id: `issue_${randomUUID().replaceAll('-', '')}`,
          accountId,
          signature,
          reason: 'TRANSACTION_UNAVAILABLE',
        })
        // Other integration files share the same database and may have their
        // own pending issues. Give this freshly-created issue a scheduling
        // window and assert only on its claim, not on the global batch.
        const now = new Date(Date.now() + 1_000)
        const concurrentClaims = await Promise.all([
          database.claimIncomingReconciliationIssues(100, now),
          database.claimIncomingReconciliationIssues(100, now),
        ])
        const claimed = concurrentClaims
          .flat()
          .filter((issue) => issue.signature === signature)

        expect(claimed).toHaveLength(1)
        expect(claimed[0]).toMatchObject({ accountId, retryCount: 1 })
        expect(
          (await database.claimIncomingReconciliationIssues(100, now)).some(
            (issue) => issue.signature === signature,
          ),
        ).toBe(false)
        await database.resolveIncomingReconciliationIssue(claimed[0]!.id)
        expect(
          (
            await database.claimIncomingReconciliationIssues(
              100,
              new Date(now.getTime() + 10 * 60_000),
            )
          ).some((issue) => issue.signature === signature),
        ).toBe(false)
      } finally {
        await database.disconnect()
      }
    })

    it('defers RPC backpressure without spending incoming retry or recovery budgets', async () => {
      const database = createDatabaseClient(databaseUrl as string)
      const sql = new Client({ connectionString: databaseUrl as string })
      const accountId = `acct_${randomUUID().replaceAll('-', '')}`
      const issueId = `issue_${randomUUID().replaceAll('-', '')}`
      const signature = `capacity-issue-${randomUUID()}`
      let sqlConnected = false

      try {
        await database.createAgentAccount({
          id: accountId,
          name: 'incoming-capacity-agent',
          solanaPublicKey: `${accountId}_public`,
          encryptedSolanaSecret: 'ciphertext',
          encryptionNonce: 'bm9uY2U=',
          encryptionAuthTag: 'dGFn',
          credentialId: `cred_${randomUUID().replaceAll('-', '')}`,
          keyHash: `${accountId}_hash`,
          keyPrefix: 'apa_integration',
        })
        await sql.connect()
        sqlConnected = true
        await database.recordIncomingReconciliationIssue({
          id: issueId,
          accountId,
          signature,
          reason: 'TRANSACTION_UNAVAILABLE',
        })

        let now = new Date(Date.now() + 1_000)
        for (let attempt = 0; attempt < 12; attempt += 1) {
          const claims = await database.claimIncomingReconciliationIssues(100, now)
          const claim = claims.find((item) => item.id === issueId)
          expect(claim).toMatchObject({ retryCount: 1, recoveryClaimed: false })
          await database.deferIncomingReconciliationIssue({
            issueId,
            retryAt: new Date(now.getTime() - 1_000),
            retryCount: claim!.retryCount,
            retryCountBeforeClaim: claim!.retryCountBeforeClaim,
            recoveryClaimed: claim!.recoveryClaimed,
          })
          now = new Date(now.getTime() + 10_000)
        }

        await sql.query(
          `UPDATE incoming_reconciliation_issues
              SET retry_count = 8, recovery_count = 0,
                  next_retry_at = NOW() - INTERVAL '1 second'
            WHERE id = $1`,
          [issueId],
        )
        const recoveryClaims = await database.claimIncomingReconciliationIssues(
          100,
          new Date(Date.now() + 1_000),
        )
        const recoveryClaim = recoveryClaims.find((item) => item.id === issueId)
        expect(recoveryClaim).toMatchObject({ retryCount: 9, recoveryClaimed: true })
        await database.deferIncomingReconciliationIssue({
          issueId,
          retryAt: new Date(Date.now() - 1_000),
          retryCount: recoveryClaim!.retryCount,
          retryCountBeforeClaim: recoveryClaim!.retryCountBeforeClaim,
          recoveryClaimed: recoveryClaim!.recoveryClaimed,
        })

        const state = await sql.query<{
          status: string
          retry_count: number
          recovery_count: number
        }>(
          'SELECT status, retry_count, recovery_count FROM incoming_reconciliation_issues WHERE id = $1',
          [issueId],
        )
        expect(state.rows[0]).toMatchObject({
          status: 'PENDING',
          retry_count: 8,
          recovery_count: 0,
        })

        const concurrentClaim = (
          await database.claimIncomingReconciliationIssues(
            100,
            new Date(Date.now() + 1_000),
          )
        ).find((item) => item.id === issueId)
        expect(concurrentClaim).toBeDefined()
        const deferInput = {
          issueId,
          retryAt: new Date(Date.now() - 1_000),
          retryCount: concurrentClaim!.retryCount,
          retryCountBeforeClaim: concurrentClaim!.retryCountBeforeClaim,
          recoveryClaimed: concurrentClaim!.recoveryClaimed,
        }
        const duplicateDeferrals = await Promise.allSettled([
          database.deferIncomingReconciliationIssue(deferInput),
          database.deferIncomingReconciliationIssue(deferInput),
        ])
        expect(
          duplicateDeferrals.filter((result) => result.status === 'fulfilled'),
        ).toHaveLength(1)
        expect(
          duplicateDeferrals.filter((result) => result.status === 'rejected'),
        ).toHaveLength(1)

        const finalState = await sql.query<{
          status: string
          retry_count: number
          recovery_count: number
        }>(
          'SELECT status, retry_count, recovery_count FROM incoming_reconciliation_issues WHERE id = $1',
          [issueId],
        )
        expect(finalState.rows[0]).toMatchObject({
          status: 'PENDING',
          retry_count: 8,
          recovery_count: 0,
        })

        await sql.query(
          `UPDATE incoming_reconciliation_issues
              SET retry_count = 9, recovery_count = 0,
                  next_retry_at = NOW() - INTERVAL '1 second'
            WHERE id = $1`,
          [issueId],
        )
        const saturatedClaim = (
          await database.claimIncomingReconciliationIssues(
            100,
            new Date(Date.now() + 1_000),
          )
        ).find((item) => item.id === issueId)
        expect(saturatedClaim).toMatchObject({
          retryCount: 9,
          retryCountBeforeClaim: 9,
          recoveryClaimed: true,
        })
        await database.deferIncomingReconciliationIssue({
          issueId,
          retryAt: new Date(Date.now() - 1_000),
          retryCount: saturatedClaim!.retryCount,
          retryCountBeforeClaim: saturatedClaim!.retryCountBeforeClaim,
          recoveryClaimed: saturatedClaim!.recoveryClaimed,
        })
        const saturatedState = await sql.query<{
          status: string
          retry_count: number
          recovery_count: number
        }>(
          'SELECT status, retry_count, recovery_count FROM incoming_reconciliation_issues WHERE id = $1',
          [issueId],
        )
        expect(saturatedState.rows[0]).toMatchObject({
          status: 'PENDING',
          retry_count: 9,
          recovery_count: 0,
        })
      } finally {
        if (sqlConnected) await sql.end()
        await database.disconnect()
      }
    })

    it('makes the final reconciliation attempt recoverable after a worker crash', async () => {
      const database = createDatabaseClient(databaseUrl as string)
      const sql = new Client({ connectionString: databaseUrl as string })
      const accountId = `acct_${randomUUID().replaceAll('-', '')}`
      const issueId = `issue_${randomUUID().replaceAll('-', '')}`
      const signature = `crashed-issue-${randomUUID()}`
      let sqlConnected = false

      try {
        await sql.connect()
        sqlConnected = true
        await database.createAgentAccount({
          id: accountId,
          name: 'incoming-issue-crash-agent',
          solanaPublicKey: `${accountId}_public`,
          encryptedSolanaSecret: 'ciphertext',
          encryptionNonce: 'bm9uY2U=',
          encryptionAuthTag: 'dGFn',
          credentialId: `cred_${randomUUID().replaceAll('-', '')}`,
          keyHash: `${accountId}_hash`,
          keyPrefix: 'mux_integration',
        })
        await database.recordIncomingReconciliationIssue({
          id: issueId,
          accountId,
          signature,
          reason: 'TRANSACTION_UNAVAILABLE',
        })

        let now = new Date(Date.now() + 1_000)
        for (
          let expectedRetryCount = 1;
          expectedRetryCount <= 8;
          expectedRetryCount += 1
        ) {
          const claimed = await database.claimIncomingReconciliationIssues(100, now)
          const currentIssue = claimed.find((issue) => issue.id === issueId)
          expect(currentIssue).toMatchObject({
            id: issueId,
            retryCount: expectedRetryCount,
          })
          now = new Date(now.getTime() + 10 * 60_000)
        }

        const recovered = await database.claimIncomingReconciliationIssues(100, now)
        expect(recovered.find((issue) => issue.id === issueId)).toMatchObject({
          id: issueId,
          retryCount: 9,
        })
        const exhausted = await database.claimIncomingReconciliationIssues(
          100,
          new Date(now.getTime() + 10 * 60_000),
        )
        expect(exhausted.some((issue) => issue.id === issueId)).toBe(false)
        const status = await sql.query<{ status: string; recovery_count: number }>(
          'SELECT status, recovery_count FROM incoming_reconciliation_issues WHERE id = $1',
          [issueId],
        )
        expect(status.rows[0]).toMatchObject({ status: 'EXHAUSTED', recovery_count: 1 })
      } finally {
        if (sqlConnected) await sql.end()
        await database.disconnect()
      }
    })

    it('rejects fractional leases and stale work-item mutations', async () => {
      const database = createDatabaseClient(databaseUrl as string)
      const sql = new Client({ connectionString: databaseUrl as string })
      const workItemId = `work_${randomUUID().replaceAll('-', '')}`
      const finalWorkItemId = `work_${randomUUID().replaceAll('-', '')}`
      let sqlConnected = false

      try {
        await expect(
          database.v2.claimWorkItem({
            kind: 'OUTGOING_PAYMENT',
            owner: 'fractional-lease-owner',
            leaseSeconds: 1.5,
          }),
        ).rejects.toBeInstanceOf(InvalidStateError)

        await sql.connect()
        sqlConnected = true
        await sql.query(
          `INSERT INTO durable_work_items
             (id, kind, resource_type, resource_id, status, available_at,
              lease_owner, lease_expires_at, attempt_count, max_attempts, updated_at)
           VALUES ($1, 'STALE_OUTGOING_PAYMENT', 'PAYMENT', $2, 'CLAIMED', NOW() - INTERVAL '1 second',
                   'expired-owner', NOW() - INTERVAL '1 second', 1, 10, NOW())`,
          [workItemId, `payment_${randomUUID().replaceAll('-', '')}`],
        )
        await sql.query(
          `INSERT INTO durable_work_items
             (id, kind, resource_type, resource_id, status, available_at,
              lease_owner, lease_expires_at, attempt_count, max_attempts, updated_at)
           VALUES ($1, 'OUTGOING_PAYMENT', 'PAYMENT', $2, 'CLAIMED', NOW() - INTERVAL '1 second',
                   'final-expired-owner', NOW() - INTERVAL '1 second', 10, 10, NOW())`,
          [finalWorkItemId, `payment_${randomUUID().replaceAll('-', '')}`],
        )

        const recoveredFinal = await database.v2.claimWorkItem({
          kind: 'OUTGOING_PAYMENT',
          owner: 'final-recovery-owner',
          leaseSeconds: 30,
        })
        expect(recoveredFinal).toMatchObject({
          id: finalWorkItemId,
          attemptCount: 10,
        })
        await expect(
          database.v2.completeWorkItem(finalWorkItemId, 'final-expired-owner'),
        ).rejects.toBeInstanceOf(ConflictError)
        await sql.query(
          `UPDATE durable_work_items
           SET lease_expires_at = NOW() - INTERVAL '1 second', updated_at = NOW()
           WHERE id = $1`,
          [finalWorkItemId],
        )
        const exhaustedAfterSecondCrash = await database.v2.claimWorkItem({
          kind: 'OUTGOING_PAYMENT',
          owner: 'final-recovery-owner-2',
          leaseSeconds: 30,
        })
        expect(exhaustedAfterSecondCrash).toBeNull()
        const exhaustedWorkItem = await sql.query<{
          status: string
          lease_recovery_count: number
        }>(
          'SELECT status, lease_recovery_count FROM durable_work_items WHERE id = $1',
          [finalWorkItemId],
        )
        expect(exhaustedWorkItem.rows[0]).toMatchObject({
          status: 'EXHAUSTED',
          lease_recovery_count: 1,
        })

        await expect(
          database.v2.completeWorkItem(workItemId, 'expired-owner'),
        ).rejects.toBeInstanceOf(ConflictError)
        await expect(
          database.v2.retryWorkItem({
            id: workItemId,
            owner: 'expired-owner',
            retryAt: new Date(),
            errorCode: 'TEST_RETRY',
            errorSafe: 'test retry',
          }),
        ).rejects.toBeInstanceOf(ConflictError)
        await expect(
          database.v2.failWorkItem({
            id: workItemId,
            owner: 'expired-owner',
            errorCode: 'TEST_FAILURE',
            errorSafe: 'test failure',
          }),
        ).rejects.toBeInstanceOf(ConflictError)
      } finally {
        if (sqlConnected) {
          await sql.query('DELETE FROM operational_exceptions WHERE resource_id = $1', [
            finalWorkItemId,
          ])
          await sql.query('DELETE FROM durable_work_items WHERE id IN ($1, $2)', [
            workItemId,
            finalWorkItemId,
          ])
          await sql.end()
        }
        await database.disconnect()
      }
    })

    it('does not release a newer same-owner incoming lease with an old token', async () => {
      const database = createDatabaseClient(databaseUrl as string)
      const accountId = `acct_${randomUUID().replaceAll('-', '')}`
      const credentialId = `cred_${randomUUID().replaceAll('-', '')}`
      const owner = 'explicit-owner'
      const firstClaimAt = new Date('2026-09-18T00:00:00.000Z')
      const secondClaimAt = new Date('2026-09-18T00:00:11.000Z')

      try {
        await database.createAgentAccount({
          id: accountId,
          name: 'incoming-lease-integration-agent',
          solanaPublicKey: `${accountId}_public`,
          encryptedSolanaSecret: 'ciphertext',
          encryptionNonce: 'bm9uY2U=',
          encryptionAuthTag: 'dGFn',
          credentialId,
          keyHash: `${accountId}_hash`,
          keyPrefix: 'apa_integration',
        })
        const first = await database.claimIncomingPartition!({
          accountId,
          rail: 'SOLANA_SPL',
          address: `${accountId}_address`,
          owner,
          leaseSeconds: 10,
          now: firstClaimAt,
        })
        const second = await database.claimIncomingPartition!({
          accountId,
          rail: 'SOLANA_SPL',
          address: `${accountId}_address`,
          owner,
          leaseSeconds: 20,
          now: secondClaimAt,
        })

        expect(first?.leaseExpiresAt).toEqual(new Date('2026-09-18T00:00:10.000Z'))
        expect(second?.leaseExpiresAt).toEqual(new Date('2026-09-18T00:00:31.000Z'))
        await database.releaseIncomingPartition!({
          accountId,
          rail: 'SOLANA_SPL',
          address: `${accountId}_address`,
          owner,
          leaseExpiresAt: first?.leaseExpiresAt as Date,
        })
        expect(
          (
            await database.getIncomingCursor(
              accountId,
              'SOLANA_SPL',
              `${accountId}_address`,
            )
          )?.leaseExpiresAt,
        ).toEqual(new Date('2026-09-18T00:00:31.000Z'))
        await database.releaseIncomingPartition!({
          accountId,
          rail: 'SOLANA_SPL',
          address: `${accountId}_address`,
          owner,
          leaseExpiresAt: second?.leaseExpiresAt as Date,
        })
        expect(
          (
            await database.getIncomingCursor(
              accountId,
              'SOLANA_SPL',
              `${accountId}_address`,
            )
          )?.leaseExpiresAt,
        ).toBeNull()
      } finally {
        await database.disconnect()
      }
    })

    it('initializes runtime identity safely for legacy and concurrent startup', async () => {
      const cleanupClient = new Client({ connectionString: databaseUrl as string })
      const identity = {
        rail: 'SOLANA_SPL',
        version: '1',
        cluster: 'localnet',
        settlementMint: `mint-${randomUUID()}`,
        custodyKeyFingerprint: 'a'.repeat(32),
      }
      await cleanupClient.connect()
      try {
        await cleanupClient.query(
          `DELETE FROM "RuntimeMetadata" WHERE "key" = 'runtime_identity'`,
        )
        const rejectedDatabase = createDatabaseClient(databaseUrl as string)
        let rejectedValidations = 0
        await expect(
          rejectedDatabase.initializeRuntimeIdentity(identity, async () => {
            rejectedValidations += 1
            throw new Error('wrong custody key')
          }),
        ).rejects.toThrow('wrong custody key')
        expect(rejectedValidations).toBeGreaterThan(0)
        await rejectedDatabase.disconnect()

        const first = createDatabaseClient(databaseUrl as string)
        const second = createDatabaseClient(databaseUrl as string)
        let successfulValidations = 0
        await Promise.all([
          first.initializeRuntimeIdentity(identity, async () => {
            successfulValidations += 1
          }),
          second.initializeRuntimeIdentity(identity, async () => {
            successfulValidations += 1
          }),
        ])
        expect(successfulValidations).toBeGreaterThan(0)
        await expect(
          first.initializeRuntimeIdentity({ ...identity, cluster: 'devnet' }),
        ).rejects.toThrow('Runtime financial identity mismatch')
        await first.disconnect()
        await second.disconnect()

        await cleanupClient.query(
          `DELETE FROM "RuntimeMetadata" WHERE "key" = 'runtime_identity'`,
        )
        const competingA = createDatabaseClient(databaseUrl as string)
        const competingB = createDatabaseClient(databaseUrl as string)
        const competing = await Promise.allSettled([
          competingA.initializeRuntimeIdentity(identity, async () => undefined),
          competingB.initializeRuntimeIdentity(
            { ...identity, settlementMint: `other-${identity.settlementMint}` },
            async () => undefined,
          ),
        ])
        expect(
          competing.filter((result) => result.status === 'fulfilled'),
        ).toHaveLength(1)
        expect(competing.filter((result) => result.status === 'rejected')).toHaveLength(
          1,
        )
        await competingA.disconnect()
        await competingB.disconnect()
      } finally {
        await cleanupClient.query(
          `DELETE FROM "RuntimeMetadata" WHERE "key" = 'runtime_identity'`,
        )
        await cleanupClient.end()
      }
    })
  },
)
