import { describe, expect, it } from 'vitest'

import { ConfigurationError, loadConfig, redactConfig } from './config.js'

const validEnvironment = {
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/agent_payment_account',
  ADMIN_API_KEY: 'admin-secret',
  SOLANA_RPC_URL: 'http://127.0.0.1:8899',
  SOLANA_CLUSTER: 'localnet',
  SOLANA_SETTLEMENT_MINT: 'local-mint',
  SOLANA_FEE_PAYER_SECRET: 'fee-payer-secret',
  SOLANA_FEE_PAYER_IDENTITY: 'fee-payer-public-key',
  WALLET_MASTER_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  RECOVERY_ENVELOPE_KEY:
    'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
}

describe('configuration', () => {
  it('loads defaults and keeps mainnet disabled by default', () => {
    const config = loadConfig(validEnvironment)

    expect(config.port).toBe(3000)
    expect(config.nodeEnv).toBe('development')
    expect(config.runtimeRole).toBe('all')
    expect(config.restoreGateRequired).toBe(false)
    expect(config.allowMainnet).toBe(false)
    expect(config.limits?.workerBatchSize).toBe(10)
    expect(config.limits?.requestRateLimitPerWindow).toBe(600)
    expect(config.limits?.requestBurstWindowSeconds).toBe(1)
    expect(config.limits?.requestBurstLimit).toBe(30)
    expect(config.limits?.receiveRateLimitPerWindow).toBe(120)
    expect(config.limits?.credentialRecoveryTtlSeconds).toBe(900)
    expect(config.limits?.domainAlertThresholds).toEqual({
      reviewRequiredBacklog: 1,
      reviewRequiredAgeSeconds: 300,
      noProgressSeconds: 300,
      databaseSaturationRatio: 0.9,
      webhookBacklog: 1,
    })
  })

  it('loads bounded worker, capacity, and pagination limits', () => {
    const config = loadConfig({
      ...validEnvironment,
      RUNTIME_ROLE: 'reconcile',
      SOLANA_FEE_PAYER_SECRET: undefined,
      WORKER_INTERVAL_MS: '7000',
      SHUTDOWN_TIMEOUT_MS: '45000',
      REQUEST_RATE_LIMIT_PER_WINDOW: '17',
      REQUEST_BURST_WINDOW_SECONDS: '2',
      REQUEST_BURST_LIMIT: '5',
      PAYMENT_RATE_LIMIT_PER_WINDOW: '7',
      RECEIVE_RATE_LIMIT_PER_WINDOW: '9',
      CAPACITY_WINDOW_SECONDS: '2',
      RPC_CAPACITY_PER_WINDOW: '11',
      CREDENTIAL_RECOVERY_TTL_SECONDS: '1800',
      MAX_PAGE_SIZE: '25',
      REVIEW_REQUIRED_BACKLOG_ALERT_THRESHOLD: '4',
      REVIEW_REQUIRED_AGE_ALERT_SECONDS: '900',
      NO_PROGRESS_ALERT_SECONDS: '1200',
      DATABASE_SATURATION_ALERT_RATIO: '0.85',
      WEBHOOK_BACKLOG_ALERT_THRESHOLD: '7',
      CUSTODY_BACKEND_IDENTITY: 'local-test-custody',
      CUSTODY_BACKEND_MODE: 'LOCAL_TEST',
    })

    expect(config.runtimeRole).toBe('reconcile')
    expect(config.solanaFeePayerSecret).toBeUndefined()
    expect(config.limits).toMatchObject({
      workerIntervalMs: 7000,
      shutdownTimeoutMs: 45000,
      requestRateLimitPerWindow: 17,
      requestBurstWindowSeconds: 2,
      requestBurstLimit: 5,
      paymentRateLimitPerWindow: 7,
      receiveRateLimitPerWindow: 9,
      capacityWindowSeconds: 2,
      rpcCapacityPerWindow: 11,
      credentialRecoveryTtlSeconds: 1800,
      maxPageSize: 25,
      domainAlertThresholds: {
        reviewRequiredBacklog: 4,
        reviewRequiredAgeSeconds: 900,
        noProgressSeconds: 1200,
        databaseSaturationRatio: 0.85,
        webhookBacklog: 7,
      },
    })
  })

  it('fails with a clear configuration error when a required value is missing', () => {
    const { DATABASE_URL: _databaseUrl, ...environment } = validEnvironment

    expect(() => loadConfig(environment)).toThrow(ConfigurationError)
    expect(() => loadConfig(environment)).toThrow('DATABASE_URL')
  })

  it('requires an explicit flag before allowing mainnet', () => {
    expect(() =>
      loadConfig({ ...validEnvironment, SOLANA_CLUSTER: 'mainnet-beta' }),
    ).toThrow('ALLOW_MAINNET')

    expect(
      loadConfig({
        ...validEnvironment,
        SOLANA_CLUSTER: 'mainnet-beta',
        ALLOW_MAINNET: 'true',
      }).allowMainnet,
    ).toBe(true)
  })

  it('fails closed for an implicit all-in-one production runtime', () => {
    expect(() =>
      loadConfig({
        ...validEnvironment,
        NODE_ENV: 'production',
        SOLANA_FEE_PAYER_SECRET: undefined,
      }),
    ).toThrow('RUNTIME_ROLE')
  })

  it('allows the API role without loading a fee-payer secret', () => {
    const config = loadConfig({
      ...validEnvironment,
      NODE_ENV: 'production',
      RUNTIME_ROLE: 'api',
      RUNTIME_AUTHORITY_ID: 'runtime-api-1',
      SOLANA_FEE_PAYER_SECRET: undefined,
      CUSTODY_BACKEND_IDENTITY: 'external-custody',
      CUSTODY_BACKEND_MODE: 'EXTERNAL',
    })
    expect(config.runtimeRole).toBe('api')
    expect(config.solanaFeePayerSecret).toBeUndefined()
  })

  it('does not require wallet or recovery keys for read-only worker roles', () => {
    const {
      ADMIN_API_KEY: _adminApiKey,
      WALLET_MASTER_KEY: _walletMasterKey,
      RECOVERY_ENVELOPE_KEY: _recoveryKey,
      ...environment
    } = {
      ...validEnvironment,
      RUNTIME_ROLE: 'reconcile',
      SOLANA_FEE_PAYER_SECRET: undefined,
      CUSTODY_BACKEND_IDENTITY: 'external-custody',
      CUSTODY_BACKEND_MODE: 'EXTERNAL',
    }

    const config = loadConfig(environment)

    expect(config.runtimeRole).toBe('reconcile')
    expect(config.adminApiKey).toBeUndefined()
    expect(config.walletMasterKey).toBeUndefined()
    expect(config.recoveryEnvelopeKey).toBeUndefined()
  })

  it('requires an explicit authority and isolated environment for the restore gate', () => {
    expect(() =>
      loadConfig({ ...validEnvironment, RESTORE_GATE_REQUIRED: 'true' }),
    ).toThrow('RUNTIME_AUTHORITY_ID')

    const config = loadConfig({
      ...validEnvironment,
      RESTORE_GATE_REQUIRED: 'true',
      RUNTIME_AUTHORITY_ID: 'runtime-restore-1',
      RESTORE_GATE_ENVIRONMENT: 'isolated-restore',
      CUSTODY_BACKEND_IDENTITY: 'local-test-custody',
    })
    expect(config.restoreGateRequired).toBe(true)
    expect(config.runtimeAuthorityId).toBe('runtime-restore-1')
  })

  it('requires an explicit verified maintenance backup schedule', () => {
    const maintenanceEnvironment = {
      ...validEnvironment,
      RUNTIME_ROLE: 'maintenance',
      SOLANA_FEE_PAYER_SECRET: undefined,
      WALLET_MASTER_KEY: undefined,
      RECOVERY_ENVELOPE_KEY: undefined,
      BACKUP_OUTPUT_DIRECTORY: '/var/lib/mux/backups',
      BACKUP_AGE_RECIPIENT: 'age1maintenance',
      BACKUP_AGE_IDENTITY: '/secure/restore/age-key.txt',
      BACKUP_VERIFY_DATABASE_URL:
        'postgresql://postgres:postgres@127.0.0.1:5433/mux_restore',
      BACKUP_INTERVAL_SECONDS: '3600',
      RUNTIME_AUTHORITY_ID: 'maintenance-restore-authority',
      CUSTODY_BACKEND_IDENTITY: 'custody-reference',
    }

    const config = loadConfig(maintenanceEnvironment)

    expect(config.backupIntervalSeconds).toBe(3600)
    expect(config.backupAgeIdentity).toBe('/secure/restore/age-key.txt')
    expect(config.backupVerifyDatabaseUrl).toContain('mux_restore')

    const { BACKUP_INTERVAL_SECONDS: _interval, ...withoutInterval } =
      maintenanceEnvironment
    expect(() => loadConfig(withoutInterval)).toThrow('BACKUP_INTERVAL_SECONDS')

    const {
      BACKUP_AGE_IDENTITY: _identity,
      BACKUP_VERIFY_DATABASE_URL: _verifyDatabaseUrl,
      ...withoutVerification
    } = maintenanceEnvironment
    expect(() => loadConfig(withoutVerification)).toThrow(
      'BACKUP_AGE_IDENTITY and BACKUP_VERIFY_DATABASE_URL',
    )
  })

  it('redacts secrets from the serialized configuration', () => {
    const config = loadConfig({
      ...validEnvironment,
      DATABASE_URL:
        'postgresql://db-user:db-password@db.example/agent?token=database-query-secret',
      SOLANA_RPC_URL:
        'https://rpc.example/path/rpc-path-secret?api-key=rpc-query-secret',
      ADMIN_API_KEY: 'admin-sentinel-secret',
      SOLANA_FEE_PAYER_SECRET: 'fee-payer-sentinel-secret',
      WALLET_MASTER_KEY:
        'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      RECOVERY_ENVELOPE_KEY:
        'feedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface',
    })
    const serialized = JSON.stringify(redactConfig(config))

    expect(serialized).not.toContain('db-user')
    expect(serialized).not.toContain('db-password')
    expect(serialized).not.toContain('database-query-secret')
    expect(serialized).not.toContain('rpc-path-secret')
    expect(serialized).not.toContain('rpc-query-secret')
    expect(serialized).not.toContain('admin-sentinel-secret')
    expect(serialized).not.toContain('fee-payer-sentinel-secret')
    expect(serialized).not.toContain(
      'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    )
    expect(serialized).not.toContain('db.example')
    expect(serialized).not.toContain('rpc.example')
    expect(serialized).toContain('hasAdminApiKey')
  })
})
