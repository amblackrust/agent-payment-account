import { describe, expect, it } from 'vitest'
import {
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from '@x402/core/http'
import type { PaymentRequired, SettleResponse } from '@x402/core/types'
import {
  assertSuccessfulSettlement,
  hashRequirement,
  parsePaymentRequiredResponse,
  parsePaymentResourceResponse,
  serializeProtocolMetadata,
  X402_PAYMENT_RESPONSE_HEADER,
  X402_RESOURCE_URL,
  X402_SOLANA_MAINNET_NETWORK,
} from './x402-protocol.js'

const asset = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const payTo = 'Gzehfseq1k9AcHFSoV7qHmDGQx92nLMw78XXdqVWQQWa'
const feePayer = 'Hc3sdEAsCGQcpgfivywog9uwtk8gUBUZgsxdME1EJy88'

function paymentRequired(overrides: Partial<PaymentRequired> = {}): PaymentRequired {
  return {
    x402Version: 2,
    resource: { url: X402_RESOURCE_URL },
    accepts: [
      {
        scheme: 'exact',
        network: X402_SOLANA_MAINNET_NETWORK,
        amount: '1000',
        asset,
        payTo,
        maxTimeoutSeconds: 300,
        extra: { feePayer },
      },
    ],
    ...overrides,
  }
}

function responseWithPaymentRequired(value: PaymentRequired): Response {
  return new Response(null, {
    status: 402,
    headers: {
      'PAYMENT-REQUIRED': encodePaymentRequiredHeader(value),
    },
  })
}

describe('x402 protocol adapter', () => {
  it('selects the current Solana mainnet exact requirement from the 402 response', () => {
    const parsed = parsePaymentRequiredResponse(
      responseWithPaymentRequired(paymentRequired()),
      X402_RESOURCE_URL,
      asset,
    )
    expect(parsed.requirement.amount).toBe('1000')
    expect(parsed.requirement.payTo).toBe(payTo)
    expect(parsed.requirement.extra.feePayer).toBe(feePayer)
    expect(hashRequirement(parsed.requirement)).toMatch(/^[0-9a-f]{64}$/u)
  })

  it('rejects a provider response without the required Solana mainnet option', () => {
    const value = paymentRequired({
      accepts: [
        {
          scheme: 'exact',
          network: 'solana:devnet',
          amount: '1000',
          asset,
          payTo,
          maxTimeoutSeconds: 300,
          extra: { feePayer },
        },
      ],
    })
    expect(() =>
      parsePaymentRequiredResponse(
        responseWithPaymentRequired(value),
        X402_RESOURCE_URL,
        asset,
      ),
    ).toThrow(/compatible Solana mainnet/i)
  })

  it('rejects a provider response with more than one compatible payment option', () => {
    const value = paymentRequired({
      accepts: [
        ...paymentRequired().accepts,
        {
          scheme: 'exact',
          network: X402_SOLANA_MAINNET_NETWORK,
          amount: '2000',
          asset,
          payTo,
          maxTimeoutSeconds: 300,
          extra: { feePayer },
        },
      ],
    })
    expect(() =>
      parsePaymentRequiredResponse(
        responseWithPaymentRequired(value),
        X402_RESOURCE_URL,
        asset,
      ),
    ).toThrow(/multiple compatible/i)
  })

  it('parses an authoritative payment response without treating HTTP body status as settlement', () => {
    const settlement: SettleResponse = {
      success: true,
      transaction: '5Z4W9Q8Y7X6V5U4T3S2R1Q9P8N7M6L5K4J3H2G1F0E',
      network: X402_SOLANA_MAINNET_NETWORK,
      payer: payTo,
    }
    const response = new Response(JSON.stringify({ price: 100_000 }), {
      status: 200,
      headers: {
        [X402_PAYMENT_RESPONSE_HEADER]: encodePaymentResponseHeader(settlement),
        'x-request-id': 'provider-request-1',
      },
    })
    const parsed = parsePaymentResourceResponse(response, { price: 100_000 })
    assertSuccessfulSettlement(parsed.settlement)
    expect(parsed.status).toBe(200)
    expect(parsed.requestId).toBe('provider-request-1')
  })

  it('bounds evidence metadata and rejects non-JSON values', () => {
    expect(() => serializeProtocolMetadata(undefined)).toThrow(/serializable/i)
    expect(() => serializeProtocolMetadata('x'.repeat(20_000))).toThrow(/size limit/i)
  })
})
