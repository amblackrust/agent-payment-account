import 'dotenv/config'

import { execFile } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { createDatabaseClient } from '@agent-payment/db'
import {
  createSolanaIncomingReader,
  createSolanaRail,
  createSolanaV2OutgoingExecutor,
  signSolanaV2PreparedEffect,
} from '@agent-payment/solana-rail'
import { createSolanaRpc, type ClusterUrl } from '@solana/kit'
import { DependencyUnavailableError } from '@agent-payment/core'

import { buildApp } from './app.js'
import { ConfigurationError, loadConfig, redactConfig } from './config.js'
import { IncomingReconciliationService } from './incoming.js'
import { WebhookDeliveryWorker, type WebhookSigningKeyProvider } from './webhooks.js'
import {
  ConstrainedCustodyBoundary,
  fingerprintWalletMasterKey,
  validateLegacyWalletCustody,
  WalletSecretCipher,
} from './custody.js'
import type { ConstrainedCustodyBackend } from './custody.js'
import { V2OutgoingWorker } from './outgoing-v2.js'

const SPONSORSHIP_MAX_LAMPORTS_PER_DAY = 10_000_000n
const SPONSORSHIP_MAX_TRANSACTIONS_PER_HOUR = 60
const WORKER_INTERVAL_MS = 5_000
const execFileAsync = promisify(execFile)

interface RuntimeWorker {
  runOnce(): Promise<void>
  stop(): void
  drain(): Promise<void>
}

class EnvironmentWebhookSigningKeyProvider implements WebhookSigningKeyProvider {
  private readonly keys: ReadonlyMap<string, Uint8Array>

  public constructor(serialized: string | undefined) {
    if (serialized === undefined) {
      throw new ConfigurationError(
        'WEBHOOK_SIGNING_KEYS_JSON is required for the webhook runtime role',
      )
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(serialized) as unknown
    } catch {
      throw new ConfigurationError('WEBHOOK_SIGNING_KEYS_JSON must be valid JSON')
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed) ||
      Object.values(parsed).some((value) => typeof value !== 'string')
    ) {
      throw new ConfigurationError(
        'WEBHOOK_SIGNING_KEYS_JSON must map key references to base64 strings',
      )
    }
    const entries = Object.entries(parsed).map(([reference, value]) => {
      const bytes = Buffer.from(value, 'base64')
      if (
        reference.length === 0 ||
        bytes.length < 16 ||
        bytes.toString('base64') !== value
      ) {
        throw new ConfigurationError(
          'WEBHOOK_SIGNING_KEYS_JSON contains an invalid signing key',
        )
      }
      return [reference, new Uint8Array(bytes)] as const
    })
    this.keys = new Map(entries)
  }

  public async getKey(reference: string, version: number): Promise<Uint8Array> {
    const key = this.keys.get(`${reference}:${version}`)
    if (key === undefined) throw new Error('Webhook signing key is unavailable')
    return new Uint8Array(key)
  }
}

class MaintenanceWorker implements RuntimeWorker {
  private stopped = false
  private currentRun: Promise<void> | undefined

  public constructor(
    private readonly outputDirectory: string,
    private readonly recipient: string | undefined,
    private readonly identity: string | undefined,
    private readonly verifyDatabaseUrl: string | undefined,
  ) {
    if (recipient === undefined) {
      throw new ConfigurationError(
        'BACKUP_AGE_RECIPIENT is required for the maintenance runtime role',
      )
    }
    if ((identity === undefined) !== (verifyDatabaseUrl === undefined)) {
      throw new ConfigurationError(
        'Backup verification identity and database URL must be configured together',
      )
    }
  }

  public runOnce(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    if (this.currentRun !== undefined) return this.currentRun
    const run = this.createAndVerifyBackup()
    let tracked: Promise<void>
    tracked = run.finally(() => {
      if (this.currentRun === tracked) this.currentRun = undefined
    })
    this.currentRun = tracked
    return tracked
  }

