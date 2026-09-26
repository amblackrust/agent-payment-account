import { describe, expect, it } from 'vitest'
import { selectSettlementRoute, type SettlementRoute } from './routing-v2.js'

const routes: SettlementRoute[] = [
  {
    id: 'route_b',
    rail: 'SOLANA_SPL',
    railVersion: '1',
    network: 'localnet',
    settlementAssetId: 'asset_b',
    economicMappingId: 'mapping_b',
    status: 'ACTIVE',
    priority: 2,
    configVersion: '1',
  },
  {
    id: 'route_a',
    rail: 'SOLANA_SPL',
    railVersion: '1',
    network: 'localnet',
    settlementAssetId: 'asset_a',
    economicMappingId: 'mapping_a',
    status: 'ACTIVE',
    priority: 1,
    configVersion: '1',
  },
]

describe('settlement route selection', () => {
  it('uses explicit preference before configured defaults', () => {
    expect(
      selectSettlementRoute(
        { explicitRouteId: 'route_b', configuredDefaultRouteId: 'route_a' },
        routes,
      ),
    ).toMatchObject({ route: { id: 'route_b' }, reason: 'EXPLICIT_PREFERENCE' })
  })

  it('uses deterministic priority then id fallback', () => {
    expect(selectSettlementRoute({}, routes).route.id).toBe('route_a')
  })
})
