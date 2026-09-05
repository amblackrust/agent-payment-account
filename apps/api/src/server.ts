import 'dotenv/config'

import { createDatabaseClient } from '@agent-payment/db'
import { createSolanaPaymentRail, createSolanaRail } from '@agent-payment/solana-rail'
import { ExternalRailError } from '@agent-payment/core'

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
  const walletCipher = new WalletSecretCipher(config.walletMasterKey)
  const accountService = new AccountService(database, walletCipher, rail)
  const recipientService = new RecipientService(database)
  const payerSecretKeyProvider = async (accountId: string): Promise<Uint8Array> => {
    const custody = await database.findAccountCustody(accountId)
    if (custody === null) {
      throw new ExternalRailError('Payer account custody is unavailable')
    }
    const secret = walletCipher.decrypt({
      ciphertext: custody.encryptedSolanaSecret,
      nonce: custody.encryptionNonce,
      authTag: custody.encryptionAuthTag,
    })
    return secret
  }
  const paymentRail = createSolanaPaymentRail({
    rpcUrl: config.solanaRpcUrl,
    expectedCluster: config.solanaCluster,
    allowMainnet: config.allowMainnet,
    settlementMint: config.solanaSettlementMint,
    feePayerSecret: config.solanaFeePayerSecret,
  })
  const paymentService = new PaymentService(
    database,
    rail,
    [paymentRail],
    payerSecretKeyProvider,
  )
  const app = buildApp({
    config,
    readinessDependency: database,
    accountRepository: database,
    accountService,
    solanaRail: rail,
    recipientService,
    paymentService,
    reservationRepository: database,
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
