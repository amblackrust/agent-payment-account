import type {
  DatabaseClient,
  RuntimeIdentity,
  RuntimeRouteIdentity,
} from '@agent-payment/db'

import { ConfigurationError, type AppConfig } from './config.js'

const RUNTIME_IDENTITY_VERSION = '1'

export async function buildRuntimeIdentity(input: {
  readonly database: DatabaseClient
  readonly config: AppConfig
  readonly custodyKeyFingerprint?: string
}): Promise<RuntimeIdentity> {
  const feePayerIdentity = input.config.solanaFeePayerIdentity
  if (feePayerIdentity === undefined) {
    throw new ConfigurationError(
      'SOLANA_FEE_PAYER_IDENTITY is required to initialize financial runtime identity',
    )
  }

  const routes = await input.database.v2.listActiveSettlementRoutes()
  const route = routes[0]
  if (route === undefined) {
    throw new ConfigurationError(
      'At least one active settlement route is required to initialize financial runtime identity',
    )
  }
  const routeIdentities = await Promise.all(
    routes.map(async (candidate): Promise<RuntimeRouteIdentity> => {
      const [asset, mapping] = await Promise.all([
        input.database.v2.findSettlementAsset(candidate.settlementAssetId),
        input.database.v2.findEconomicMapping(candidate.economicMappingId),
      ])
      if (asset === null || mapping === null) {
        throw new ConfigurationError(
          `Active settlement route ${candidate.id} has incomplete asset or economic mapping identity`,
        )
      }
      if (
        candidate.rail !== 'SOLANA_SPL' ||
        candidate.network !== input.config.solanaCluster ||
        asset.rail !== candidate.rail ||
        asset.network !== candidate.network ||
        asset.assetReference !== input.config.solanaSettlementMint ||
        mapping.settlementAssetId !== asset.id
      ) {
        throw new ConfigurationError(
          `Active settlement route ${candidate.id} does not match the configured Solana financial identity`,
        )
      }
      return {
        id: candidate.id,
        railVersion: candidate.railVersion,
        configVersion: candidate.configVersion,
        settlementAssetId: asset.id,
        settlementAssetVersion: asset.version,
        economicMappingId: mapping.id,
        economicMappingVersion: mapping.version,
      }
    }),
  )
  const primary = routeIdentities[0]
  if (primary === undefined) {
    throw new ConfigurationError(
      'At least one active settlement route is required to initialize financial runtime identity',
    )
  }

  return {
    environment: input.config.nodeEnv,
    rail: route.rail,
    version: RUNTIME_IDENTITY_VERSION,
    railVersion: route.railVersion,
    cluster: input.config.solanaCluster,
    settlementMint: input.config.solanaSettlementMint,
    feePayerIdentity,
    routeId: primary.id,
    routeConfigVersion: primary.configVersion,
    settlementAssetId: primary.settlementAssetId,
    settlementAssetVersion: primary.settlementAssetVersion,
    economicMappingId: primary.economicMappingId,
    economicMappingVersion: primary.economicMappingVersion,
    routes: routeIdentities,
    ...(input.custodyKeyFingerprint === undefined
      ? {}
      : { custodyKeyFingerprint: input.custodyKeyFingerprint }),
    ...(input.config.custodyBackendIdentity === undefined
      ? {}
      : { custodyBackendIdentity: input.config.custodyBackendIdentity }),
    ...(input.config.custodyBackendMode === undefined
      ? {}
      : { custodyBackendMode: input.config.custodyBackendMode }),
  }
}
