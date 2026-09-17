import { UnsupportedRailError, ValidationError } from './errors.js'

export type SettlementRouteStatus = 'ACTIVE' | 'DISABLED' | 'RETIRED'

export interface SettlementRoute {
  readonly id: string
  readonly rail: string
  readonly railVersion: string
  readonly network: string
  readonly settlementAssetId: string
  readonly economicMappingId: string
  readonly status: SettlementRouteStatus
  readonly priority: number
  readonly configVersion: string
}

export interface RouteCapability {
  readonly routeId: string
  readonly eligible: boolean
  readonly reason?: string
  readonly observedAt: Date
  readonly identityVersion: string
}

export interface SettlementRouteSelectionInput {
  readonly explicitRouteId?: string
  readonly configuredDefaultRouteId?: string
  readonly routeIdsWithCapability?: readonly string[]
}

export interface SettlementRouteSelection {
  readonly route: SettlementRoute
  readonly reason:
    'EXPLICIT_PREFERENCE' | 'CONFIGURED_DEFAULT' | 'DETERMINISTIC_FALLBACK'
}

export function selectSettlementRoute(
  input: SettlementRouteSelectionInput,
  routes: readonly SettlementRoute[],
  capabilities: readonly RouteCapability[] = [],
): SettlementRouteSelection {
  const eligibleIds =
    input.routeIdsWithCapability === undefined
      ? new Set(routes.map((route) => route.id))
      : new Set(input.routeIdsWithCapability)
  const active = routes.filter(
    (route) => route.status === 'ACTIVE' && eligibleIds.has(route.id),
  )
  const byId = new Map(active.map((route) => [route.id, route]))
  const capabilityById = new Map(
    capabilities.map((capability) => [capability.routeId, capability]),
  )
  for (const route of active) {
    const capability = capabilityById.get(route.id)
    if (capability !== undefined && !capability.eligible) {
      byId.delete(route.id)
    }
  }
  const candidates = [...byId.values()].sort(
    (left, right) =>
      left.priority - right.priority || compareStrings(left.id, right.id),
  )
  if (input.explicitRouteId !== undefined) {
    const route = byId.get(input.explicitRouteId)
    if (route === undefined) {
      throw new UnsupportedRailError(input.explicitRouteId)
    }
    return { route, reason: 'EXPLICIT_PREFERENCE' }
  }
  if (input.configuredDefaultRouteId !== undefined) {
    const route = byId.get(input.configuredDefaultRouteId)
    if (route !== undefined) {
      return { route, reason: 'CONFIGURED_DEFAULT' }
    }
  }
  const route = candidates[0]
  if (route === undefined) {
    throw new ValidationError('No active settlement route is eligible')
  }
  return { route, reason: 'DETERMINISTIC_FALLBACK' }
}

function compareStrings(left: string, right: string): -1 | 0 | 1 {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}
