import { z } from 'zod'
import type { DomainAlertThresholds } from './observability.js'
import {
  X402_ABSOLUTE_MAX_PAYMENT_ATOMIC,
  X402_RESOURCE_URL as X402_RESOURCE_DEFAULT,
} from './x402-protocol.js'

const positiveInt = (defaultValue: number, maximum: number) =>
  z.coerce.number().int().min(1).max(maximum).default(defaultValue)

export const DEFAULT_CREDENTIAL_RECOVERY_TTL_SECONDS = 15 * 60
const MAX_BACKUP_INTERVAL_SECONDS = 365 * 24 * 60 * 60
export const DEFAULT_X402_HTTP_TIMEOUT_MS = 15_000
export const DEFAULT_X402_MAX_PAYMENT_ATOMIC = X402_ABSOLUTE_MAX_PAYMENT_ATOMIC
export const DEFAULT_X402_RESOURCE_URL = X402_RESOURCE_DEFAULT

export interface RuntimeLimits {
  readonly workerBatchSize: number
  readonly workerIntervalMs: number
  readonly workerLeaseSeconds: number
  readonly shutdownTimeoutMs: number
  readonly incomingAccountConcurrency: number
  readonly requestRateLimitWindowSeconds: number
  readonly requestRateLimitPerWindow: number
  readonly requestBurstWindowSeconds: number
  readonly requestBurstLimit: number
  readonly paymentRateLimitPerWindow: number
  readonly receiveRateLimitPerWindow: number
  readonly capacityWindowSeconds: number
  readonly databaseCapacityPerWindow: number
  readonly rpcCapacityPerWindow: number
  readonly custodyCapacityPerWindow: number
  readonly railCapacityPerWindow: number
  readonly webhookCapacityPerWindow: number
  readonly webhookBatchSize: number
  readonly webhookLeaseSeconds: number
  readonly webhookMaxAttempts: number
  readonly webhookTimeoutMs: number
  readonly credentialRecoveryTtlSeconds: number
  readonly maxPageSize: number
  readonly domainAlertThresholds: DomainAlertThresholds
}

export const DEFAULT_RUNTIME_LIMITS: RuntimeLimits = {
  workerBatchSize: 10,
  workerIntervalMs: 5_000,
  workerLeaseSeconds: 30,
  shutdownTimeoutMs: 30_000,
  incomingAccountConcurrency: 8,
  requestRateLimitWindowSeconds: 60,
  requestRateLimitPerWindow: 600,
  requestBurstWindowSeconds: 1,
  requestBurstLimit: 30,
  paymentRateLimitPerWindow: 60,
  receiveRateLimitPerWindow: 120,
  capacityWindowSeconds: 1,
  databaseCapacityPerWindow: 100,
  rpcCapacityPerWindow: 50,
  custodyCapacityPerWindow: 20,
  railCapacityPerWindow: 50,
  webhookCapacityPerWindow: 50,
  webhookBatchSize: 50,
  webhookLeaseSeconds: 30,
  webhookMaxAttempts: 12,
  webhookTimeoutMs: 5_000,
  credentialRecoveryTtlSeconds: DEFAULT_CREDENTIAL_RECOVERY_TTL_SECONDS,
  maxPageSize: 100,
  domainAlertThresholds: {
    reviewRequiredBacklog: 1,
    reviewRequiredAgeSeconds: 300,
    noProgressSeconds: 300,
    databaseSaturationRatio: 0.9,
    webhookBacklog: 1,
  },
}

