import { describe, expect, it } from 'vitest'

import { buildApp } from './app.js'
import type { AppConfig } from './config.js'

const testConfig: AppConfig = {
  databaseUrl: 'postgresql://postgres:postgres@localhost:5432/test',
  port: 3000,
  nodeEnv: 'test',
  adminApiKey: 'test-admin-key',
  solanaRpcUrl: 'http://127.0.0.1:8899',
  solanaCluster: 'localnet',
  solanaSettlementMint: 'test-mint',
  solanaFeePayerSecret: 'test-fee-payer-secret',
  walletMasterKey: 'test-wallet-master-key',
  allowMainnet: false,
}

describe('API foundation', () => {
  it('serves health and readiness endpoints', async () => {
    const app = buildApp({
      config: testConfig,
      readinessDependency: { checkReadiness: async () => undefined },
    })

    const health = await app.inject({ method: 'GET', url: '/health' })
    const readiness = await app.inject({ method: 'GET', url: '/ready' })

    expect(health.statusCode).toBe(200)
    expect(health.json()).toEqual({ status: 'ok' })
    expect(readiness.statusCode).toBe(200)
    expect(readiness.json()).toEqual({ status: 'ok' })
    await app.close()
  })

  it('does not report readiness when the database check fails', async () => {
    const app = buildApp({
      config: testConfig,
      readinessDependency: {
        checkReadiness: async () => {
          throw new Error('database unavailable')
        },
      },
    })

    const response = await app.inject({ method: 'GET', url: '/ready' })

    expect(response.statusCode).toBe(503)
    expect(response.json()).toEqual({ status: 'not_ready' })
    await app.close()
  })
})