  public stop(): void {
    this.stopped = true
  }

  public async drain(): Promise<void> {
    await this.currentRun
  }

  private async createAndVerifyBackup(): Promise<void> {
    mkdirSync(this.outputDirectory, { recursive: true, mode: 0o700 })
    const timestamp = new Date().toISOString().replaceAll(/[:.]/gu, '-')
    const output = path.join(this.outputDirectory, `mux-${timestamp}.dump.age`)
    const script = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../scripts/backup-verify.mjs',
    )
    const environment = {
      ...process.env,
      BACKUP_AGE_RECIPIENT: this.recipient,
      ...(this.identity === undefined ? {} : { BACKUP_AGE_IDENTITY: this.identity }),
      ...(this.verifyDatabaseUrl === undefined
        ? {}
        : { BACKUP_VERIFY_DATABASE_URL: this.verifyDatabaseUrl }),
    }
    await execFileAsync(process.execPath, [script, 'backup', output], {
      env: environment,
    })
    if (this.identity !== undefined && this.verifyDatabaseUrl !== undefined) {
      await execFileAsync(process.execPath, [script, 'verify', output], {
        env: environment,
      })
    }
  }
}

async function startWorker(): Promise<void> {
  const config = loadConfig()
  if (config.runtimeRole === 'api' || config.runtimeRole === 'all') {
    throw new ConfigurationError(
      `RUNTIME_ROLE=${config.runtimeRole} must use src/server.ts, not src/worker.ts`,
    )
  }

  const database = createDatabaseClient(config.databaseUrl)
  const rail = createSolanaRail({
    rpcUrl: config.solanaRpcUrl,
    expectedCluster: config.solanaCluster,
    allowMainnet: config.allowMainnet,
    settlementMint: config.solanaSettlementMint,
  })
  const walletCipher = new WalletSecretCipher(config.walletMasterKey)
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

  const v2OutgoingRuntime =
    config.runtimeRole === 'outgoing'
      ? createV2OutgoingWorker({ config, database, walletCipher })
      : undefined

  const incomingReader =
    config.runtimeRole === 'incoming'
      ? createSolanaIncomingReader({
          rpc: createSolanaRpc(config.solanaRpcUrl as ClusterUrl),
          readRail: rail,
          rpcUrl: config.solanaRpcUrl,
          expectedCluster: config.solanaCluster,
          allowMainnet: config.allowMainnet,
          settlementMint: config.solanaSettlementMint,
        })
      : undefined

  const worker: RuntimeWorker = createWorker({
    role: config.runtimeRole,
    database,
    ...(incomingReader === undefined ? {} : { incomingReader }),
    ...(v2OutgoingRuntime === undefined
      ? {}
      : { v2OutgoingWorker: v2OutgoingRuntime.worker }),
    ...(config.runtimeRole === 'webhook'
      ? {
          webhookSigningKeys: new EnvironmentWebhookSigningKeyProvider(
            config.webhookSigningKeysJson,
          ),
        }
      : {}),
    ...(config.runtimeRole === 'maintenance'
      ? {
          ...(config.backupOutputDirectory === undefined
            ? {}
            : { backupOutputDirectory: config.backupOutputDirectory }),
          ...(config.backupAgeRecipient === undefined
            ? {}
            : { backupAgeRecipient: config.backupAgeRecipient }),
          ...(config.backupAgeIdentity === undefined
            ? {}
            : { backupAgeIdentity: config.backupAgeIdentity }),
          ...(config.backupVerifyDatabaseUrl === undefined
            ? {}
            : { backupVerifyDatabaseUrl: config.backupVerifyDatabaseUrl }),
        }
      : {}),
  })

  let lastWorkerError: string | undefined
  const app = buildApp({
    config,
    readinessDependency: {
      checkReadiness: async () => {
        await database.checkReadiness()
        await rail.checkReadiness?.()
        await v2OutgoingRuntime?.checkReadiness()
      },
    },
    domainHealthDependency: {
      checkDomainHealth: async () => ({
        status: lastWorkerError === undefined ? 'ok' : 'degraded',
        checks: {
          worker: lastWorkerError === undefined ? 'ok' : 'degraded',
        },
      }),
    },
  })
  const runWorker = (): void => {
    void worker.runOnce().catch((error: unknown) => {
      lastWorkerError = error instanceof Error ? error.name : 'UNKNOWN'
      app.log.error({ errorCode: lastWorkerError }, 'Worker run failed')
    })
  }
  let timer: NodeJS.Timeout | undefined
  app.addHook('onClose', async () => {
    if (timer !== undefined) clearInterval(timer)
    worker.stop()
    await worker.drain()
    await database.disconnect()
  })

  let shutdownPromise: Promise<void> | undefined
  const shutdown = (signal: string): Promise<void> => {
    if (shutdownPromise !== undefined) return shutdownPromise
    shutdownPromise = app
      .close()
      .then(() => app.log.info({ signal }, 'Worker shutdown complete'))
      .catch((error: unknown) => {
        app.log.error(
          { signal, errorCode: error instanceof Error ? error.name : 'UNKNOWN' },
          'Worker shutdown failed',
        )
        process.exitCode = 1
      })
    return shutdownPromise
  }
  process.once('SIGTERM', () => void shutdown('SIGTERM'))
  process.once('SIGINT', () => void shutdown('SIGINT'))

  try {
    await database.checkReadiness()
    await rail.checkReadiness?.()
    await v2OutgoingRuntime?.checkReadiness()
    await app.listen({ host: '0.0.0.0', port: config.port })
    runWorker()
    timer = setInterval(runWorker, WORKER_INTERVAL_MS)
    app.log.info(
      { config: redactConfig(config), role: config.runtimeRole },
      'Worker started',
    )
  } catch (error) {
    app.log.error(
      { errorCode: error instanceof Error ? error.name : 'UNKNOWN' },
      'Worker failed to start',
    )
    await app.close()
    throw error
  }
}

