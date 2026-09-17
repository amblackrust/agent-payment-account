import 'dotenv/config'

import { createDatabaseClient } from '@agent-payment/db'
import {
  createSolanaIncomingReader,
  createSolanaRail,
} from '@agent-payment/solana-rail'
import type { SolanaRail } from '@agent-payment/solana-rail'
import { createSolanaRpc, type ClusterUrl } from '@solana/kit'
import {
  convertFromSettlementAtomicUnits,
  DependencyUnavailableError,
  ExternalRailError,
} from '@agent-payment/core'

import { buildApp } from './app.js'
import { AccountService } from './accounts.js'
import {
  ConfigurationError,
  getRuntimeLimits,
  loadConfig,
  redactConfig,
} from './config.js'
import { DurableCapacityController } from './capacity.js'
import {
  fingerprintWalletMasterKey,
  validateLegacyWalletCustody,
  RecoveryEnvelopeCipher,
  WalletSecretCipher,
} from './custody.js'
import { RecipientService } from './recipients.js'
import { ReceiveService } from './receives.js'
import { V2ReceiveService } from './receives.js'
import { IncomingReconciliationService } from './incoming.js'
import { TransactionService } from './transactions.js'
import { V2PaymentService } from './payments-v2.js'
import type { V2SettledBalanceProvider } from './payments-v2.js'
import { V2PaymentServiceAdapter } from './payments-v1-adapter.js'
import { V2ManagementService } from './v2-management.js'
import { V2OperationsService } from './v2-operations.js'
import { createV2OutgoingWorker } from './v2-outgoing-runtime.js'
import { evaluateDomainAlerts } from './observability.js'

