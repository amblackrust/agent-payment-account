import { z } from 'zod'

const configSchema = z.object({
  DATABASE_URL: z.string().trim().min(1, 'DATABASE_URL is required'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3_000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  ADMIN_API_KEY: z.string().min(1, 'ADMIN_API_KEY is required'),
  SOLANA_RPC_URL: z.url().default('http://127.0.0.1:8899'),
  SOLANA_CLUSTER: z
    .enum(['localnet', 'devnet', 'testnet', 'mainnet-beta'])
    .default('localnet'),
  SOLANA_SETTLEMENT_MINT: z.string().min(1, 'SOLANA_SETTLEMENT_MINT is required'),
  SOLANA_FEE_PAYER_SECRET: z.string().min(1).optional(),
  WALLET_MASTER_KEY: z
    .string()
    .regex(
      /^[0-9a-fA-F]{64}$/,
      'WALLET_MASTER_KEY must be 32 bytes encoded as 64 hexadecimal characters',
    ),
  RECOVERY_ENVELOPE_KEY: z
    .string()
    .regex(
      /^[0-9a-fA-F]{64}$/,
      'RECOVERY_ENVELOPE_KEY must be 32 bytes encoded as 64 hexadecimal characters',
    ),
  RUNTIME_ROLE: z
    .enum(['api', 'outgoing', 'incoming', 'webhook', 'maintenance', 'all'])
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
  CUSTODY_BACKEND_IDENTITY: z.string().trim().min(1).optional(),
  CUSTODY_BACKEND_MODE: z.enum(['EXTERNAL', 'LOCAL_TEST']).optional(),
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
  'api' | 'outgoing' | 'incoming' | 'webhook' | 'maintenance' | 'all'

export type AppConfig = {
  readonly databaseUrl: string
  readonly port: number
  readonly nodeEnv: 'development' | 'test' | 'production'
  readonly runtimeRole: RuntimeRole
  readonly runtimeAuthorityId?: string
  readonly restoreGateRequired: boolean
  readonly restoreGateEnvironment?: string
  readonly adminApiKey: string
  readonly solanaRpcUrl: string
  readonly solanaCluster: 'localnet' | 'devnet' | 'testnet' | 'mainnet-beta'
  readonly solanaSettlementMint: string
  readonly solanaFeePayerSecret: string | undefined
  readonly walletMasterKey: string
  readonly recoveryEnvelopeKey: string
  readonly webhookSigningKeysJson?: string
  readonly backupAgeRecipient?: string
  readonly backupAgeIdentity?: string
  readonly backupVerifyDatabaseUrl?: string
  readonly backupOutputDirectory?: string
  readonly custodyBackendIdentity?: string
  readonly custodyBackendMode?: 'EXTERNAL' | 'LOCAL_TEST'
  readonly allowMainnet: boolean
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
  if (result.data.NODE_ENV === 'production' && runtimeRole === 'all') {
    throw new ConfigurationError(
      'Production must select an explicit runtime role; RUNTIME_ROLE=all is development-only',
    )
  }
  if (result.data.NODE_ENV === 'production' && result.data.RUNTIME_AUTHORITY_ID === undefined) {
    throw new ConfigurationError(
      'Production requires an explicit RUNTIME_AUTHORITY_ID',
    )
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
    runtimeRole === 'outgoing' &&
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
    runtimeRole === 'maintenance' &&
    result.data.BACKUP_OUTPUT_DIRECTORY === undefined
  ) {
    throw new ConfigurationError(
      'BACKUP_OUTPUT_DIRECTORY is required for the maintenance runtime role',
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
    result.data.BACKUP_AGE_IDENTITY !== undefined &&
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
    solanaFeePayerSecret: result.data.SOLANA_FEE_PAYER_SECRET,
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
    ...(result.data.CUSTODY_BACKEND_IDENTITY === undefined
      ? {}
      : { custodyBackendIdentity: result.data.CUSTODY_BACKEND_IDENTITY }),
    ...(result.data.CUSTODY_BACKEND_MODE === undefined
      ? {}
      : { custodyBackendMode: result.data.CUSTODY_BACKEND_MODE }),
    allowMainnet: result.data.ALLOW_MAINNET,
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
  readonly allowMainnet: boolean
  readonly hasAdminApiKey: boolean
  readonly hasSolanaFeePayerSecret: boolean
  readonly hasWalletMasterKey: boolean
  readonly hasRecoveryEnvelopeKey: boolean
  readonly hasWebhookSigningKeys: boolean
  readonly hasBackupAgeIdentity: boolean
  readonly custodyBackendIdentity?: string
  readonly custodyBackendMode?: 'EXTERNAL' | 'LOCAL_TEST'
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
    allowMainnet: config.allowMainnet,
    hasAdminApiKey: config.adminApiKey.length > 0,
    hasSolanaFeePayerSecret: config.solanaFeePayerSecret !== undefined,
    hasWalletMasterKey: config.walletMasterKey.length > 0,
    hasRecoveryEnvelopeKey: config.recoveryEnvelopeKey.length > 0,
    hasWebhookSigningKeys: config.webhookSigningKeysJson !== undefined,
    hasBackupAgeIdentity: config.backupAgeIdentity !== undefined,
    ...(config.custodyBackendIdentity === undefined
      ? {}
      : { custodyBackendIdentity: config.custodyBackendIdentity }),
    ...(config.custodyBackendMode === undefined
      ? {}
      : { custodyBackendMode: config.custodyBackendMode }),
  }
}
