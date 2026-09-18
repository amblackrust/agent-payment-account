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
    const serializedPayment = {
      id: 'pay_1',
      kind: 'PAY',
      recipient_id: 'recipient_1',
      description: null,
      external_reference: null,
      metadata: {},
      amount: '1.25',
      denomination_id: 'usd',
      denomination_symbol: 'USD',
      status: 'ROUTING',
      policy_decision: 'ALLOW',
      policy_reason_codes: [],
      approval_state: 'NOT_REQUIRED',
      attempt_count: 1,
      reservation_status: 'HELD',
      route_id: 'route_1',
      route_selection_reason: 'preferred',
      settlement_asset_id: 'asset_usdc',
      execution_state: 'QUEUED',
      settlement_state: 'NOT_SUBMITTED',
      outcome_state: 'NONE',
      created_at: '2026-09-18T00:00:00.000Z',
      updated_at: '2026-09-18T00:00:00.000Z',
      confirmed_at: null,
      failure_code: null,
      failure_message: null,
      original_payment_id: null,
    }
    const serialize = vi.fn(async () => serializedPayment)
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
    expect(response.json()).toEqual(serializedPayment)
    expect(getPayment).toHaveBeenCalledWith('acct_1', 'pay_1')
    expect(serialize).toHaveBeenCalledOnce()
    expect(consumeRateLimit).not.toHaveBeenCalled()
    expect(response.headers['x-correlation-id']).toBe('trace-v2')
    await app.close()
  })

  it('exposes atomic versioned policy replacement through the admin contract', async () => {
    const getPolicy = vi.fn(async () => ({ id: 'policy_1', status: 'ACTIVE' }))
    const replacePolicy = vi.fn(async (input: unknown) => input)
    const app = buildApp({
      config: testConfig,
      readinessDependency: { checkReadiness: async () => undefined },
      accountRepository: {} as never,
      accountService: {} as never,
      solanaRail: {} as never,
      v2ManagementService: { getPolicy, replacePolicy } as never,
    })

    const headers = { 'x-admin-api-key': testConfig.adminApiKey }
    const current = await app.inject({
      method: 'GET',
      url: '/v2/accounts/acct_1/policy',
      headers,
    })
    const replacement = await app.inject({
      method: 'PUT',
      url: '/v2/accounts/acct_1/policy',
      headers,
      payload: {
        denomination_id: 'usd',
        max_per_payment: '1.25',
        version: 1,
      },
    })

    expect(current.statusCode).toBe(200)
    expect(current.json()).toEqual({ id: 'policy_1', status: 'ACTIVE' })
    expect(replacement.statusCode).toBe(200)
    expect(replacePolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'acct_1',
        denominationId: 'usd',
        maxPerPayment: '1.25',
        expectedVersion: 1,
        actorId: expect.stringMatching(/^platform-operator:/u),
      }),
    )
    await app.close()
  })
})
