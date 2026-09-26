import {
  DEFAULT_MAX_LOGICAL_MONEY_SCALE,
  USD_DECIMAL_PLACES,
  ValidationError,
} from '@agent-payment/core'

export function reservationAmountInUsdAtomic(
  amountAtomic: bigint,
  amountScale: number | null,
): bigint {
  if (amountAtomic < 0n) {
    throw new ValidationError('Outgoing reservation amount cannot be negative')
  }

  const scale = amountScale ?? USD_DECIMAL_PLACES
  if (
    !Number.isInteger(scale) ||
    scale < 0 ||
    scale > DEFAULT_MAX_LOGICAL_MONEY_SCALE
  ) {
    throw new ValidationError('Outgoing reservation has an invalid amount scale')
  }

  const scaleDifference = scale - USD_DECIMAL_PLACES
  if (scaleDifference === 0) return amountAtomic
  if (scaleDifference < 0) {
    return amountAtomic * 10n ** BigInt(-scaleDifference)
  }

  const divisor = 10n ** BigInt(scaleDifference)
  if (amountAtomic % divisor !== 0n) {
    throw new ValidationError(
      'Outgoing reservation cannot be represented in USD cents',
    )
  }
  return amountAtomic / divisor
}
