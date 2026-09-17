import { describe, expect, it } from 'vitest'
import {
  convertToSettlementAtomicUnits,
  addExactMoney,
  createDenomination,
  createEconomicMapping,
  createSettlementAsset,
  formatExactMoney,
  parseExactMoney,
} from './exact-money.js'

const usd = createDenomination({ id: 'denom_usd', symbol: 'USD', maxScale: 6 })
const solanaUsdc = createSettlementAsset({
  id: 'asset_solana_usdc',
  rail: 'SOLANA_SPL',
  network: 'localnet',
  assetReference: 'mint-usdc',
  decimals: 6,
})

describe('exact money', () => {
  it('parses and canonicalizes decimal strings without using exponent notation', () => {
    const money = parseExactMoney('001', usd)
    expect(money.amount).toBe('1')
    expect(formatExactMoney(parseExactMoney('1.230000', usd))).toBe('1.23')
    expect(() => parseExactMoney('1e-2', usd)).toThrow(/plain decimal/i)
  })

  it('keeps denomination scale in the integer representation', () => {
    expect(parseExactMoney('1.23', usd).atomicUnits).toBe(1_230_000n)
    expect(
      formatExactMoney(
        addExactMoney(parseExactMoney('1.23', usd), parseExactMoney('0.77', usd)),
      ),
    ).toBe('2')
  })

  it('allows the deployment precision limit to be configured', () => {
    expect(
      createDenomination(
        { id: 'denom_high_precision', symbol: 'HP', maxScale: 24 },
        { maxLogicalScale: 24 },
      ).maxScale,
    ).toBe(24)
  })

  it('rejects values that require rounding during economic conversion', () => {
    const mapping = createEconomicMapping({
      id: 'mapping_usd_usdc',
      denominationId: usd.id,
      settlementAssetId: solanaUsdc.id,
      numerator: 1n,
      denominator: 3n,
    })
    expect(() =>
      convertToSettlementAtomicUnits(parseExactMoney('1', usd), mapping, solanaUsdc),
    ).toThrow(/rounding/i)
  })

  it('distinguishes settlement assets with the same symbol in different contexts', () => {
    const otherAsset = createSettlementAsset({
      ...solanaUsdc,
      id: 'asset_other_network_usdc',
      network: 'devnet',
    })
    const mapping = createEconomicMapping({
      id: 'mapping_usd_usdc',
      denominationId: usd.id,
      settlementAssetId: solanaUsdc.id,
      numerator: 1n,
      denominator: 1n,
    })
    expect(() =>
      convertToSettlementAtomicUnits(parseExactMoney('1', usd), mapping, otherAsset),
    ).toThrow(/settlement asset/i)
  })
})
