import { describe, expect, it } from 'vitest'

import type { AccountRepository, AuthenticatedAccount } from '@agent-payment/db'
import type { SolanaRail } from '@agent-payment/solana-rail'
import { moneyFromAtomicUnits } from '@agent-payment/core'
import { buildApp } from './app.js'
import type { AccountService, CreatedAccountResponse } from './accounts.js'
import { hashApiKey } from './auth.js'
import type { AppConfig } from './config.js'

const config: AppConfig = {
  databaseUrl: 'postgresql://postgres:postgres@localhost:5432/test',
  port: 3000,
  nodeEnv: 'test',
  adminApiKey: 'admin-test-key',
  solanaRpcUrl: 'http://127.0.0.1:8899',
  solanaCluster: 'localnet',
  solanaSettlementMint: 'settlement-mint',
  solanaFeePayerSecret: 'fee-payer-test-secret',
  walletMasterKey: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  allowMainnet: false,
}

const activeAccount: AuthenticatedAccount = {
  account: {
    id: 'acct_test',
    name: 'test-agent',
    status: 'ACTIVE',
    solanaPublicKey: 'owner-public-key',
  },
  credential: {
    id: 'cred_test',
    accountId: 'acct_test',
    keyHash: 'hash',
    keyPrefix: 'apa_test',
    revokedAt: null,
    lastUsedAt: null,
  },
}

const createdAccount: CreatedAccountResponse = {
  id: 'acct_created',
  name: 'new-agent',
  status: 'ACTIVE',
  apiKey: 'apa_one-time-key',
  receiveId: 'recv_created',
  destination: {
    owner: 'owner-public-key',
    tokenAccount: 'token-account',
    settlementMint: 'settlement-mint',
  },
}

function createRepository(account: AuthenticatedAccount | null): AccountRepository {
  return {
    createAgentAccount: async () => {
      throw new Error('not used in API auth tests')
    },
    findAccountByCredentialHash: async (keyHash) => {
      const expectedKey =
        account?.credential.revokedAt === null ? 'agent-key' : 'revoked-key'
      return account !== null && keyHash === hashApiKey(expectedKey) ? account : null
    },
    markCredentialUsed: async () => undefined,
    revokeCredential: async () => true,
  }
}

function createApp(account: AuthenticatedAccount | null = activeAccount) {
  const repository = createRepository(account)
  const accountService = {
    createAccount: async () => createdAccount,
  } as unknown as AccountService
  const rail: SolanaRail = {
    getSettlementBalance: async () => ({
      currency: 'USD',
      settled: moneyFromAtomicUnits(1250n),
      tokenAtomicUnits: 1250000n,
      tokenDecimals: 4,
      ata: 'token-account',
      ataStatus: 'PRESENT',
    }),
    getReceiveDestination: async () => createdAccount.destination,
  }
  return buildApp({
    config,
    readinessDependency: { checkReadiness: async () => undefined },
    accountRepository: repository,
    accountService,
    solanaRail: rail,
  })
}

describe('account API authentication', () => {
  it('rejects missing, unknown and revoked agent credentials', async () => {
    const app = createApp()
    const missing = await app.inject({ method: 'GET', url: '/v1/balance' })
    const unknown = await app.inject({
      method: 'GET',
      url: '/v1/balance',
      headers: { authorization: 'Bearer unknown-key' },
    })
    await app.close()

    const revokedApp = createApp({
      ...activeAccount,
      credential: { ...activeAccount.credential, revokedAt: new Date() },
    })
    const revoked = await revokedApp.inject({
      method: 'GET',
      url: '/v1/balance',
      headers: { authorization: 'Bearer revoked-key' },
    })
    await revokedApp.close()

    expect(missing.statusCode).toBe(401)
    expect(unknown.statusCode).toBe(401)
    expect(revoked.statusCode).toBe(401)
  })

  it('rejects disabled accounts and returns only the normalized balance', async () => {
    const app = createApp({
      ...activeAccount,
      account: { ...activeAccount.account, status: 'DISABLED' },
    })
    const disabled = await app.inject({
      method: 'GET',
      url: '/v1/balance',
      headers: { authorization: 'Bearer agent-key' },
    })
    await app.close()

    const activeApp = createApp()
    const balance = await activeApp.inject({
      method: 'GET',
      url: '/v1/balance',
      headers: { authorization: 'Bearer agent-key' },
    })
    await activeApp.close()

    expect(disabled.statusCode).toBe(401)
    expect(balance.statusCode).toBe(200)
    expect(balance.json()).toEqual({
      currency: 'USD',
      settled: '12.50',
      pending_outgoing: '0.00',
      available: '12.50',
    })
  })

  it('protects admin account creation and exposes the one-time key only in creation response', async () => {
    const app = createApp()
    const invalid = await app.inject({
      method: 'POST',
      url: '/v1/accounts',
      headers: { 'x-admin-api-key': 'wrong' },
      payload: { name: 'new-agent' },
    })
    const created = await app.inject({
      method: 'POST',
      url: '/v1/accounts',
      headers: { 'x-admin-api-key': config.adminApiKey },
      payload: { name: 'new-agent' },
    })
    await app.close()

    expect(invalid.statusCode).toBe(401)
    expect(created.statusCode).toBe(200)
    expect(created.json()).toEqual({
      id: 'acct_created',
      name: 'new-agent',
      status: 'ACTIVE',
      api_key: 'apa_one-time-key',
      receive: {
        id: 'recv_created',
        currency: 'USD',
        status: 'OPEN',
        destination: { type: 'external_transfer_target', reference: 'token-account' },
        settlement: {
          owner: 'owner-public-key',
          token_account: 'token-account',
          mint: 'settlement-mint',
        },
      },
    })
  })

  it('serves receive instructions without exposing blockchain computation to the agent', async () => {
    const app = createApp()
    const response = await app.inject({
      method: 'POST',
      url: '/v1/receives',
      headers: { authorization: 'Bearer agent-key' },
      payload: { currency: 'USD' },
    })
    await app.close()

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      account_id: 'acct_test',
      currency: 'USD',
      status: 'OPEN',
      destination: { type: 'external_transfer_target', reference: 'token-account' },
    })
  })

  it('allows only the admin to revoke a credential', async () => {
    const app = createApp()
    const invalid = await app.inject({
      method: 'POST',
      url: '/v1/accounts/acct_test/credentials/cred_test/revoke',
      headers: { 'x-admin-api-key': 'wrong' },
    })
    const revoked = await app.inject({
      method: 'POST',
      url: '/v1/accounts/acct_test/credentials/cred_test/revoke',
      headers: { 'x-admin-api-key': config.adminApiKey },
    })
    await app.close()

    expect(invalid.statusCode).toBe(401)
    expect(revoked.statusCode).toBe(200)
    expect(revoked.json()).toEqual({ status: 'REVOKED' })
  })
})
