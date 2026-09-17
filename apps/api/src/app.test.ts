import { describe, expect, it, vi } from 'vitest'

import { buildApp } from './app.js'
import type { AppConfig } from './config.js'
import type { AuthenticatedAccount } from '@agent-payment/db'

const testConfig: AppConfig = {
  databaseUrl: 'postgresql://postgres:postgres@localhost:5432/test',
  port: 3000,
  nodeEnv: 'test',
  runtimeRole: 'all',
  restoreGateRequired: false,
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

const authenticatedAccount: AuthenticatedAccount = {
  account: {
    id: 'acct_1',
    name: 'Test account',
    status: 'ACTIVE',
    solanaPublicKey: 'payer_public_key',
  },
  credential: {
    id: 'credential_1',
    accountId: 'acct_1',
    keyHash: 'hash',
    keyPrefix: 'apa_test',
    status: 'ACTIVE',
    scopes: ['payments:read'],
    expiresAt: null,
    revokedAt: null,
    lastUsedAt: null,
  },
}

describe('API foundation', () => {
  it('serves health and readiness endpoints', async () => {
    const app = buildApp({
      config: testConfig,
      readinessDependency: { checkReadiness: async () => undefined },
    })

    const health = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-correlation-id': 'trace-123' },
    })
    const liveness = await app.inject({ method: 'GET', url: '/health/live' })
    const healthReadiness = await app.inject({ method: 'GET', url: '/health/ready' })
    const readiness = await app.inject({ method: 'GET', url: '/ready' })

    expect(health.statusCode).toBe(200)
    expect(health.json()).toEqual({ status: 'ok' })
    expect(health.headers['x-request-id']).toBeTruthy()
    expect(health.headers['x-correlation-id']).toBe('trace-123')
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
          alerts: [
            {
              name: 'NO_PROGRESS' as const,
              severity: 'warning' as const,
              message: 'A durable workflow has not made progress',
            },
          ],
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
      alerts: [
        {
          name: 'NO_PROGRESS',
          severity: 'warning',
          message: 'A durable workflow has not made progress',
        },
      ],
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

  it('serves a V2 payment through the authenticated HTTP contract', async () => {
    const getPayment = vi.fn(async () => ({}) as never)
    const serialize = vi.fn(async () => ({ payment_id: 'pay_1', status: 'ROUTING' }))
    const consumeRateLimit = vi.fn(async () => ({
      allowed: true,
      count: 1,
      retryAt: new Date('2026-09-18T00:01:00.000Z'),
    }))
    const app = buildApp({
      config: testConfig,
      readinessDependency: { checkReadiness: async () => undefined },
      accountRepository: {
        findAccountByCredentialHash: async () => authenticatedAccount,
        markCredentialUsed: async () => undefined,
      } as never,
      accountService: {} as never,
      solanaRail: {} as never,
      v2PaymentService: { getPayment, serialize } as never,
      v2AdminRepository: { consumeRateLimit },
    })

    const response = await app.inject({
      method: 'GET',
      url: '/v2/payments/pay_1',
      headers: {
        authorization: 'Bearer test-agent-key',
        'x-correlation-id': 'trace-v2',
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ payment_id: 'pay_1', status: 'ROUTING' })
    expect(getPayment).toHaveBeenCalledWith('acct_1', 'pay_1')
    expect(serialize).toHaveBeenCalledOnce()
    expect(consumeRateLimit).not.toHaveBeenCalled()
    expect(response.headers['x-correlation-id']).toBe('trace-v2')
    await app.close()
  })
})