const configSchema = z.object({
  DATABASE_URL: z.string().trim().min(1, 'DATABASE_URL is required'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3_000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  ADMIN_API_KEY: z.string().min(1).optional(),
  SOLANA_RPC_URL: z.url().default('http://127.0.0.1:8899'),
  SOLANA_CLUSTER: z
    .enum(['localnet', 'devnet', 'testnet', 'mainnet-beta'])
    .default('localnet'),
  SOLANA_SETTLEMENT_MINT: z.string().min(1, 'SOLANA_SETTLEMENT_MINT is required'),
  SOLANA_PLATFORM_COST_ASSET_ID: z.string().trim().min(1).optional(),
  SOLANA_FEE_PAYER_SECRET: z.string().min(1).optional(),
  SOLANA_FEE_PAYER_IDENTITY: z.string().trim().min(1).optional(),
  X402_RESOURCE_URL: z.url().default(DEFAULT_X402_RESOURCE_URL),
  X402_HTTP_TIMEOUT_MS: positiveInt(DEFAULT_X402_HTTP_TIMEOUT_MS, 120_000),
  X402_MAX_PAYMENT_ATOMIC: z.coerce
    .bigint()
    .positive()
    .max(DEFAULT_X402_MAX_PAYMENT_ATOMIC)
    .default(DEFAULT_X402_MAX_PAYMENT_ATOMIC),
  X402_SIGN_FEE_PAYER: z.preprocess((value: unknown) => {
    if (value === undefined) return false
    if (value === 'true' || value === true) return true
    if (value === 'false' || value === false) return false
    return value
  }, z.boolean()),
  WALLET_MASTER_KEY: z
    .string()
    .regex(
      /^[0-9a-fA-F]{64}$/,
      'WALLET_MASTER_KEY must be 32 bytes encoded as 64 hexadecimal characters',
    )
    .optional(),
  RECOVERY_ENVELOPE_KEY: z
    .string()
    .regex(
      /^[0-9a-fA-F]{64}$/,
      'RECOVERY_ENVELOPE_KEY must be 32 bytes encoded as 64 hexadecimal characters',
    )
    .optional(),
  RUNTIME_ROLE: z
    .enum(['api', 'outgoing', 'reconcile', 'incoming', 'webhook', 'maintenance', 'all'])
    .optional(),
  RUNTIME_AUTHORITY_ID: z.string().trim().min(1).optional(),
  RESTORE_GATE_REQUIRED: z.preprocess((value: unknown) => {
    if (value === undefined) return false
    if (value === 'true' || value === true) return true
    if (value === 'false' || value === false) return false
    return value
  }, z.boolean()),
  RESTORE_GATE_ENVIRONMENT: z.string().trim().min(1).optional(),
  WEBHOOK_SIGNING_KEYS_JSON: z.string().min(1).optional(),
  BACKUP_AGE_RECIPIENT: z.string().min(1).optional(),
  BACKUP_AGE_IDENTITY: z.string().min(1).optional(),
  BACKUP_VERIFY_DATABASE_URL: z.string().trim().min(1).optional(),
  BACKUP_OUTPUT_DIRECTORY: z.string().trim().min(1).optional(),
  BACKUP_INTERVAL_SECONDS: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_BACKUP_INTERVAL_SECONDS)
    .optional(),
  CUSTODY_BACKEND_IDENTITY: z.string().trim().min(1).optional(),
  CUSTODY_BACKEND_MODE: z.enum(['EXTERNAL', 'LOCAL_TEST']).optional(),
  WORKER_BATCH_SIZE: positiveInt(DEFAULT_RUNTIME_LIMITS.workerBatchSize, 1_000),
  WORKER_INTERVAL_MS: positiveInt(DEFAULT_RUNTIME_LIMITS.workerIntervalMs, 300_000),
  WORKER_LEASE_SECONDS: positiveInt(DEFAULT_RUNTIME_LIMITS.workerLeaseSeconds, 3_600),
  SHUTDOWN_TIMEOUT_MS: positiveInt(DEFAULT_RUNTIME_LIMITS.shutdownTimeoutMs, 300_000),
  INCOMING_ACCOUNT_CONCURRENCY: positiveInt(
    DEFAULT_RUNTIME_LIMITS.incomingAccountConcurrency,
    1_000,
  ),
  REQUEST_RATE_LIMIT_WINDOW_SECONDS: positiveInt(
    DEFAULT_RUNTIME_LIMITS.requestRateLimitWindowSeconds,
    86_400,
  ),
  REQUEST_RATE_LIMIT_PER_WINDOW: positiveInt(
    DEFAULT_RUNTIME_LIMITS.requestRateLimitPerWindow,
    1_000_000,
  ),
  REQUEST_BURST_WINDOW_SECONDS: positiveInt(
    DEFAULT_RUNTIME_LIMITS.requestBurstWindowSeconds,
    60,
  ),
  REQUEST_BURST_LIMIT: positiveInt(DEFAULT_RUNTIME_LIMITS.requestBurstLimit, 100_000),
  PAYMENT_RATE_LIMIT_PER_WINDOW: positiveInt(
    DEFAULT_RUNTIME_LIMITS.paymentRateLimitPerWindow,
    1_000_000,
  ),
  RECEIVE_RATE_LIMIT_PER_WINDOW: positiveInt(
    DEFAULT_RUNTIME_LIMITS.receiveRateLimitPerWindow,
    1_000_000,
  ),
  CAPACITY_WINDOW_SECONDS: positiveInt(
    DEFAULT_RUNTIME_LIMITS.capacityWindowSeconds,
    86_400,
  ),
  DATABASE_CAPACITY_PER_WINDOW: positiveInt(
    DEFAULT_RUNTIME_LIMITS.databaseCapacityPerWindow,
    1_000_000,
  ),
  RPC_CAPACITY_PER_WINDOW: positiveInt(
    DEFAULT_RUNTIME_LIMITS.rpcCapacityPerWindow,
    1_000_000,
  ),
  CUSTODY_CAPACITY_PER_WINDOW: positiveInt(
    DEFAULT_RUNTIME_LIMITS.custodyCapacityPerWindow,
    1_000_000,
  ),
  RAIL_CAPACITY_PER_WINDOW: positiveInt(
    DEFAULT_RUNTIME_LIMITS.railCapacityPerWindow,
    1_000_000,
  ),
  WEBHOOK_CAPACITY_PER_WINDOW: positiveInt(
    DEFAULT_RUNTIME_LIMITS.webhookCapacityPerWindow,
    1_000_000,
  ),
  WEBHOOK_BATCH_SIZE: positiveInt(DEFAULT_RUNTIME_LIMITS.webhookBatchSize, 1_000),
  WEBHOOK_LEASE_SECONDS: positiveInt(DEFAULT_RUNTIME_LIMITS.webhookLeaseSeconds, 3_600),
  WEBHOOK_MAX_ATTEMPTS: positiveInt(DEFAULT_RUNTIME_LIMITS.webhookMaxAttempts, 100),
  WEBHOOK_TIMEOUT_MS: positiveInt(DEFAULT_RUNTIME_LIMITS.webhookTimeoutMs, 120_000),
  CREDENTIAL_RECOVERY_TTL_SECONDS: positiveInt(
    DEFAULT_RUNTIME_LIMITS.credentialRecoveryTtlSeconds,
    86_400,
  ),
  MAX_PAGE_SIZE: positiveInt(DEFAULT_RUNTIME_LIMITS.maxPageSize, 1_000),
  REVIEW_REQUIRED_BACKLOG_ALERT_THRESHOLD: positiveInt(
    DEFAULT_RUNTIME_LIMITS.domainAlertThresholds.reviewRequiredBacklog,
    1_000_000,
  ),
  REVIEW_REQUIRED_AGE_ALERT_SECONDS: positiveInt(
    DEFAULT_RUNTIME_LIMITS.domainAlertThresholds.reviewRequiredAgeSeconds,
    31_536_000,
  ),
  NO_PROGRESS_ALERT_SECONDS: positiveInt(
    DEFAULT_RUNTIME_LIMITS.domainAlertThresholds.noProgressSeconds,
    31_536_000,
  ),
  DATABASE_SATURATION_ALERT_RATIO: z.coerce
    .number()
    .gt(0)
    .lte(1)
    .default(DEFAULT_RUNTIME_LIMITS.domainAlertThresholds.databaseSaturationRatio),
  WEBHOOK_BACKLOG_ALERT_THRESHOLD: positiveInt(
    DEFAULT_RUNTIME_LIMITS.domainAlertThresholds.webhookBacklog,
    1_000_000,
  ),
  ALLOW_MAINNET: z.preprocess((value: unknown) => {
    if (value === undefined) {
      return false
    }
    if (value === 'true' || value === true) {
      return true
    }
    if (value === 'false' || value === false) {
      return false
    }
    return value
  }, z.boolean()),
})

