import { describe, expect, it } from 'vitest'

import {
  addMoney,
  compareMoney,
  createMoney,
  createPositiveMoney,
  formatMoney,
  parseDecimalToAtomicUnits,
  subtractMoney,
  UnsupportedCurrencyError,
  ValidationError,
} from './index.js'

describe('money primitives', () => {
  it('parses decimal strings without floating-point arithmetic', () => {
    expect(parseDecimalToAtomicUnits('10')).toBe(1000n)
    expect(parseDecimalToAtomicUnits('10.00')).toBe(1000n)
    expect(parseDecimalToAtomicUnits('0.01')).toBe(1n)
    expect(formatMoney(createMoney('12.50'))).toBe('12.50')
  })

  it('keeps precision for very large amounts', () => {
    const money = createMoney('9007199254740993.01')

    expect(money.atomicUnits).toBe(900719925474099301n)
    expect(formatMoney(money)).toBe('9007199254740993.01')
  })

  it.each(['0.001', '-1', '+1', '1e2', ' 1', '1 ', 'NaN', 'Infinity', ''])(
    'rejects invalid amount %j',
    (amount) => {
      expect(() => parseDecimalToAtomicUnits(amount)).toThrow(ValidationError)
    },
  )

  it('rejects zero where a positive amount is required', () => {
    expect(() => createPositiveMoney('0')).toThrow(ValidationError)
  })

  it('supports exact arithmetic and comparison', () => {
    const left = createMoney('10.25')
    const right = createMoney('2.25')

    expect(formatMoney(addMoney(left, right))).toBe('12.50')
    expect(formatMoney(subtractMoney(left, right))).toBe('8.00')
    expect(compareMoney(left, right)).toBe(1)
    expect(compareMoney(right, left)).toBe(-1)
    expect(compareMoney(left, createMoney('10.25'))).toBe(0)
  })

  it('rejects unsupported currencies', () => {
    expect(() => createMoney('1', 'EUR')).toThrow(UnsupportedCurrencyError)
  })
})