function createWorker(input: {
  readonly role: 'outgoing' | 'incoming' | 'webhook' | 'maintenance'
  readonly database: ReturnType<typeof createDatabaseClient>
  readonly incomingReader?: ReturnType<typeof createSolanaIncomingReader>
  readonly v2OutgoingWorker?: V2OutgoingWorker
  readonly webhookSigningKeys?: WebhookSigningKeyProvider
  readonly backupOutputDirectory?: string
  readonly backupAgeRecipient?: string
  readonly backupAgeIdentity?: string
  readonly backupVerifyDatabaseUrl?: string
}): RuntimeWorker {
  if (input.role === 'incoming') {
    if (input.incomingReader === undefined) {
      throw new ConfigurationError('Incoming worker reader is unavailable')
    }
    return new IncomingReconciliationService(input.database, input.incomingReader, {
      error: () => undefined,
    })
  }
  if (input.role === 'outgoing') {
    if (input.v2OutgoingWorker === undefined) {
      throw new ConfigurationError('V2 outgoing worker is unavailable')
    }
    return input.v2OutgoingWorker
  }
  if (input.role === 'webhook') {
    if (input.webhookSigningKeys === undefined) {
      throw new ConfigurationError('Webhook signing key provider is unavailable')
    }
    return new WebhookDeliveryWorker({
      repository: input.database.v2Operations,
      signingKeys: input.webhookSigningKeys,
      owner: `webhook-${process.pid}`,
      logger: { info: () => undefined, error: () => undefined },
    })
  }
  if (input.backupOutputDirectory === undefined) {
    throw new ConfigurationError('Backup output directory is unavailable')
  }
  return new MaintenanceWorker(
    input.backupOutputDirectory,
    input.backupAgeRecipient,
    input.backupAgeIdentity,
    input.backupVerifyDatabaseUrl,
  )
}

