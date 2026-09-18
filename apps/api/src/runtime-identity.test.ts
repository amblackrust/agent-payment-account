import { describe, expect, it, vi } from 'vitest'
import type { SettlementRoute } from '@agent-payment/core'
import type { DatabaseClient } from '@agent-payment/db'
import type { AppConfig } from './config.js'
import { buildRuntimeIdentity } from './runtime-identity.js'

const route: SettlementRoute = {
  id: 'route_solana',
  rail: 'SOLANA_SPL',
  railVersion: '1',
  network: 'localnet',
  settlementAssetId: 'asset_usdc',
  economicMappingId: 'mapping_usd_usdc',
  status: 'ACTIVE',
  priority: 1,
  configVersion: 'route-v1',
}

const config = {
  nodeEnv: 'test',
  solanaCluster: 'localnet',
  solanaSettlementMint: 'mint-usdc',
  solanaFeePayerIdentity: 'fee-payer-public-key',
  custodyBackendIdentity: 'local-test-custody',
  custodyBackendMode: 'LOCAL_TEST',
} as AppConfig

function createDatabase(assetReference = 'mint-usdc'): DatabaseClient {
  return {
    v2: {
      listActiveSettlementRoutes: vi.fn(async () => [route]),
      findSettlementAsset: vi.fn(async () => ({
        id: 'asset_usdc',
        rail: 'SOLANA_SPL',
        network: 'localnet',
        assetReference,
        decimals: 6,
        status: 'ACTIVE',
        version: 2,
      })),
      findEconomicMapping: vi.fn(async () => ({
        id: 'mapping_usd_usdc',
        denominationId: 'denom_usd',
        settlementAssetId: 'asset_usdc',
        numerator: 1n,
        denominator: 1n,
        status: 'ACTIVE',
        version: 3,
      })),
    },
  } as unknown as DatabaseClient
}

describe('financial runtime identity', () => {
  it('binds environment, fee payer, route and economic mapping versions', async () => {
    await expect(
      buildRuntimeIdentity({
        database: createDatabase(),
        config,
        custodyKeyFingerprint: 'wallet-fingerprint',
      }),
    ).resolves.toMatchObject({
      environment: 'test',
      feePayerIdentity: 'fee-payer-public-key',
      routeId: 'route_solana',
      routeConfigVersion: 'route-v1',
      settlementAssetVersion: 2,
      economicMappingVersion: 3,
      routes: [
        {
          id: 'route_solana',
          railVersion: '1',
          configVersion: 'route-v1',
          settlementAssetId: 'asset_usdc',
          settlementAssetVersion: 2,
          economicMappingId: 'mapping_usd_usdc',
          economicMappingVersion: 3,
        },
      ],
    })
  })

  it('fails closed when the active route does not match the configured asset', async () => {
    await expect(
      buildRuntimeIdentity({
        database: createDatabase('unexpected-mint'),
        config,
      }),
    ).rejects.toThrow('does not match the configured Solana financial identity')
  })
})
