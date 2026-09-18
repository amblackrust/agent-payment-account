import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import { Client } from 'pg'
import { describe, expect, it } from 'vitest'

const databaseUrl = process.env.DATABASE_URL?.trim()
const migrationPath = new URL(
  '../prisma/migrations/20260918150000_v2_legacy_state_backfill/migration.sql',
  import.meta.url,
)

describe.skipIf(databaseUrl === undefined || databaseUrl.length === 0)(
  'V2 legacy state backfill migration',
  () => {
    it('projects legacy in-flight states and seeds idempotent reconcile work', async () => {
      const client = new Client({ connectionString: databaseUrl })
      const suffix = randomUUID().replaceAll('-', '')
      const accountId = `acct_migration_${suffix}`
      const recipientId = `rcpt_migration_${suffix}`
      const reconcilingPaymentId = `pay_recon_${suffix}`
      const confirmedPaymentId = `pay_confirmed_${suffix}`
      const now = new Date()
      const migrationSql = await readFile(migrationPath, 'utf8')

      await client.connect()
      try {
        await client.query('BEGIN')
        await client.query(
          `INSERT INTO "agent_accounts"
            ("id", "name", "solana_public_key", "encrypted_solana_secret",
             "encryption_nonce", "encryption_auth_tag", "created_at", "updated_at")
           VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
          [
            accountId,
            'legacy migration test',
            `public_${suffix}`,
            'ciphertext',
            'nonce',
            'tag',
            now,
          ],
        )
        await client.query(
          `INSERT INTO "recipients"
            ("id", "owner_account_id", "display_name", "type", "created_at", "updated_at")
           VALUES ($1, $2, $3, $4, $5, $5)`,
          [recipientId, accountId, 'legacy migration recipient', 'EXTERNAL', now],
        )
        for (const payment of [
          { id: reconcilingPaymentId, status: 'RECONCILING', amount: 123n },
          { id: confirmedPaymentId, status: 'CONFIRMED', amount: 456n },
        ]) {
          await client.query(
            `INSERT INTO "payments"
              ("id", "payer_account_id", "recipient_id", "kind", "amount_atomic",
               "currency", "status", "created_at", "updated_at")
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
            [
              payment.id,
              accountId,
              recipientId,
              'PAY',
              payment.amount,
              'USD',
              payment.status,
              now,
            ],
          )
        }

        await client.query(migrationSql)
        await client.query(migrationSql)

        const payments = await client.query<{
          id: string
          execution_state: string
          settlement_state: string
          outcome_state: string
        }>(
          `SELECT "id", "execution_state", "settlement_state", "outcome_state"
             FROM "payments"
            WHERE "id" IN ($1, $2)
            ORDER BY "id"`,
          [confirmedPaymentId, reconcilingPaymentId],
        )
        expect(payments.rows).toEqual([
          {
            id: confirmedPaymentId,
            execution_state: 'TERMINAL',
            settlement_state: 'CONFIRMED',
            outcome_state: 'CONFIRMED',
          },
          {
            id: reconcilingPaymentId,
            execution_state: 'RECONCILING',
            settlement_state: 'UNKNOWN',
            outcome_state: 'UNDETERMINED',
          },
        ])

        const workItems = await client.query(
          `SELECT "kind", "resource_type", "resource_id"
             FROM "durable_work_items"
            WHERE "resource_id" = $1`,
          [reconcilingPaymentId],
        )
        expect(workItems.rows).toEqual([
          {
            kind: 'RECONCILE_PAYMENT_ATTEMPT',
            resource_type: 'PAYMENT',
            resource_id: reconcilingPaymentId,
          },
        ])
      } finally {
        try {
          await client.query('ROLLBACK')
        } finally {
          await client.end()
        }
      }
    })
  },
)
