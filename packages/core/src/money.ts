import {
  InsufficientFundsError,
  UnsupportedCurrencyError,
  ValidationError,
} from './errors.js'

export const CURRENCIES = {
  USD: 'USD',
} as const

export type Currency = (typeof CURRENCIES)[keyof typeof CURRENCIES]
export const USD_DECIMAL_PLACES = 2

export type AtomicUnits = bigint & {
  readonly __brand: 'AtomicUnits'
}

export interface Money {
  readonly currency: Currency
  readonly atomicUnits: AtomicUnits
}

function toAtomicUnits(value: bigint): AtomicUnits {
  return value as AtomicUnits
}

function assertSupportedCurrency(currency: string): asserts currency is Currency {
  if (currency !== CURRENCIES.USD) {
    throw new UnsupportedCurrencyError(currency)
  }
}

function assertSameCurrency(left: Money, right: Money): void {
  if (left.currency !== right.currency) {
    throw new ValidationError('Money values must use the same currency')
  }
}

export function parseDecimalToAtomicUnits(
  value: string,
  decimalPlaces = USD_DECIMAL_PLACES,
): AtomicUnits {
  if (!Number.isInteger(decimalPlaces) || decimalPlaces < 0) {
    throw new ValidationError('Decimal places must be a non-negative integer')
  }
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError('Amount must be a non-empty decimal string')
  }

  const match = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(value)
  if (match === null) {
    throw new ValidationError('Amount must be a plain decimal string')
  }

  const wholePart = match[1]
  if (wholePart === undefined) {
    throw new ValidationError('Amount must be a plain decimal string')
  }
  const fractionPart = match[2] ?? ''
  if (fractionPart.length > decimalPlaces) {
    throw new ValidationError(`Amount supports at most ${decimalPlaces} decimal places`)
  }

  const paddedFraction = fractionPart.padEnd(decimalPlaces, '0')
  const scale = 10n ** BigInt(decimalPlaces)
  const atomicValue = BigInt(wholePart) * scale + BigInt(paddedFraction || '0')
  return toAtomicUnits(atomicValue)
}

export function createMoney(amount: string, currency: string = CURRENCIES.USD): Money {
  assertSupportedCurrency(currency)
  return {
    currency,
    atomicUnits: parseDecimalToAtomicUnits(amount),
  }
}

export function createPositiveMoney(
  amount: string,
  currency: string = CURRENCIES.USD,
): Money {
  const money = createMoney(amount, currency)
  if (money.atomicUnits <= 0n) {
    throw new ValidationError('Amount must be greater than zero')
  }
  return money
}

export function moneyFromAtomicUnits(
  atomicUnits: bigint,
  currency: string = CURRENCIES.USD,
): Money {
  assertSupportedCurrency(currency)
  if (atomicUnits < 0n) {
    throw new ValidationError('Atomic units cannot be negative')
  }
  return { currency, atomicUnits: toAtomicUnits(atomicUnits) }
}

export function addMoney(left: Money, right: Money): Money {
  assertSameCurrency(left, right)
  return moneyFromAtomicUnits(left.atomicUnits + right.atomicUnits, left.currency)
}

export function subtractMoney(left: Money, right: Money): Money {
  assertSameCurrency(left, right)
  const result = left.atomicUnits - right.atomicUnits
  if (result < 0n) {
    throw new InsufficientFundsError()
  }
  return moneyFromAtomicUnits(result, left.currency)
}

export function compareMoney(left: Money, right: Money): -1 | 0 | 1 {
  assertSameCurrency(left, right)
  if (left.atomicUnits < right.atomicUnits) {
    return -1
  }
  if (left.atomicUnits > right.atomicUnits) {
    return 1
  }
  return 0
}

export function formatMoney(money: Money): string {
  const scale = 10n ** BigInt(USD_DECIMAL_PLACES)
  const wholePart = money.atomicUnits / scale
  const fractionPart = (money.atomicUnits % scale)
    .toString()
    .padStart(USD_DECIMAL_PLACES, '0')
  return `${wholePart}.${fractionPart}`
}
