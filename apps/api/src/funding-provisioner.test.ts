import { describe, expect, it, vi } from 'vitest'

import { moneyFromAtomicUnits, type SettlementRoute } from '@agent-payment/core'
import type {
  DatabaseClient,
  V2AccountRecord,
  V2AdminRepository,
  V2CredentialRecord,
} from '@agent-payment/db'
import type { SolanaRail } from '@agent-payment/solana-rail'
import { AccountService } from './accounts.js'
import { RecoveryEnvelopeCipher, WalletSecretCipher } from './custody.js'
import { createFundingProvisioner } from './funding-provisioner.js'

const masterKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
const settlementMint = 'settlement-mint'
const route: SettlementRoute = {
  id: 'route_solana',
  rail: 'SOLANA_SPL',
  railVersion: 'v1',
  network: 'localnet',
  settlementAssetId: 'asset_usdc',
  economicMappingId: 'mapping_usd_usdc',
  status: 'ACTIVE',
  priority: 1,
  configVersion: 'v1',
}
const asset = {
  id: 'asset_usdc',
  rail: 'SOLANA_SPL',
  network: 'localnet',
  assetReference: settlementMint,
  decimals: 6,
  status: 'ACTIVE',
  version: 1,
}

function createRail(
  ataStatus: 'MISSING' | 'PRESENT',
  options: {
    readonly atomicBalance?: bigint
    readonly rejectUsdBalance?: boolean
  } = {},
): SolanaRail {
  const rail: SolanaRail = {
    checkReadiness: vi.fn(async () => undefined),
    getReceiveDestination: vi.fn(async (owner) => ({
      owner,
      tokenAccount: 'token-account',
      settlementMint,
    })),
    getSettlementBalance: vi.fn(async () => {
      if (options.rejectUsdBalance === true) {
        throw new Error('USD projection should not be used for atomic readiness')
      }
      return {
        currency: 'USD' as const,
        settled: moneyFromAtomicUnits(0n),
        tokenAtomicUnits: 0n,
        tokenDecimals: 6,
        ata: 'token-account',
        ataStatus,
      }
    }),
  }
  if (options.atomicBalance !== undefined) {
    rail.getSettlementAtomicBalance = vi.fn(async () => ({
      tokenAtomicUnits: options.atomicBalance ?? 0n,
      tokenDecimals: 6,
      ata: 'token-account',
      ataStatus,
    }))
  }
  return rail
}

function createProvisioningHarness(ataStatus: 'MISSING' | 'PRESENT') {
  const rail = createRail(ataStatus)
  const upsertFundingDestination = vi.fn(
    async (input: Parameters<V2AdminRepository['upsertFundingDestination']>[0]) => ({
      ...input,
      lastValidatedAt: input.lastValidatedAt ?? null,
      lastFailureCode: null,
    }),
  )
  let account: V2AccountRecord = {
    id: 'acct_funding',
    name: 'funding-account',
    status: 'PROVISIONING',
    solanaPublicKey: 'owner-address',
    workspaceId: null,
    runtimeVersion: 'v2',
    provisioningFailureCode: null,
    disabledAt: null,
    disabledReason: null,
    rowVersion: 1,
    createdAt: new Date('2026-09-18T00:00:00.000Z'),
    updatedAt: new Date('2026-09-18T00:00:00.000Z'),
  }
  const credential: V2CredentialRecord = {
    id: 'cred_funding',
    accountId: account.id,
    keyPrefix: 'apa_funding',
    status: 'ACTIVE',
    scopes: ['payments:read'],
    expiresAt: null,
    rotatedFromId: null,
    rowVersion: 1,
    createdAt: account.createdAt,
    revokedAt: null,
  }
  type ProvisionAccountInput = Parameters<V2AdminRepository['provisionAccount']>[0]
  type TransitionAccountInput = Parameters<V2AdminRepository['transitionAccount']>[0]
  const v2Admin = {
    findProvisioningReplay: async () => null,
    provisionAccount: async (input: ProvisionAccountInput) => ({
      account: {
        ...account,
        id: input.accountId,
        name: input.name,
        solanaPublicKey: input.solanaPublicKey,
      },
      credential,
      recoveryEnvelope: {
        idempotencyKey: input.idempotencyKey,
        accountId: input.accountId,
        credentialId: input.credentialId,
        ciphertext: 'ciphertext',
        nonce: 'nonce',
        authTag: 'auth-tag',
        expiresAt: new Date('2026-09-18T00:15:00.000Z'),
      },
      created: true,
    }),
    findAccount: async () => account,
    transitionAccount: async (input: TransitionAccountInput) => {
      account = {
        ...account,
        status: input.nextStatus,
        rowVersion: input.rowVersion + 1,
      }
      return account
    },
    upsertFundingDestination,
  } as unknown as V2AdminRepository
  const database = {
    v2: {
      listActiveSettlementRoutes: async () => [route],
      findSettlementAsset: async () => asset,
    },
    v2Admin,
  } as unknown as Pick<DatabaseClient, 'v2' | 'v2Admin'>
  const fundingProvisioner = createFundingProvisioner({
    database,
    rail,
    solanaCluster: 'localnet',
    settlementMint,
  })
  const service = new AccountService(
    {} as never,
    new WalletSecretCipher(masterKey),
    rail,
    v2Admin,
    new RecoveryEnvelopeCipher(masterKey),
    fundingProvisioner,
  )

  return {
    service,
    getAccount: () => account,
    upsertFundingDestination,
  }
}

