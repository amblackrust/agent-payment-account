import { createDatabaseClient } from '@agent-payment/db'

const databaseUrl = process.env.DATABASE_URL?.trim()
const settlementMint = process.env.SOLANA_SETTLEMENT_MINT?.trim()

if (databaseUrl === undefined || databaseUrl.length === 0) {
  throw new Error('DATABASE_URL is required to configure the local settlement route')
}
if (settlementMint === undefined || settlementMint.length === 0) {
  throw new Error(
    'SOLANA_SETTLEMENT_MINT is required to configure the local settlement route',
  )
}

const database = createDatabaseClient(databaseUrl)
try {
  const result = await database.v2.ensureLocalSettlementConfiguration({
    settlementMint,
  })
  console.log('✓ Local settlement route ready')
  if (result.retiredDevnetRoute) {
    console.log('✓ Unreferenced devnet x402 route retired')
  }
} catch (error) {
  const message =
    error instanceof Error ? error.message : 'Unknown local settlement setup error'
  console.error(`Local settlement setup failed: ${message}`)
  process.exitCode = 1
} finally {
  await database.disconnect()
}
