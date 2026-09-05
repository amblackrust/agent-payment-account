import 'dotenv/config'

import { createDatabaseClient } from '@agent-payment/db'
import { createSolanaRail } from '@agent-payment/solana-rail'

import { buildApp } from './app.js'
import { AccountService } from './accounts.js'
import { loadConfig, redactConfig } from './config.js'
import { WalletSecretCipher } from './custody.js'
import { PaymentService } from './payments.js'
import { RecipientService } from './recipients.js'

async function startServer(): Promise<void> {
  const config = loadConfig()
  const database = createDatabaseClient(config.databaseUrl)
  const rail = createSolanaRail({
    rpcUrl: config.solanaRpcUrl,
    expectedCluster: config.solanaCluster,
    allowMainnet: config.allowMainnet,
    settlementMint: config.solanaSettlementMint,
  })
  const accountService = new AccountService(
    database,
    new WalletSecretCipher(config.walletMasterKey),
    rail,
  )
  const recipientService = new RecipientService(database)
  // Task 04 will register the real execution rail. No successful fake rail is
  // registered in production while this execution boundary is still read-only.
  const paymentService = new PaymentService(database, rail, [])
  const app = buildApp({
    config,
    readinessDependency: database,
    accountRepository: database,
    accountService,
    solanaRail: rail,
    recipientService,
    paymentService,
  })

  app.addHook('onClose', async () => {
    await database.disconnect()
  })

  try {
    await app.listen({ host: '0.0.0.0', port: config.port })
    app.log.info({ config: redactConfig(config) }, 'API started')
  } catch (error) {
    app.log.error({ err: error }, 'API failed to start')
    await app.close()
    throw error
  }
}

await startServer()