function createV2OutgoingWorker(input: {
  readonly config: ReturnType<typeof loadConfig>
  readonly database: ReturnType<typeof createDatabaseClient>
  readonly walletCipher: WalletSecretCipher
}): {
  readonly worker: V2OutgoingWorker
  readonly checkReadiness: () => Promise<void>
} {
  const feePayerSecret = input.config.solanaFeePayerSecret
  if (feePayerSecret === undefined) {
    throw new ConfigurationError(
      'SOLANA_FEE_PAYER_SECRET is required for the V2 outgoing worker',
    )
  }
  const custodyMode = input.config.custodyBackendMode
  if (custodyMode !== 'LOCAL_TEST') {
    throw new DependencyUnavailableError(
      'The selected external custody backend has no provider adapter configured for Solana V2',
    )
  }
  const custodyIdentity = input.config.custodyBackendIdentity ?? 'local-test-custody'
  const backend: ConstrainedCustodyBackend = {
    identity: custodyIdentity,
    mode: custodyMode,
    signPaymentEffect: async (request) => {
      const custody = await input.database.findAccountCustody(request.accountId)
      if (custody === null) {
        throw new DependencyUnavailableError('Payer account custody is unavailable')
      }
      const payerSecret = input.walletCipher.decrypt({
        ciphertext: custody.encryptedSolanaSecret,
        nonce: custody.encryptionNonce,
        authTag: custody.encryptionAuthTag,
      })
      try {
        return await signSolanaV2PreparedEffect({
          request,
          payerSecret,
          feePayerSecret,
        })
      } finally {
        payerSecret.fill(0)
      }
    },
  }
  const custodyBoundary = new ConstrainedCustodyBoundary(backend, input.config.nodeEnv)
  const executor = createSolanaV2OutgoingExecutor({
    rpc: createSolanaRpc(input.config.solanaRpcUrl as ClusterUrl),
    settlementMint: input.config.solanaSettlementMint,
    feePayerSecret,
    getPayerPublicKey: (accountId) => input.database.findAccountPublicKey(accountId),
    getDenomination: (denominationId) =>
      input.database.v2.findDenomination(denominationId),
    getSettlementAsset: (assetId) => input.database.v2.findSettlementAsset(assetId),
    getEconomicMapping: (mappingId) => input.database.v2.findEconomicMapping(mappingId),
    getSettlementRoute: (routeId) => input.database.v2.findSettlementRoute(routeId),
    getActiveKeyVersion: async (accountId) =>
      (await input.database.v2Admin.findActiveCustodyKeyVersion(accountId))
        ?.keyVersion ?? null,
    reserveSponsorship: (reservation) =>
      input.database.reserveFeeSponsorship({
        ...reservation,
        maxLamportsPerDay: SPONSORSHIP_MAX_LAMPORTS_PER_DAY,
        maxTransactionsPerHour: SPONSORSHIP_MAX_TRANSACTIONS_PER_HOUR,
      }),
    signPaymentEffect: (request) => custodyBoundary.signPaymentEffect(request),
  })
  const findAccountSummary = input.database.findAccountSummary
  const worker = new V2OutgoingWorker({
    repository: input.database.v2,
    custody: input.database.v2Admin,
    signedPayloadCipher: input.walletCipher,
    executor,
    serviceIdentity: custodyIdentity,
    owner: `outgoing-v2-${process.pid}`,
    accountStatusProvider: {
      getStatus: async (accountId) => {
        if (findAccountSummary === undefined) {
          throw new DependencyUnavailableError(
            'Account lifecycle provider is unavailable',
          )
        }
        const account = await findAccountSummary(accountId)
        if (account === null) {
          throw new DependencyUnavailableError('Payer account lifecycle is unavailable')
        }
        return account.status
      },
    },
  })
  return { worker, checkReadiness: executor.checkReadiness }
}

await startWorker()
