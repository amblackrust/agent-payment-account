import { InsufficientFundsError, ValidationError } from './errors.js'

/**
 * The default is an implementation guard, not a product decision.  The
 * product-level maximum remains configurable until the precision decision is
 * explicitly made.
 */
export const DEFAULT_MAX_LOGICAL_MONEY_SCALE = 18

export type LifecycleStatus = 'ACTIVE' | 'RETIRED'

export interface Denomination {
  readonly id: string
  readonly symbol: string
  readonly maxScale: number
  readonly status: LifecycleStatus
  readonly version: number
}

export interface SettlementAsset {
  readonly id: string
  readonly rail: string
  readonly network: string
  readonly assetReference: string
  readonly decimals: number
  readonly status: LifecycleStatus
  readonly version: number
}

export interface EconomicMapping {
  readonly id: string
  readonly denominationId: string
  readonly settlementAssetId: string
  readonly numerator: bigint
  readonly denominator: bigint
  readonly status: LifecycleStatus
  readonly version: number
}

export interface ExactMoney {
  readonly denominationId: string
  /** Canonical decimal representation, without exponent notation. */
  readonly amount: string
  /** Scaled integer using the denomination's maxScale. */
  readonly atomicUnits: bigint
  readonly scale: number
}

export interface DenominationInput {
  readonly id: string
  readonly symbol: string
  readonly maxScale: number
  readonly status?: LifecycleStatus
  readonly version?: number
}

export interface MoneyPrecisionConfig {
  readonly maxLogicalScale: number
}

export interface SettlementAssetInput {
  readonly id: string
  readonly rail: string
  readonly network: string
  readonly assetReference: string
  readonly decimals: number
  readonly status?: LifecycleStatus
  readonly version?: number
}

export interface EconomicMappingInput {
  readonly id: string
  readonly denominationId: string
  readonly settlementAssetId: string
  readonly numerator: bigint
  readonly denominator: bigint
  readonly status?: LifecycleStatus
  readonly version?: number
}

export function createDenomination(
  input: DenominationInput,
  precision: MoneyPrecisionConfig = {
    maxLogicalScale: DEFAULT_MAX_LOGICAL_MONEY_SCALE,
  },
): Denomination {
  assertNonEmpty(input.id, 'Denomination id')
  assertNonEmpty(input.symbol, 'Denomination symbol')
  assertScale(input.maxScale, precision.maxLogicalScale)
  return {
    id: input.id,
    symbol: input.symbol,
    maxScale: input.maxScale,
    status: input.status ?? 'ACTIVE',
    version: validateVersion(input.version ?? 1),
  }
}

export function createSettlementAsset(input: SettlementAssetInput): SettlementAsset {
  assertNonEmpty(input.id, 'Settlement asset id')
  assertNonEmpty(input.rail, 'Settlement asset rail')
  assertNonEmpty(input.network, 'Settlement asset network')
  assertNonEmpty(input.assetReference, 'Settlement asset reference')
  if (!Number.isInteger(input.decimals) || input.decimals < 0 || input.decimals > 255) {
    throw new ValidationError(
      'Settlement asset decimals must be an integer from 0 to 255',
    )
  }
  return {
    id: input.id,
    rail: input.rail,
    network: input.network,
    assetReference: input.assetReference,
    decimals: input.decimals,
    status: input.status ?? 'ACTIVE',
    version: validateVersion(input.version ?? 1),
  }
}

export function createEconomicMapping(input: EconomicMappingInput): EconomicMapping {
  assertNonEmpty(input.id, 'Economic mapping id')
  assertNonEmpty(input.denominationId, 'Economic mapping denomination id')
  assertNonEmpty(input.settlementAssetId, 'Economic mapping settlement asset id')
  if (input.numerator <= 0n || input.denominator <= 0n) {
    throw new ValidationError('Economic mapping ratio must be positive')
  }
  return {
    id: input.id,
    denominationId: input.denominationId,
    settlementAssetId: input.settlementAssetId,
    numerator: input.numerator,
    denominator: input.denominator,
    status: input.status ?? 'ACTIVE',
    version: validateVersion(input.version ?? 1),
  }
}

export function parseExactMoney(value: string, denomination: Denomination): ExactMoney {
  assertActive(denomination.status, 'Denomination')
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError('Amount must be a non-empty decimal string')
  }
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value)
  if (match === null) {
    throw new ValidationError(
      'Amount must be a plain decimal string without exponent notation',
    )
  }
  const wholePart = match[1]?.replace(/^0+(?=\d)/u, '')
  const fractionPart = match[2] ?? ''
  if (wholePart === undefined || fractionPart.length > denomination.maxScale) {
    throw new ValidationError(
      `Amount supports at most ${denomination.maxScale} decimal places for ${denomination.symbol}`,
    )
  }
  const scale = 10n ** BigInt(denomination.maxScale)
  const atomicUnits =
    BigInt(wholePart) * scale +
    BigInt(fractionPart.padEnd(denomination.maxScale, '0') || '0')
  return {
    denominationId: denomination.id,
    amount: canonicalDecimal(wholePart, fractionPart),
    atomicUnits,
    scale: denomination.maxScale,
  }
}

export function exactMoneyFromAtomicUnits(
  atomicUnits: bigint,
  denomination: Denomination,
): ExactMoney {
  assertActive(denomination.status, 'Denomination')
  if (atomicUnits < 0n) {
    throw new ValidationError('Money atomic units cannot be negative')
  }
  const scale = 10n ** BigInt(denomination.maxScale)
  const wholePart = atomicUnits / scale
  const fractionPart = (atomicUnits % scale)
    .toString()
    .padStart(denomination.maxScale, '0')
  return {
    denominationId: denomination.id,
    amount: canonicalDecimal(wholePart.toString(), fractionPart),
    atomicUnits,
    scale: denomination.maxScale,
  }
}

