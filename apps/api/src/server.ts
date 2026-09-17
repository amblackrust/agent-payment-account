import 'dotenv/config'

import { createDatabaseClient } from '@agent-payment/db'
import {
  createSolanaIncomingReader,
  createSolanaPaymentRail,
  createSolanaRail,
} from '@agent-payment/solana-rail'
import { createSolanaRpc, type ClusterUrl } from '@solana/kit'
import { DependencyUnavailableError, ExternalRailError } from '@agent-payment/core'

import { buildApp } from './app.js'
import { AccountService } from './accounts.js'
import { loadConfig, redactConfig } from './config.js'
import {
  fingerprintWalletMasterKey,
  validateLegacyWalletCustody,
  RecoveryEnvelopeCipher,
  WalletSecretCipher,
} from './custody.js'
import { PaymentService } from './payments.js'
import { RecipientService } from './recipients.js'
import { ReceiveService } from './receives.js'
import { V2ReceiveService } from './receives.js'
import { IncomingReconciliationService } from './incoming.js'
import { OutgoingPaymentReconciliationService } from './outgoing.js'
import { TransactionService } from './transactions.js'
import { V2PaymentService } from './payments-v2.js'
import { V2ManagementService } from './v2-management.js'
import { V2OperationsService } from './v2-operations.js'

const SPONSORSHIP_MAX_LAMPORTS_PER_DAY = 10_000_000n
const SPONSORSHIP_MAX_TRANSACTIONS_PER_HOUR = 60

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
  const recoveryCipher = new RecoveryEnvelopeCipher(config.recoveryEnvelopeKey)
  await database.initializeRuntimeIdentity(
    {
      rail: 'SOLANA_SPL',
      version: '1',
      cluster: config.solanaCluster,
      settlementMint: config.solanaSettlementMint,
      custodyKeyFingerprint: fingerprintWalletMasterKey(config.walletMasterKey),
    },
    (custody) => validateLegacyWalletCustody(walletCipher, custody),
  )
  const fundingProvisioner = {
    provision: async (input: { readonly accountId: string; readonly owner: string }) => {
      const routes = await database.v2.listActiveSettlementRoutes()
      const route = routes[0]
      if (route === undefined) {
        throw new DependencyUnavailableError('No active settlement route is configured')
      }
      const asset = await database.v2.findSettlementAsset(route.settlementAssetId)
      if (asset === null) {
        throw new DependencyUnavailableError('Settlement asset configuration is unavailable')
      }
      const destination = await rail.getReceiveDestination(input.owner)
      await database.v2Admin.upsertFundingDestination({
        id: `funding_${input.accountId}_${route.id}_${asset.id}`,
        accountId: input.accountId,
        routeId: route.id,
        network: route.network,
        assetId: asset.id,
        destination: destination.tokenAccount,
        readiness: 'READY',
        senderConstraintsJson: JSON.stringify({
          rail: route.rail,
          asset_reference: asset.assetReference,
          destination_owner: destination.owner,
        }),
        lastValidatedAt: new Date(),
      })
    },
  }
  const accountService = new AccountService(
    database,
    walletCipher,
    rail,
    database.v2Admin,
    recoveryCipher,
    fundingProvisioner,
  )
  const recipientService = new RecipientService(database)
  const receiveService = new ReceiveService(database, rail)
  const v2ReceiveService = new V2ReceiveService(database, database.v2, database.v2Admin, rail)
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
    undefined,
    {
      maxLamportsPerDay: SPONSORSHIP_MAX_LAMPORTS_PER_DAY,
      maxTransactionsPerHour: SPONSORSHIP_MAX_TRANSACTIONS_PER_HOUR,
    },
  )
  const transactionService = new TransactionService(database)
  const v2PaymentService = new V2PaymentService({
    repository: database.v2,
    recipientRepository: database,
    settledBalanceProvider: {
      getSettledAtomic: async ({ account, denomination }) => {
        if (denomination.symbol !== 'USD' || denomination.maxScale !== 2) {
          throw new ExternalRailError(
            'The configured Solana balance provider cannot represent this denomination exactly',
          )
        }
        const balance = await rail.getSettlementBalance(account.account.solanaPublicKey)
        return balance.settled.atomicUnits
      },
    },
  })
  const v2ManagementService = new V2ManagementService({
    repository: database.v2Admin,
    financialRepository: database.v2,
    settledBalanceProvider: {
      getSettledAtomic: async ({ account, denomination }) => {
        if (denomination.symbol !== 'USD' || denomination.maxScale !== 2) {
          throw new ExternalRailError(
            'The configured Solana balance provider cannot represent this denomination exactly',
          )
        }
        const balance = await rail.getSettlementBalance(account.account.solanaPublicKey)
        return balance.settled.atomicUnits
      },
    },
    recoveryCipher,
  })
  const v2OperationsService = new V2OperationsService(database.v2Operations)
  const incomingReader = createSolanaIncomingReader({
    rpc: createSolanaRpc(config.solanaRpcUrl as ClusterUrl),
    readRail: rail,
    rpcUrl: config.solanaRpcUrl,
    expectedCluster: config.solanaCluster,
    allowMainnet: config.allowMainnet,
    settlementMint: config.solanaSettlementMint,
  })
  const runtimeReadiness = {
    checkReadiness: async (): Promise<void> => {
      await database.checkReadiness()
      await rail.checkReadiness?.()
      await paymentRail.checkReadiness?.()
    },
  }
  const app = buildApp({
    config,
    readinessDependency: runtimeReadiness,
    accountRepository: database,
    accountService,
    solanaRail: rail,
    recipientService,
    paymentService,
    reservationRepository: database,
    receiveService,
    v2ReceiveService,
    transactionService,
    v2PaymentService,
    v2ManagementService,
    v2OperationsService,
    v2AdminRepository: database.v2Admin,
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
  let reconciliationTimer: NodeJS.Timeout | undefined
  app.addHook('onClose', async () => {
    if (reconciliationTimer !== undefined) clearInterval(reconciliationTimer)
    incomingReconciliation.stop()
    outgoingReconciliation.stop()
    await Promise.all([incomingReconciliation.drain(), outgoingReconciliation.drain()])
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
    await runtimeReadiness.checkReadiness()
    runWorkers()
    reconciliationTimer = setInterval(runWorkers, 5_000)
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
