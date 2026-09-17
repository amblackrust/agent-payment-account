import { describe, expect, it } from 'vitest'

import { ConfigurationError, loadConfig, redactConfig } from './config.js'

const validEnvironment = {
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/agent_payment_account',
  ADMIN_API_KEY: 'admin-secret',
  SOLANA_RPC_URL: 'http://127.0.0.1:8899',
  SOLANA_CLUSTER: 'localnet',
  SOLANA_SETTLEMENT_MINT: 'local-mint',
  SOLANA_FEE_PAYER_SECRET: 'fee-payer-secret',
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
    expect(config.allowMainnet).toBe(false)
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
      SOLANA_FEE_PAYER_SECRET: undefined,
      CUSTODY_BACKEND_IDENTITY: 'external-custody',
      CUSTODY_BACKEND_MODE: 'EXTERNAL',
    })
    expect(config.runtimeRole).toBe('api')
    expect(config.solanaFeePayerSecret).toBeUndefined()
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
