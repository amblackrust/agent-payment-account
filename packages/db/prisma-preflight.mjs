import pg from 'pg'

const databaseUrl = process.env.DATABASE_URL?.trim()
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required for Prisma migration preflight')
}

const client = new pg.Client({ connectionString: databaseUrl })
await client.connect()
try {
  const duplicateChecks = [
    {
      table: 'payment_attempts',
      query:
        'SELECT payment_id, COUNT(*)::int AS count FROM payment_attempts GROUP BY payment_id HAVING COUNT(*) > 1 LIMIT 1',
      message:
        'Migration preflight failed: multiple payment attempts exist for one payment. Repair duplicates before applying the single-attempt migration.',
    },
    {
      table: 'incoming_payments',
      query:
        'SELECT receive_request_id, COUNT(*)::int AS count FROM incoming_payments WHERE receive_request_id IS NOT NULL GROUP BY receive_request_id HAVING COUNT(*) > 1 LIMIT 1',
      message:
        'Migration preflight failed: multiple incoming payments are bound to one receive request. Repair duplicate matches before applying the unique receive migration.',
    },
  ]

  for (const check of duplicateChecks) {
    const table = await client.query('SELECT to_regclass($1) AS name', [check.table])
    if (table.rows[0]?.name === null) continue
    const result = await client.query(check.query)
    if (result.rowCount !== 0) throw new Error(check.message)
  }
} finally {
  await client.end()
}