export type RuntimeRole =
  'api' | 'outgoing' | 'reconcile' | 'incoming' | 'webhook' | 'maintenance' | 'all'

export type AppConfig = {
  readonly databaseUrl: string
  readonly port: number
  readonly nodeEnv: 'development' | 'test' | 'production'
  readonly runtimeRole: RuntimeRole
  readonly runtimeAuthorityId?: string
  readonly restoreGateRequired: boolean
  readonly restoreGateEnvironment?: string
  readonly adminApiKey: string | undefined
  readonly solanaRpcUrl: string
  readonly solanaCluster: 'localnet' | 'devnet' | 'testnet' | 'mainnet-beta'
  readonly solanaSettlementMint: string
  readonly solanaPlatformCostAssetId?: string
  readonly solanaFeePayerSecret: string | undefined
  readonly solanaFeePayerIdentity?: string
  readonly x402ResourceUrl?: string
  readonly x402HttpTimeoutMs?: number
  readonly x402MaxPaymentAtomic?: bigint
  readonly x402SignFeePayer?: boolean
  readonly walletMasterKey: string | undefined
  readonly recoveryEnvelopeKey: string | undefined
  readonly webhookSigningKeysJson?: string
  readonly backupAgeRecipient?: string
  readonly backupAgeIdentity?: string
  readonly backupVerifyDatabaseUrl?: string
  readonly backupOutputDirectory?: string
  readonly backupIntervalSeconds?: number
  readonly custodyBackendIdentity?: string
  readonly custodyBackendMode?: 'EXTERNAL' | 'LOCAL_TEST'
  readonly allowMainnet: boolean
  readonly limits?: RuntimeLimits
}

