import { describe, expect, it } from 'vitest'
import { reservationAmountInUsdAtomic } from './reservation-amount.js'

describe('reservationAmountInUsdAtomic', () => {
  it('keeps legacy USD cents when the stored scale is absent', () => {
    expect(reservationAmountInUsdAtomic(250n, null)).toBe(250n)
  })

  it('converts denomination atomic units to USD cents', () => {
    expect(reservationAmountInUsdAtomic(10_000n, 6)).toBe(1n)
    expect(reservationAmountInUsdAtomic(20_000n, 6)).toBe(2n)
  })

  it('rejects reservation amounts that include fractions of a cent', () => {
    expect(() => reservationAmountInUsdAtomic(10_001n, 6)).toThrow(
      'Outgoing reservation cannot be represented in USD cents',
    )
  })
})