async function startServer(): Promise<void> {
  const config = loadConfig()
  if (config.runtimeRole !== 'api' && config.runtimeRole !== 'all') {
    throw new ConfigurationError(
      `RUNTIME_ROLE=${config.runtimeRole} must use the dedicated worker entrypoint`,
    )
  }
  const legacyRuntimeEnabled = config.runtimeRole === 'all'
  const database = createDatabaseClient(config.databaseUrl)
  const limits = getRuntimeLimits(config)
  const capacity = new DurableCapacityController(database.v2Admin, limits)
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
      ...(config.custodyBackendIdentity === undefined
        ? {}
        : { custodyBackendIdentity: config.custodyBackendIdentity }),
      ...(config.custodyBackendMode === undefined
        ? {}
        : { custodyBackendMode: config.custodyBackendMode }),
    },
    (custody) => validateLegacyWalletCustody(walletCipher, custody),
  )
  if (config.runtimeAuthorityId !== undefined) {
    await database.initializeRuntimeAuthority(config.runtimeAuthorityId)
  }
  const fundingProvisioner = {
    provision: async (input: {
      readonly accountId: string
      readonly owner: string
    }) => {
      const routes = await database.v2.listActiveSettlementRoutes()
      const route = routes[0]
      if (route === undefined) {
        throw new DependencyUnavailableError('No active settlement route is configured')
      }
      const asset = await database.v2.findSettlementAsset(route.settlementAssetId)
      if (asset === null) {
        throw new DependencyUnavailableError(
          'Settlement asset configuration is unavailable',
        )
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
  const recipientService = new RecipientService(database, {
    maxPageSize: limits.maxPageSize,
  })
  const receiveService = new ReceiveService(database, rail)
  const v2ReceiveService = new V2ReceiveService(
    database,
    database.v2,
    database.v2Admin,
    rail,
    () => new Date(),
    { maxPageSize: limits.maxPageSize },
  )
  const transactionService = new TransactionService(database, {
    maxPageSize: limits.maxPageSize,
  })
  const v2PaymentService = new V2PaymentService({
    repository: database.v2,
    recipientRepository: database,
    settledBalanceProvider: {
      getSettledAtomic: (input) => getLogicalSettledAtomic(rail, input),
    },
    maxPageSize: limits.maxPageSize,
  })
  const v2ManagementService = new V2ManagementService({
    repository: database.v2Admin,
    financialRepository: database.v2,
    settledBalanceProvider: {
      getSettledAtomic: (input) => getLogicalSettledAtomic(rail, input),
    },
    recoveryCipher,
    maxPageSize: limits.maxPageSize,
  })
  const v2OperationsService = new V2OperationsService(database.v2Operations, {
    maxPageSize: limits.maxPageSize,
  })
  const v2OutgoingRuntime = legacyRuntimeEnabled
    ? createV2OutgoingWorker({ config, database, walletCipher })
    : undefined
  const paymentService = new V2PaymentServiceAdapter(
    v2PaymentService,
    database.v2,
    limits.maxPageSize,
  )
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
      await v2OutgoingRuntime?.checkReadiness()
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
    domainHealthDependency: {
      checkDomainHealth: async () => {
        const health = await database.v2Operations.getDomainHealth?.()
        if (health === undefined) return { status: 'ok', checks: {} }
        const alerts = evaluateDomainAlerts({
          reviewRequiredPayments: health.reviewRequiredPayments,
          oldestReviewRequiredAgeSeconds: health.oldestReviewRequiredAgeSeconds ?? null,
          exhaustedIncomingIssues: health.exhaustedIncomingIssues,
          custodyFailures: 0,
          noProgressSeconds: null,
          databaseSaturationRatio: null,
          dependencyDegraded: false,
          pendingWebhookDeliveries: health.pendingWebhookDeliveries,
          restoreVerificationFailed: false,
          runtimeIdentityMismatch: false,
        })
        const checks = {
          review_required:
            health.reviewRequiredPayments === 0
              ? ('ok' as const)
              : ('degraded' as const),
          incoming_issues:
            health.exhaustedIncomingIssues === 0
              ? ('ok' as const)
              : ('degraded' as const),
          webhooks:
            health.pendingWebhookDeliveries === 0
              ? ('ok' as const)
              : ('degraded' as const),
        }
        return {
          status: Object.values(checks).includes('degraded')
            ? ('degraded' as const)
            : ('ok' as const),
          checks,
          alerts,
        }
      },
    },
  })
  const incomingReconciliation = legacyRuntimeEnabled
    ? new IncomingReconciliationService(
        database,
        incomingReader,
        {
          error: (data, message) => app.log.error(data, message),
        },
        {
          accountConcurrency: limits.incomingAccountConcurrency,
          capacity,
        },
      )
    : undefined
  const runWorkers = (): void => {
    void incomingReconciliation?.runOnce().catch((error: unknown) => {
      app.log.error(
        { errorCode: error instanceof Error ? error.name : 'UNKNOWN' },
        'Incoming reconciliation loop failed',
      )
    })
    void v2OutgoingRuntime?.worker.runOnce().catch((error: unknown) => {
      app.log.error(
        { errorCode: error instanceof Error ? error.name : 'UNKNOWN' },
        'V2 outgoing execution loop failed',
      )
    })
  }
  let reconciliationTimer: NodeJS.Timeout | undefined
  app.addHook('onClose', async () => {
    if (reconciliationTimer !== undefined) clearInterval(reconciliationTimer)
    incomingReconciliation?.stop()
    v2OutgoingRuntime?.worker.stop()
    await Promise.all([
      incomingReconciliation?.drain(),
      v2OutgoingRuntime?.worker.drain(),
    ])
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
    if (legacyRuntimeEnabled) {
      runWorkers()
      reconciliationTimer = setInterval(runWorkers, 5_000)
    }
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

async function getLogicalSettledAtomic(
  rail: SolanaRail,
  input: Parameters<V2SettledBalanceProvider['getSettledAtomic']>[0],
): Promise<bigint> {
  const balance = await rail.getSettlementBalance(input.account.account.solanaPublicKey)
  if (balance.tokenDecimals !== input.settlementAsset.decimals) {
    throw new ExternalRailError(
      'Settlement token decimals differ from the persisted asset configuration',
    )
  }
  return convertFromSettlementAtomicUnits(
    balance.tokenAtomicUnits,
    input.economicMapping,
    input.denomination,
    input.settlementAsset,
  ).atomicUnits
}