export class ConfigurationError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = 'ConfigurationError'
  }
}

function describeConfigIssues(error: z.ZodError): string {
  const fields = error.issues.map((issue) => issue.path.join('.') || 'configuration')
  return `Invalid configuration: ${fields.join(', ')}`
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = configSchema.safeParse(environment)
  if (!result.success) {
    throw new ConfigurationError(describeConfigIssues(result.error))
  }

  if (result.data.SOLANA_CLUSTER === 'mainnet-beta' && !result.data.ALLOW_MAINNET) {
    throw new ConfigurationError(
      'Mainnet requires ALLOW_MAINNET=true as an explicit safety flag',
    )
  }

  if (result.data.NODE_ENV === 'production' && result.data.RUNTIME_ROLE === undefined) {
    throw new ConfigurationError(
      'Production requires an explicit runtime role in RUNTIME_ROLE',
    )
  }
  const runtimeRole: RuntimeRole = result.data.RUNTIME_ROLE ?? 'all'
  if (
    (runtimeRole === 'api' || runtimeRole === 'all') &&
    result.data.ADMIN_API_KEY === undefined
  ) {
    throw new ConfigurationError('ADMIN_API_KEY is required for the API runtime role')
  }
  if (
    (runtimeRole === 'api' || runtimeRole === 'outgoing' || runtimeRole === 'all') &&
    result.data.WALLET_MASTER_KEY === undefined
  ) {
    throw new ConfigurationError(
      'WALLET_MASTER_KEY is required for API or outgoing account custody',
    )
  }
  if (
    (runtimeRole === 'api' || runtimeRole === 'all') &&
    result.data.RECOVERY_ENVELOPE_KEY === undefined
  ) {
    throw new ConfigurationError(
      'RECOVERY_ENVELOPE_KEY is required for account provisioning and credential recovery',
    )
  }
  if (result.data.NODE_ENV === 'production' && runtimeRole === 'all') {
    throw new ConfigurationError(
      'Production must select an explicit runtime role; RUNTIME_ROLE=all is development-only',
    )
  }
  if (
    result.data.NODE_ENV === 'production' &&
    result.data.RUNTIME_AUTHORITY_ID === undefined
  ) {
    throw new ConfigurationError('Production requires an explicit RUNTIME_AUTHORITY_ID')
  }
  if (
    (runtimeRole === 'outgoing' || runtimeRole === 'all') &&
    result.data.SOLANA_FEE_PAYER_SECRET === undefined
  ) {
    throw new ConfigurationError(
      'SOLANA_FEE_PAYER_SECRET is required for the outgoing runtime role',
    )
  }
  if (
    (runtimeRole === 'outgoing' || runtimeRole === 'reconcile') &&
    (result.data.CUSTODY_BACKEND_IDENTITY === undefined ||
      result.data.CUSTODY_BACKEND_MODE === undefined)
  ) {
    throw new ConfigurationError(
      'Outgoing runtime requires an explicit custody backend identity and mode',
    )
  }
  if (
    result.data.NODE_ENV === 'production' &&
    (result.data.CUSTODY_BACKEND_IDENTITY === undefined ||
      result.data.CUSTODY_BACKEND_MODE !== 'EXTERNAL')
  ) {
    throw new ConfigurationError(
      'Production requires an explicitly configured external custody backend',
    )
  }
  if (
    result.data.NODE_ENV === 'production' &&
    result.data.SOLANA_FEE_PAYER_IDENTITY === undefined
  ) {
    throw new ConfigurationError(
      'Production requires the public SOLANA_FEE_PAYER_IDENTITY',
    )
  }
  if (result.data.X402_SIGN_FEE_PAYER) {
    if (result.data.NODE_ENV === 'production') {
      throw new ConfigurationError(
        'X402_SIGN_FEE_PAYER is restricted to non-production devnet verification',
      )
    }
    if (result.data.SOLANA_CLUSTER !== 'devnet') {
      throw new ConfigurationError('X402_SIGN_FEE_PAYER requires SOLANA_CLUSTER=devnet')
    }
    if (result.data.SOLANA_FEE_PAYER_IDENTITY === undefined) {
      throw new ConfigurationError(
        'X402_SIGN_FEE_PAYER requires SOLANA_FEE_PAYER_IDENTITY',
      )
    }
    if (result.data.SOLANA_FEE_PAYER_SECRET === undefined) {
      throw new ConfigurationError(
        'X402_SIGN_FEE_PAYER requires SOLANA_FEE_PAYER_SECRET',
      )
    }
  }
  if (
    runtimeRole === 'maintenance' &&
    result.data.BACKUP_OUTPUT_DIRECTORY === undefined
  ) {
    throw new ConfigurationError(
      'BACKUP_OUTPUT_DIRECTORY is required for the maintenance runtime role',
    )
  }
  if (runtimeRole === 'maintenance' && result.data.BACKUP_AGE_RECIPIENT === undefined) {
    throw new ConfigurationError(
      'BACKUP_AGE_RECIPIENT is required for the maintenance runtime role',
    )
  }
  if (
    runtimeRole === 'maintenance' &&
    result.data.BACKUP_INTERVAL_SECONDS === undefined
  ) {
    throw new ConfigurationError(
      'BACKUP_INTERVAL_SECONDS is required for the maintenance runtime role',
    )
  }
  if (
    (result.data.BACKUP_AGE_IDENTITY === undefined) !==
    (result.data.BACKUP_VERIFY_DATABASE_URL === undefined)
  ) {
    throw new ConfigurationError(
      'BACKUP_AGE_IDENTITY and BACKUP_VERIFY_DATABASE_URL must be configured together',
    )
  }
  if (result.data.RESTORE_GATE_REQUIRED) {
    if (
      result.data.RUNTIME_AUTHORITY_ID === undefined ||
      result.data.RESTORE_GATE_ENVIRONMENT === undefined
    ) {
      throw new ConfigurationError(
        'Restore gate requires RUNTIME_AUTHORITY_ID and RESTORE_GATE_ENVIRONMENT',
      )
    }
    if (result.data.RESTORE_GATE_ENVIRONMENT === 'production') {
      throw new ConfigurationError(
        'Restore gate verification must use a non-production environment',
      )
    }
    if (result.data.CUSTODY_BACKEND_IDENTITY === undefined) {
      throw new ConfigurationError(
        'Restore gate requires CUSTODY_BACKEND_IDENTITY for custody re-association',
      )
    }
  }
  if (
    runtimeRole === 'maintenance' &&
    (result.data.BACKUP_AGE_IDENTITY === undefined ||
      result.data.BACKUP_VERIFY_DATABASE_URL === undefined)
  ) {
    throw new ConfigurationError(
      'BACKUP_AGE_IDENTITY and BACKUP_VERIFY_DATABASE_URL are required for the maintenance runtime role',
    )
  }
  if (
    runtimeRole === 'maintenance' &&
    (result.data.RUNTIME_AUTHORITY_ID === undefined ||
      result.data.CUSTODY_BACKEND_IDENTITY === undefined)
  ) {
    throw new ConfigurationError(
      'Verified restore requires RUNTIME_AUTHORITY_ID and CUSTODY_BACKEND_IDENTITY',
    )
  }

  return {
    databaseUrl: result.data.DATABASE_URL,
    port: result.data.PORT,
    nodeEnv: result.data.NODE_ENV,
    runtimeRole,
    ...(result.data.RUNTIME_AUTHORITY_ID === undefined
      ? {}
      : { runtimeAuthorityId: result.data.RUNTIME_AUTHORITY_ID }),
    restoreGateRequired: result.data.RESTORE_GATE_REQUIRED,
    ...(result.data.RESTORE_GATE_ENVIRONMENT === undefined
      ? {}
      : { restoreGateEnvironment: result.data.RESTORE_GATE_ENVIRONMENT }),
    adminApiKey: result.data.ADMIN_API_KEY,
    solanaRpcUrl: result.data.SOLANA_RPC_URL,
    solanaCluster: result.data.SOLANA_CLUSTER,
    solanaSettlementMint: result.data.SOLANA_SETTLEMENT_MINT,
    ...(result.data.SOLANA_PLATFORM_COST_ASSET_ID === undefined
      ? {}
      : { solanaPlatformCostAssetId: result.data.SOLANA_PLATFORM_COST_ASSET_ID }),
    solanaFeePayerSecret: result.data.SOLANA_FEE_PAYER_SECRET,
    ...(result.data.SOLANA_FEE_PAYER_IDENTITY === undefined
      ? {}
      : { solanaFeePayerIdentity: result.data.SOLANA_FEE_PAYER_IDENTITY }),
    x402ResourceUrl: result.data.X402_RESOURCE_URL,
    x402HttpTimeoutMs: result.data.X402_HTTP_TIMEOUT_MS,
    x402MaxPaymentAtomic: result.data.X402_MAX_PAYMENT_ATOMIC,
    x402SignFeePayer: result.data.X402_SIGN_FEE_PAYER,
    walletMasterKey: result.data.WALLET_MASTER_KEY,
    recoveryEnvelopeKey: result.data.RECOVERY_ENVELOPE_KEY,
    ...(result.data.WEBHOOK_SIGNING_KEYS_JSON === undefined
      ? {}
      : { webhookSigningKeysJson: result.data.WEBHOOK_SIGNING_KEYS_JSON }),
    ...(result.data.BACKUP_AGE_RECIPIENT === undefined
      ? {}
      : { backupAgeRecipient: result.data.BACKUP_AGE_RECIPIENT }),
    ...(result.data.BACKUP_AGE_IDENTITY === undefined
      ? {}
      : { backupAgeIdentity: result.data.BACKUP_AGE_IDENTITY }),
    ...(result.data.BACKUP_VERIFY_DATABASE_URL === undefined
      ? {}
      : { backupVerifyDatabaseUrl: result.data.BACKUP_VERIFY_DATABASE_URL }),
    ...(result.data.BACKUP_OUTPUT_DIRECTORY === undefined
      ? {}
      : { backupOutputDirectory: result.data.BACKUP_OUTPUT_DIRECTORY }),
    ...(result.data.BACKUP_INTERVAL_SECONDS === undefined
      ? {}
      : { backupIntervalSeconds: result.data.BACKUP_INTERVAL_SECONDS }),
    ...(result.data.CUSTODY_BACKEND_IDENTITY === undefined
      ? {}
      : { custodyBackendIdentity: result.data.CUSTODY_BACKEND_IDENTITY }),
    ...(result.data.CUSTODY_BACKEND_MODE === undefined
      ? {}
      : { custodyBackendMode: result.data.CUSTODY_BACKEND_MODE }),
    allowMainnet: result.data.ALLOW_MAINNET,
    limits: {
      workerBatchSize: result.data.WORKER_BATCH_SIZE,
      workerIntervalMs: result.data.WORKER_INTERVAL_MS,
      workerLeaseSeconds: result.data.WORKER_LEASE_SECONDS,
      shutdownTimeoutMs: result.data.SHUTDOWN_TIMEOUT_MS,
      incomingAccountConcurrency: result.data.INCOMING_ACCOUNT_CONCURRENCY,
      requestRateLimitWindowSeconds: result.data.REQUEST_RATE_LIMIT_WINDOW_SECONDS,
      requestRateLimitPerWindow: result.data.REQUEST_RATE_LIMIT_PER_WINDOW,
      requestBurstWindowSeconds: result.data.REQUEST_BURST_WINDOW_SECONDS,
      requestBurstLimit: result.data.REQUEST_BURST_LIMIT,
      paymentRateLimitPerWindow: result.data.PAYMENT_RATE_LIMIT_PER_WINDOW,
      receiveRateLimitPerWindow: result.data.RECEIVE_RATE_LIMIT_PER_WINDOW,
      capacityWindowSeconds: result.data.CAPACITY_WINDOW_SECONDS,
      databaseCapacityPerWindow: result.data.DATABASE_CAPACITY_PER_WINDOW,
      rpcCapacityPerWindow: result.data.RPC_CAPACITY_PER_WINDOW,
      custodyCapacityPerWindow: result.data.CUSTODY_CAPACITY_PER_WINDOW,
      railCapacityPerWindow: result.data.RAIL_CAPACITY_PER_WINDOW,
      webhookCapacityPerWindow: result.data.WEBHOOK_CAPACITY_PER_WINDOW,
      webhookBatchSize: result.data.WEBHOOK_BATCH_SIZE,
      webhookLeaseSeconds: result.data.WEBHOOK_LEASE_SECONDS,
      webhookMaxAttempts: result.data.WEBHOOK_MAX_ATTEMPTS,
      webhookTimeoutMs: result.data.WEBHOOK_TIMEOUT_MS,
      credentialRecoveryTtlSeconds: result.data.CREDENTIAL_RECOVERY_TTL_SECONDS,
      maxPageSize: result.data.MAX_PAGE_SIZE,
      domainAlertThresholds: {
        reviewRequiredBacklog: result.data.REVIEW_REQUIRED_BACKLOG_ALERT_THRESHOLD,
        reviewRequiredAgeSeconds: result.data.REVIEW_REQUIRED_AGE_ALERT_SECONDS,
        noProgressSeconds: result.data.NO_PROGRESS_ALERT_SECONDS,
        databaseSaturationRatio: result.data.DATABASE_SATURATION_ALERT_RATIO,
        webhookBacklog: result.data.WEBHOOK_BACKLOG_ALERT_THRESHOLD,
      },
    },
  }
}

