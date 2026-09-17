import { describe, expect, it } from 'vitest'

import { buildApp } from './app.js'
import type { AppConfig } from './config.js'

const testConfig: AppConfig = {
  databaseUrl: 'postgresql://postgres:postgres@localhost:5432/test',
  port: 3000,
  nodeEnv: 'test',
  runtimeRole: 'all',
  adminApiKey: 'test-admin-key',
  solanaRpcUrl: 'http://127.0.0.1:8899',
  solanaCluster: 'localnet',
  solanaSettlementMint: 'test-mint',
  solanaFeePayerSecret: 'test-fee-payer-secret',
  walletMasterKey: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  recoveryEnvelopeKey:
    'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
  allowMainnet: false,
}

describe('API foundation', () => {
  it('serves health and readiness endpoints', async () => {
    const app = buildApp({
      config: testConfig,
      readinessDependency: { checkReadiness: async () => undefined },
    })

    const health = await app.inject({ method: 'GET', url: '/health' })
    const liveness = await app.inject({ method: 'GET', url: '/health/live' })
    const healthReadiness = await app.inject({ method: 'GET', url: '/health/ready' })
    const readiness = await app.inject({ method: 'GET', url: '/ready' })

    expect(health.statusCode).toBe(200)
    expect(health.json()).toEqual({ status: 'ok' })
    expect(health.headers['x-request-id']).toBeTruthy()
    expect(liveness.statusCode).toBe(200)
    expect(healthReadiness.statusCode).toBe(200)
    expect(readiness.statusCode).toBe(200)
    expect(readiness.json()).toEqual({ status: 'ok' })
    await app.close()
  })

  it('separates domain degradation from process liveness and exposes low-cardinality metrics', async () => {
    const app = buildApp({
      config: testConfig,
      readinessDependency: { checkReadiness: async () => undefined },
      domainHealthDependency: {
        checkDomainHealth: async () => ({
          status: 'degraded',
          checks: { outgoing_backlog: 'degraded' },
        }),
      },
    })

    const domain = await app.inject({ method: 'GET', url: '/health/domain' })
    const live = await app.inject({ method: 'GET', url: '/health/live' })
    const metrics = await app.inject({ method: 'GET', url: '/metrics' })

    expect(domain.statusCode).toBe(503)
    expect(domain.json()).toEqual({
      status: 'degraded',
      checks: { outgoing_backlog: 'degraded' },
    })
    expect(live.statusCode).toBe(200)
    expect(metrics.statusCode).toBe(200)
    expect(metrics.body).toContain('mux_api_requests_total{status="200"}')
    expect(metrics.body).not.toContain('/health/domain')
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
