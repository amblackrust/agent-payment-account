import 'dotenv/config'

import { createDatabaseClient } from '@agent-payment/db'
import {
  createSolanaIncomingReader,
  createSolanaPaymentRail,
  createSolanaRail,
} from '@agent-payment/solana-rail'
import { createSolanaRpc, type ClusterUrl } from '@solana/kit'
import { ExternalRailError } from '@agent-payment/core'

import { buildApp } from './app.js'
import { AccountService } from './accounts.js'
import { loadConfig, redactConfig } from './config.js'
import { WalletSecretCipher } from './custody.js'
import { PaymentService } from './payments.js'
import { RecipientService } from './recipients.js'
import { ReceiveService } from './receives.js'
import { IncomingReconciliationService } from './incoming.js'
import { OutgoingPaymentReconciliationService } from './outgoing.js'
import { TransactionService } from './transactions.js'

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
  const receiveService = new ReceiveService(database, rail)
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
  const transactionService = new TransactionService(database)
  const incomingReader = createSolanaIncomingReader({
    rpc: createSolanaRpc(config.solanaRpcUrl as ClusterUrl),
    readRail: rail,
    rpcUrl: config.solanaRpcUrl,
    expectedCluster: config.solanaCluster,
    allowMainnet: config.allowMainnet,
    settlementMint: config.solanaSettlementMint,
  })
  const app = buildApp({
    config,
    readinessDependency: database,
    accountRepository: database,
    accountService,
    solanaRail: rail,
    recipientService,
    paymentService,
    reservationRepository: database,
    receiveService,
    transactionService,
  })
  paymentService.setEventSink({
    info: (data, message) => app.log.info(data, message),
  })
  const incomingReconciliation = new IncomingReconciliationService(
    database,
    incomingReader,
    { error: (data, message) => app.log.error(data, message) },
  )
  const outgoingReconciliation = new OutgoingPaymentReconciliationService(
    database,
    paymentService,
    { info: (data, message) => app.log.info(data, message) },
  )

  const runWorkers = (): void => {
    void incomingReconciliation.runOnce().catch((error: unknown) => {
      app.log.error(
        { errorCode: error instanceof Error ? error.name : 'UNKNOWN' },
        'Incoming reconciliation loop failed',
      )
    })
    void outgoingReconciliation.runOnce().catch((error: unknown) => {
      app.log.error(
        { errorCode: error instanceof Error ? error.name : 'UNKNOWN' },
        'Outgoing reconciliation loop failed',
      )
    })
  }
  runWorkers()
  const reconciliationTimer = setInterval(runWorkers, 5_000)
  app.addHook('onClose', async () => {
    clearInterval(reconciliationTimer)
    incomingReconciliation.stop()
    outgoingReconciliation.stop()
    await Promise.all([incomingReconciliation.drain(), outgoingReconciliation.drain()])
  })

  app.addHook('onClose', async () => {
    await database.disconnect()
  })

  let shutdownPromise: Promise<void> | undefined
  const shutdown = (signal: string): Promise<void> => {
    if (shutdownPromise !== undefined) return shutdownPromise
    shutdownPromise = app
      .close()
      .then(() => {
        app.log.info({ signal }, 'API shutdown complete')
      })
      .catch((error: unknown) => {
        app.log.error(
          { signal, errorCode: error instanceof Error ? error.name : 'UNKNOWN' },
          'API shutdown failed',
        )
        process.exitCode = 1
      })
    return shutdownPromise
  }
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM')
  })
  process.once('SIGINT', () => {
    void shutdown('SIGINT')
  })

  try {
    await app.listen({ host: '0.0.0.0', port: config.port })
    app.log.info({ config: redactConfig(config) }, 'API started')
  } catch (error) {
    app.log.error(
      { errorCode: error instanceof Error ? error.name : 'UNKNOWN' },
      'API failed to start',
    )
    await app.close()
    throw error
  }
}

await startServer()