export interface RedactedConfig {
  readonly port: number
  readonly nodeEnv: AppConfig['nodeEnv']
  readonly runtimeRole: RuntimeRole
  readonly runtimeAuthorityId?: string
  readonly restoreGateRequired: boolean
  readonly restoreGateEnvironment?: string
  readonly solanaCluster: AppConfig['solanaCluster']
  readonly solanaSettlementMint: string
  readonly solanaPlatformCostAssetId?: string
  readonly x402ResourceUrl: string
  readonly x402HttpTimeoutMs: number
  readonly x402MaxPaymentAtomic: string
  readonly x402SignFeePayer: boolean
  readonly allowMainnet: boolean
  readonly hasAdminApiKey: boolean
  readonly hasSolanaFeePayerSecret: boolean
  readonly hasWalletMasterKey: boolean
  readonly hasRecoveryEnvelopeKey: boolean
  readonly hasWebhookSigningKeys: boolean
  readonly hasBackupAgeIdentity: boolean
  readonly custodyBackendIdentity?: string
  readonly custodyBackendMode?: 'EXTERNAL' | 'LOCAL_TEST'
  readonly limits: RuntimeLimits
}

export function getRuntimeLimits(config: Pick<AppConfig, 'limits'>): RuntimeLimits {
  return config.limits ?? DEFAULT_RUNTIME_LIMITS
}