function createDirectProvisioner(
  ataStatus: 'MISSING' | 'PRESENT',
  routeOverride: SettlementRoute = route,
  assetOverride = asset,
  railOptions: {
    readonly atomicBalance?: bigint
    readonly rejectUsdBalance?: boolean
  } = {},
) {
  const rail = createRail(ataStatus, railOptions)
  const upsertFundingDestination = vi.fn(
    async (input: Parameters<V2AdminRepository['upsertFundingDestination']>[0]) => ({
      ...input,
      lastValidatedAt: input.lastValidatedAt ?? null,
      lastFailureCode: null,
    }),
  )
  const database = {
    v2: {
      listActiveSettlementRoutes: async () => [routeOverride],
      findSettlementAsset: async () => assetOverride,
    },
    v2Admin: { upsertFundingDestination },
  } as unknown as Pick<DatabaseClient, 'v2' | 'v2Admin'>

  return {
    provisioner: createFundingProvisioner({
      database,
      rail,
      solanaCluster: 'localnet',
      settlementMint,
    }),
    upsertFundingDestination,
  }
}

describe('createFundingProvisioner', () => {
  it('rejects MISSING ATA without persisting READY', async () => {
    const harness = createDirectProvisioner('MISSING')

    await expect(
      harness.provisioner.provision({ accountId: 'acct_1', owner: 'owner_1' }),
    ).rejects.toMatchObject({
      message: 'Funding destination token account is not ready',
    })
    expect(harness.upsertFundingDestination).not.toHaveBeenCalled()
  })

  it('persists READY when the ATA is PRESENT', async () => {
    const harness = createDirectProvisioner('PRESENT')

    await harness.provisioner.provision({ accountId: 'acct_1', owner: 'owner_1' })

    expect(harness.upsertFundingDestination).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'acct_1',
        readiness: 'READY',
        destination: 'token-account',
      }),
    )
  })

  it('uses atomic readiness when a sub-cent token balance cannot be represented as USD cents', async () => {
    const harness = createDirectProvisioner('PRESENT', route, asset, {
      atomicBalance: 500n,
      rejectUsdBalance: true,
    })

    await harness.provisioner.provision({ accountId: 'acct_1', owner: 'owner_1' })

    expect(harness.upsertFundingDestination).toHaveBeenCalledWith(
      expect.objectContaining({ readiness: 'READY' }),
    )
  })

  it('keeps the persisted destination identifier within the database limit', async () => {
    const longRoute: SettlementRoute = {
      ...route,
      id: 'route_' + 'r'.repeat(58),
    }
    const longAsset = {
      ...asset,
      id: 'asset_' + 'a'.repeat(58),
    }
    const harness = createDirectProvisioner('PRESENT', longRoute, longAsset)

    await harness.provisioner.provision({
      accountId: 'account_' + 'c'.repeat(56),
      owner: 'owner_1',
    })

    const [input] = harness.upsertFundingDestination.mock.calls[0] ?? []
    expect(input?.id).toMatch(/^funding_[0-9a-f]{56}$/u)
    expect(input?.id).toHaveLength(64)
  })
})

describe('funding provisioner readiness gate', () => {
  it('does not upsert READY and does not activate the account when the ATA is missing', async () => {
    const harness = createProvisioningHarness('MISSING')

    await expect(
      harness.service.createAccountV2('funding-account', 'funding-missing-key'),
    ).rejects.toMatchObject({
      message: 'Funding destination token account is not ready',
    })

    expect(harness.upsertFundingDestination).not.toHaveBeenCalled()
    expect(harness.getAccount().status).toBe('PROVISIONING_FAILED')
  })

  it('upserts READY and activates the account when the ATA is present', async () => {
    const harness = createProvisioningHarness('PRESENT')

    const result = await harness.service.createAccountV2(
      'funding-account',
      'funding-present-key',
    )

    expect(harness.upsertFundingDestination).toHaveBeenCalledWith(
      expect.objectContaining({
        readiness: 'READY',
        destination: 'token-account',
      }),
    )
    expect(harness.getAccount().status).toBe('ACTIVE')
    expect(result.status).toBe('ACTIVE')
  })
})
