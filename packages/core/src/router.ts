import { UnsupportedRailError } from './errors.js'
import type { PaymentRail, RailPaymentRequest } from './rail.js'

export function selectPaymentRail(
  request: RailPaymentRequest,
  rails: readonly PaymentRail[],
): PaymentRail {
  const candidates = rails
    .filter((rail) => rail.canRoute(request))
    .sort((left, right) => compareStrings(left.name, right.name))

  const selected = candidates[0]
  if (selected === undefined) {
    throw new UnsupportedRailError(request.destination.rail)
  }
  return selected
}

function compareStrings(left: string, right: string): -1 | 0 | 1 {
  if (left < right) {
    return -1
  }
  if (left > right) {
    return 1
  }
  return 0
}