export function redactConfig(config: AppConfig): RedactedConfig {
  return {
    port: config.port,
    nodeEnv: config.nodeEnv,
    runtimeRole: config.runtimeRole,
    ...(config.runtimeAuthorityId === undefined
      ? {}
      : { runtimeAuthorityId: config.runtimeAuthorityId }),
    restoreGateRequired: config.restoreGateRequired,
    ...(config.restoreGateEnvironment === undefined
      ? {}
      : { restoreGateEnvironment: config.restoreGateEnvironment }),
    solanaCluster: config.solanaCluster,
    solanaSettlementMint: config.solanaSettlementMint,
    x402ResourceUrl: config.x402ResourceUrl ?? DEFAULT_X402_RESOURCE_URL,
    x402HttpTimeoutMs: config.x402HttpTimeoutMs ?? DEFAULT_X402_HTTP_TIMEOUT_MS,
    x402MaxPaymentAtomic: String(
      config.x402MaxPaymentAtomic ?? DEFAULT_X402_MAX_PAYMENT_ATOMIC,
    ),
    x402SignFeePayer: config.x402SignFeePayer === true,
    ...(config.solanaPlatformCostAssetId === undefined
      ? {}
      : { solanaPlatformCostAssetId: config.solanaPlatformCostAssetId }),
    allowMainnet: config.allowMainnet,
    hasAdminApiKey: config.adminApiKey !== undefined,
    hasSolanaFeePayerSecret: config.solanaFeePayerSecret !== undefined,
    hasWalletMasterKey: config.walletMasterKey !== undefined,
    hasRecoveryEnvelopeKey: config.recoveryEnvelopeKey !== undefined,
    hasWebhookSigningKeys: config.webhookSigningKeysJson !== undefined,
    hasBackupAgeIdentity: config.backupAgeIdentity !== undefined,
    ...(config.custodyBackendIdentity === undefined
      ? {}
      : { custodyBackendIdentity: config.custodyBackendIdentity }),
    ...(config.custodyBackendMode === undefined
      ? {}
      : { custodyBackendMode: config.custodyBackendMode }),
    limits: getRuntimeLimits(config),
  }
}
