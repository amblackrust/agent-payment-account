import type { DatabaseClient } from '@agent-payment/db'
import { DependencyUnavailableError } from '@agent-payment/core'
import type { SolanaCluster, SolanaRail } from '@agent-payment/solana-rail'
import type { V2FundingProvisioner } from './accounts.js'

export function createFundingProvisioner(input: {
  readonly database: Pick<DatabaseClient, 'v2' | 'v2Admin'>
  readonly rail: SolanaRail
  readonly solanaCluster: SolanaCluster
  readonly settlementMint: string
}): V2FundingProvisioner {
  return {
    provision: async ({ accountId, owner }) => {
      const routes = await input.database.v2.listActiveSettlementRoutes()
      const route = routes[0]
      if (route === undefined) {
        throw new DependencyUnavailableError('No active settlement route is configured')
      }
      const asset = await input.database.v2.findSettlementAsset(route.settlementAssetId)
      if (asset === null) {
        throw new DependencyUnavailableError(
          'Settlement asset configuration is unavailable',
        )
      }
      if (
        route.rail !== 'SOLANA_SPL' ||
        route.network !== input.solanaCluster ||
        asset.rail !== route.rail ||
        asset.network !== route.network ||
        asset.assetReference !== input.settlementMint
      ) {
        throw new DependencyUnavailableError(
          'Funding route does not match the configured Solana settlement identity',
        )
      }
      await input.rail.checkReadiness?.()
      const destination = await input.rail.getReceiveDestination(owner)
      const balance = await input.rail.getSettlementBalance(owner)
      if (balance.ataStatus !== 'PRESENT') {
        throw new DependencyUnavailableError(
          'Funding destination token account is not ready',
        )
      }
      await input.database.v2Admin.upsertFundingDestination({
        id: `funding_${accountId}_${route.id}_${asset.id}`,
        accountId,
        routeId: route.id,
        network: route.network,
        assetId: asset.id,
        destination: destination.tokenAccount,
        readiness: 'READY',
        senderConstraintsJson: JSON.stringify({
          rail: route.rail,
          asset_reference: asset.assetReference,
          destination_owner: destination.owner,
        }),
        lastValidatedAt: new Date(),
      })
    },
  }
}
