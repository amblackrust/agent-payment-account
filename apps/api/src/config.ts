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
  SOLANA_FEE_PAYER_SECRET: z.string().min(1, 'SOLANA_FEE_PAYER_SECRET is required'),
  WALLET_MASTER_KEY: z
    .string()
    .regex(
      /^[0-9a-fA-F]{64}$/,
      'WALLET_MASTER_KEY must be 32 bytes encoded as 64 hexadecimal characters',
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

export type AppConfig = {
  readonly databaseUrl: string
  readonly port: number
  readonly nodeEnv: 'development' | 'test' | 'production'
  readonly adminApiKey: string
  readonly solanaRpcUrl: string
  readonly solanaCluster: 'localnet' | 'devnet' | 'testnet' | 'mainnet-beta'
  readonly solanaSettlementMint: string
  readonly solanaFeePayerSecret: string
  readonly walletMasterKey: string
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

  return {
    databaseUrl: result.data.DATABASE_URL,
    port: result.data.PORT,
    nodeEnv: result.data.NODE_ENV,
    adminApiKey: result.data.ADMIN_API_KEY,
    solanaRpcUrl: result.data.SOLANA_RPC_URL,
    solanaCluster: result.data.SOLANA_CLUSTER,
    solanaSettlementMint: result.data.SOLANA_SETTLEMENT_MINT,
    solanaFeePayerSecret: result.data.SOLANA_FEE_PAYER_SECRET,
    walletMasterKey: result.data.WALLET_MASTER_KEY,
    allowMainnet: result.data.ALLOW_MAINNET,
  }
}

export interface RedactedConfig {
  readonly port: number
  readonly nodeEnv: AppConfig['nodeEnv']
  readonly solanaCluster: AppConfig['solanaCluster']
  readonly solanaSettlementMint: string
  readonly allowMainnet: boolean
  readonly hasAdminApiKey: boolean
  readonly hasSolanaFeePayerSecret: boolean
  readonly hasWalletMasterKey: boolean
}

export function redactConfig(config: AppConfig): RedactedConfig {
  return {
    port: config.port,
    nodeEnv: config.nodeEnv,
    solanaCluster: config.solanaCluster,
    solanaSettlementMint: config.solanaSettlementMint,
    allowMainnet: config.allowMainnet,
    hasAdminApiKey: config.adminApiKey.length > 0,
    hasSolanaFeePayerSecret: config.solanaFeePayerSecret.length > 0,
    hasWalletMasterKey: config.walletMasterKey.length > 0,
  }
}