export function formatExactMoney(money: ExactMoney): string {
  return money.amount
}

export function addExactMoney(left: ExactMoney, right: ExactMoney): ExactMoney {
  assertSameMoneyShape(left, right)
  return withAtomicUnits(left, left.atomicUnits + right.atomicUnits)
}

export function subtractExactMoney(left: ExactMoney, right: ExactMoney): ExactMoney {
  assertSameMoneyShape(left, right)
  const atomicUnits = left.atomicUnits - right.atomicUnits
  if (atomicUnits < 0n) {
    throw new InsufficientFundsError()
  }
  return withAtomicUnits(left, atomicUnits)
}

export function withAtomicUnits(money: ExactMoney, atomicUnits: bigint): ExactMoney {
  if (atomicUnits < 0n) {
    throw new ValidationError('Money atomic units cannot be negative')
  }
  return {
    ...money,
    amount: formatAtomicUnits(atomicUnits, money.scale),
    atomicUnits,
  }
}

export function compareExactMoney(left: ExactMoney, right: ExactMoney): -1 | 0 | 1 {
  assertSameMoneyShape(left, right)
  if (left.atomicUnits < right.atomicUnits) return -1
  if (left.atomicUnits > right.atomicUnits) return 1
  return 0
}

/**
 * Converts logical denomination units to settlement atomic units.  The
 * divisibility check is deliberate: silently rounding a payment would change
 * its historical economic intent.
 */
export function convertToSettlementAtomicUnits(
  money: ExactMoney,
  mapping: EconomicMapping,
  asset: SettlementAsset,
): bigint {
  assertActive(mapping.status, 'Economic mapping')
  assertActive(asset.status, 'Settlement asset')
  if (money.denominationId !== mapping.denominationId) {
    throw new ValidationError('Economic mapping does not match the denomination')
  }
  if (asset.id !== mapping.settlementAssetId) {
    throw new ValidationError('Economic mapping does not match the settlement asset')
  }
  const numerator = money.atomicUnits * mapping.numerator
  if (numerator % mapping.denominator !== 0n) {
    throw new ValidationError(
      'Economic mapping requires rounding and cannot be applied exactly',
    )
  }
  const atomicUnits = numerator / mapping.denominator
  if (atomicUnits < 0n) {
    throw new ValidationError('Settlement atomic units cannot be negative')
  }
  return atomicUnits
}

/**
 * Converts a settlement balance back into logical denomination units. The
 * divisibility check prevents a balance from being overstated by truncation.
 */
export function convertFromSettlementAtomicUnits(
  settlementAtomicUnits: bigint,
  mapping: EconomicMapping,
  denomination: Denomination,
  asset: SettlementAsset,
): ExactMoney {
  assertActive(mapping.status, 'Economic mapping')
  assertActive(asset.status, 'Settlement asset')
  assertActive(denomination.status, 'Denomination')
  if (settlementAtomicUnits < 0n) {
    throw new ValidationError('Settlement atomic units cannot be negative')
  }
  if (denomination.id !== mapping.denominationId) {
    throw new ValidationError('Economic mapping does not match the denomination')
  }
  if (asset.id !== mapping.settlementAssetId) {
    throw new ValidationError('Economic mapping does not match the settlement asset')
  }
  const numerator = settlementAtomicUnits * mapping.denominator
  if (numerator % mapping.numerator !== 0n) {
    throw new ValidationError(
      'Settlement balance cannot be represented exactly in the denomination',
    )
  }
  return exactMoneyFromAtomicUnits(numerator / mapping.numerator, denomination)
}

export function assertSameSettlementAsset(
  left: SettlementAsset,
  right: SettlementAsset,
): void {
  if (
    left.id !== right.id ||
    left.rail !== right.rail ||
    left.network !== right.network ||
    left.assetReference !== right.assetReference ||
    left.version !== right.version
  ) {
    throw new ValidationError('Settlement assets are not identical')
  }
}

function canonicalDecimal(wholePart: string, fractionPart: string): string {
  const canonicalWhole = wholePart.replace(/^0+(?=\d)/u, '')
  const trimmedFraction = fractionPart.replace(/0+$/u, '')
  return trimmedFraction.length === 0
    ? canonicalWhole
    : `${canonicalWhole}.${trimmedFraction}`
}

function formatAtomicUnits(atomicUnits: bigint, scale: number): string {
  const divisor = 10n ** BigInt(scale)
  const wholePart = atomicUnits / divisor
  const fractionPart = (atomicUnits % divisor).toString().padStart(scale, '0')
  return canonicalDecimal(wholePart.toString(), fractionPart)
}

function assertSameMoneyShape(left: ExactMoney, right: ExactMoney): void {
  if (left.denominationId !== right.denominationId || left.scale !== right.scale) {
    throw new ValidationError('Money values must use the same denomination and scale')
  }
}

function assertActive(status: LifecycleStatus, name: string): void {
  if (status !== 'ACTIVE') {
    throw new ValidationError(`${name} is not active`)
  }
}

function assertNonEmpty(value: string, name: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ValidationError(`${name} must not be empty`)
  }
}

function assertScale(value: number, maxLogicalScale: number): void {
  if (
    !Number.isInteger(value) ||
    value < 0 ||
    !Number.isInteger(maxLogicalScale) ||
    maxLogicalScale < 0 ||
    value > maxLogicalScale
  ) {
    throw new ValidationError(
      `Denomination maxScale must be an integer from 0 to ${maxLogicalScale}`,
    )
  }
}

function validateVersion(value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ValidationError('Version must be a positive integer')
  }
  return value
}
