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
  type SettlementRoute,
} from '@agent-payment/core'

import { buildApp } from './app.js'
import { AccountService } from './accounts.js'
import {
  ConfigurationError,
  DEFAULT_X402_HTTP_TIMEOUT_MS,
  DEFAULT_X402_MAX_PAYMENT_ATOMIC,
  DEFAULT_X402_RESOURCE_URL,
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
import { createDomainHealthSnapshot, MetricsRegistry } from './observability.js'
import { waitForShutdown } from './lifecycle.js'
import { buildRuntimeIdentity } from './runtime-identity.js'
import { createRuntimeOwner } from './runtime-owner.js'
import { createFundingProvisioner } from './funding-provisioner.js'
import { X402PaymentService } from './x402-service.js'
import { x402NetworkForSolanaCluster } from './x402-protocol.js'

async function startServer(): Promise<void> {
  const config = loadConfig()
  const x402Network = x402NetworkForSolanaCluster(config.solanaCluster)
  if (config.runtimeRole !== 'api' && config.runtimeRole !== 'all') {
    throw new ConfigurationError(
      `RUNTIME_ROLE=${config.runtimeRole} must use the dedicated worker entrypoint`,
    )
  }
  const legacyRuntimeEnabled = config.runtimeRole === 'all'
  const database = createDatabaseClient(config.databaseUrl)
  const limits = getRuntimeLimits(config)
  const metrics = new MetricsRegistry()
  const capacity = new DurableCapacityController(database.v2Admin, limits)
  const rail = createSolanaRail({
    rpcUrl: config.solanaRpcUrl,
    expectedCluster: config.solanaCluster,
    allowMainnet: config.allowMainnet,
    settlementMint: config.solanaSettlementMint,
  })
  const walletMasterKey = requireWalletMasterKey(config.walletMasterKey)
  const recoveryEnvelopeKey = requireRecoveryEnvelopeKey(config.recoveryEnvelopeKey)
  const walletCipher = new WalletSecretCipher(walletMasterKey)
  const recoveryCipher = new RecoveryEnvelopeCipher(recoveryEnvelopeKey)
  const runtimeIdentity = await buildRuntimeIdentity({
    database,
    config,
    custodyKeyFingerprint: fingerprintWalletMasterKey(walletMasterKey),
  })
  if (legacyRuntimeEnabled) {
    await database.initializeRuntimeIdentity(runtimeIdentity, (custody) =>
      validateLegacyWalletCustody(walletCipher, custody),
    )
  } else {
    // The dedicated API does not validate legacy signer plaintext, but it must
    // still fail closed when the persisted financial identity is absent or stale.
    await database.initializeRuntimeIdentity(runtimeIdentity)
  }
  if (config.runtimeAuthorityId !== undefined) {
    await database.initializeRuntimeAuthority(config.runtimeAuthorityId)
  }
  const fundingProvisioner = createFundingProvisioner({
    database,
    rail,
    solanaCluster: config.solanaCluster,
    settlementMint: config.solanaSettlementMint,
  })
  const accountService = new AccountService(
    database,
    walletCipher,
    rail,
    database.v2Admin,
    recoveryCipher,
    fundingProvisioner,
    limits.credentialRecoveryTtlSeconds,
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
  const routeCapabilityProvider = {
    getCapabilities: async (routes: readonly SettlementRoute[]) => {
      try {
        await rail.checkReadiness?.()
      } catch {
        throw new DependencyUnavailableError(
          'Settlement rail capability is unavailable',
        )
      }
      const observedAt = new Date()
      return Promise.all(
        routes.map(async (route) => {
          const [asset, mapping] = await Promise.all([
            database.v2.findSettlementAsset(route.settlementAssetId),
            database.v2.findEconomicMapping(route.economicMappingId),
          ])
          const reasons: string[] = []
          if (route.rail !== 'SOLANA_SPL') reasons.push('UNSUPPORTED_RAIL')
          if (route.network !== config.solanaCluster) reasons.push('NETWORK_MISMATCH')
          if (asset === null || asset.status !== 'ACTIVE') {
            reasons.push('SETTLEMENT_ASSET_UNAVAILABLE')
          } else {
            if (asset.rail !== route.rail || asset.network !== route.network) {
              reasons.push('SETTLEMENT_ASSET_MISMATCH')
            }
            if (asset.assetReference !== config.solanaSettlementMint) {
              reasons.push('SETTLEMENT_MINT_MISMATCH')
            }
          }
          if (
            mapping === null ||
            mapping.status !== 'ACTIVE' ||
            mapping.settlementAssetId !== route.settlementAssetId
          ) {
            reasons.push('ECONOMIC_MAPPING_UNAVAILABLE')
          }
          return {
            routeId: route.id,
            eligible: reasons.length === 0,
            ...(reasons.length === 0 ? {} : { reason: reasons.join(',') }),
            observedAt,
            identityVersion: [
              config.solanaCluster,
              config.solanaSettlementMint,
              route.railVersion,
              route.configVersion,
              asset?.version ?? 'missing',
              mapping?.version ?? 'missing',
            ].join(':'),
          }
        }),
      )
    },
  }
  const v2PaymentService = new V2PaymentService({
    repository: database.v2,
    recipientRepository: database,
    settledBalanceProvider: {
      getSettledAtomic: (input) => getLogicalSettledAtomic(rail, input),
    },
    routeCapabilityProvider,
    maxPageSize: limits.maxPageSize,
  })
  const x402PaymentService = new X402PaymentService({
    paymentService: v2PaymentService,
    repository: database.v2,
    resourceUrl: config.x402ResourceUrl ?? DEFAULT_X402_RESOURCE_URL,
    settlementMint: config.solanaSettlementMint,
    ...(x402Network === undefined
      ? {}
      : {
          network: x402Network,
          routeNetwork: config.solanaCluster,
        }),
    maxPaymentAtomic: config.x402MaxPaymentAtomic ?? DEFAULT_X402_MAX_PAYMENT_ATOMIC,
    httpTimeoutMs: config.x402HttpTimeoutMs ?? DEFAULT_X402_HTTP_TIMEOUT_MS,
  })
  const v2ManagementService = new V2ManagementService({
    repository: database.v2Admin,
    financialRepository: database.v2,
    settledBalanceProvider: {
      getSettledAtomic: (input) => getLogicalSettledAtomic(rail, input),
    },
    recoveryCipher,
    credentialRecoveryTtlSeconds: limits.credentialRecoveryTtlSeconds,
    maxPageSize: limits.maxPageSize,
  })
  const v2OperationsService = new V2OperationsService(database.v2Operations, {
    maxPageSize: limits.maxPageSize,
  })
  const v2OutgoingRuntime = legacyRuntimeEnabled
    ? createV2OutgoingWorker({ config, database, walletCipher, metrics })
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
    x402PaymentService,
    v2ManagementService,
    v2OperationsService,
    v2AdminRepository: database.v2Admin,
    metrics,
    domainHealthDependency: {
      checkDomainHealth: async () => {
        const health = await database.v2Operations.getDomainHealth?.({
          databaseCapacityPerWindow: limits.databaseCapacityPerWindow,
          capacityWindowSeconds: limits.capacityWindowSeconds,
          expectedRuntimeIdentity: JSON.stringify(runtimeIdentity),
        })
        if (health === undefined) return { status: 'ok', checks: {} }
        let dependencyDegraded = false
        try {
          await rail.checkReadiness?.()
        } catch {
          dependencyDegraded = true
        }
        return createDomainHealthSnapshot({
          health,
          dependencyDegraded,
          thresholds: limits.domainAlertThresholds,
        })
      },
    },
  })
  v2OutgoingRuntime?.worker.setLogger({
    info: (data, message) => app.log.info(data, message),
    error: (data, message) => app.log.error(data, message),
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
          owner: createRuntimeOwner('incoming-api'),
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
    try {
      await waitForShutdown(
        Promise.all([
          incomingReconciliation?.drain(),
          v2OutgoingRuntime?.worker.drain(),
        ]).then(() => undefined),
        limits.shutdownTimeoutMs,
        () =>
          app.log.warn(
            { shutdownTimeoutMs: limits.shutdownTimeoutMs },
            'API shutdown deadline reached; durable leases will be reclaimed',
          ),
      )
    } finally {
      await database.disconnect()
    }
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
      reconciliationTimer = setInterval(runWorkers, limits.workerIntervalMs)
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

function requireWalletMasterKey(value: string | undefined): string {
  if (value === undefined) {
    throw new ConfigurationError('WALLET_MASTER_KEY is required for the API runtime')
  }
  return value
}

function requireRecoveryEnvelopeKey(value: string | undefined): string {
  if (value === undefined) {
    throw new ConfigurationError(
      'RECOVERY_ENVELOPE_KEY is required for the API runtime',
    )
  }
  return value
}

async function getLogicalSettledAtomic(
  rail: SolanaRail,
  input: Parameters<V2SettledBalanceProvider['getSettledAtomic']>[0],
): Promise<bigint> {
  const balance =
    rail.getSettlementAtomicBalance === undefined
      ? await rail.getSettlementBalance(input.account.account.solanaPublicKey)
      : await rail.getSettlementAtomicBalance(input.account.account.solanaPublicKey)
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
