import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { Client } from 'pg'

import { createDatabaseClient } from './index.js'

const databaseUrl = process.env.DATABASE_URL?.trim()

describe.skipIf(databaseUrl === undefined || databaseUrl.length === 0)(
  'V2 webhook delivery operations',
  () => {
    it('does not reclaim an expired lease after the durable attempt bound is reached', async () => {
      const database = createDatabaseClient(databaseUrl as string)
      const sql = new Client({ connectionString: databaseUrl as string })
      const accountId = `acct_${randomUUID().replaceAll('-', '')}`
      const subscriptionId = `sub_${randomUUID().replaceAll('-', '')}`
      const eventId = `event_${randomUUID().replaceAll('-', '')}`
      const deliveryId = `delivery_${randomUUID().replaceAll('-', '')}`
      let sqlConnected = false

      try {
        await sql.connect()
        sqlConnected = true
        await sql.query(
          `INSERT INTO agent_accounts
             (id, name, solana_public_key, encrypted_solana_secret,
              encryption_nonce, encryption_auth_tag, updated_at)
           VALUES ($1, 'webhook-integration-agent', $2, 'ciphertext', 'nonce', 'auth-tag', NOW())`,
          [accountId, `${accountId}_public`],
        )
        await sql.query(
          `INSERT INTO webhook_subscriptions
             (id, account_id, endpoint, event_types_json, signing_key_ref, signing_key_version)
           VALUES ($1, $2, 'https://merchant.example.test/webhook', '["payment.updated"]', 'secret/webhook/1', 1)`,
          [subscriptionId, accountId],
        )
        await sql.query(
          `INSERT INTO webhook_events
             (id, event_id, resource_type, resource_id, resource_version, event_type, event_version, raw_body)
           VALUES ($1, $2, 'PAYMENT', $3, 1, 'payment.updated', 'v2', '{}')`,
          [`webhook_${eventId}`, eventId, `payment_${eventId}`],
        )
        await sql.query(
          `INSERT INTO webhook_deliveries
             (id, event_id, subscription_id, delivery_number, status, available_at,
              attempt_count, lease_owner, lease_expires_at, updated_at)
           VALUES ($1, $2, $3, 1, 'CLAIMED', NOW(), 3, 'dead-worker', NOW() - INTERVAL '1 second', NOW())`,
          [deliveryId, eventId, subscriptionId],
        )

        const claims = await database.v2Operations.claimWebhookDeliveries({
          limit: 1,
          owner: 'replacement-worker',
          leaseSeconds: 30,
          maxAttempts: 3,
          now: new Date(),
        })

        expect(claims).toEqual([])
        const persisted = await sql.query<{
          status: string
          attempt_count: number
          lease_owner: string | null
          lease_expires_at: Date | null
          error_safe: string | null
        }>(
          'SELECT status, attempt_count, lease_owner, lease_expires_at, error_safe FROM webhook_deliveries WHERE id = $1',
          [deliveryId],
        )
        expect(persisted.rows[0]).toMatchObject({
          status: 'EXHAUSTED',
          attempt_count: 3,
          lease_owner: null,
          lease_expires_at: null,
          error_safe: 'Webhook delivery lease expired after maximum attempts',
        })
        const exception = await sql.query<{
          account_id: string | null
          reason_code: string
        }>(
          'SELECT account_id, reason_code FROM operational_exceptions WHERE resource_id = $1',
          [deliveryId],
        )
        expect(exception.rows[0]).toEqual({
          account_id: accountId,
          reason_code: 'WEBHOOK_DELIVERY_EXHAUSTED',
        })
        const timeline = await sql.query<{ event_type: string }>(
          `SELECT event_type
           FROM operation_timeline_events
           WHERE resource_type = 'WEBHOOK_DELIVERY' AND resource_id = $1`,
          [deliveryId],
        )
        expect(timeline.rows.map((row) => row.event_type)).toContain(
          'WEBHOOK_DELIVERY_EXHAUSTED',
        )
      } finally {
        if (sqlConnected) {
          await sql.query(
            'DELETE FROM operational_exceptions WHERE resource_id = $1',
            [deliveryId],
          )
          await sql.query('DELETE FROM webhook_deliveries WHERE id = $1', [deliveryId])
          await sql.query('DELETE FROM webhook_events WHERE event_id = $1', [eventId])
          await sql.query('DELETE FROM webhook_subscriptions WHERE id = $1', [
            subscriptionId,
          ])
          await sql.query('DELETE FROM agent_accounts WHERE id = $1', [accountId])
          await sql.end()
        }
        await database.disconnect()
      }
    })
  },
)
