import { describe, expect, it } from 'vitest'

import {
  createPositiveMoney,
  selectPaymentRail,
  UnsupportedRailError,
  type PaymentRail,
  type RailPaymentRequest,
} from './index.js'

function request(rail: string): RailPaymentRequest {
  return {
    operation: 'SEND',
    currency: 'USD',
    amount: createPositiveMoney('1.00'),
    payerAccountId: 'acct_payer',
    recipientId: 'rcpt_recipient',
    destination: { rail, type: rail, reference: 'destination' },
  }
}

function rail(name: string, canRoute: boolean): PaymentRail {
  return {
    name,
    canRoute: () => canRoute,
    quote: async (paymentRequest) => ({ rail: name, amount: paymentRequest.amount }),
    prepare: async () => ({ rail: name }),
    execute: async () => ({ status: 'CONFIRMED' }),
    getStatus: async () => ({ status: 'CONFIRMED' }),
  }
}

describe('payment rail contracts', () => {
  it('selects a deterministic rail independent of registration order', () => {
    const selected = selectPaymentRail(request('SOLANA_SPL'), [
      rail('z-rail', true),
      rail('a-rail', true),
    ])

    expect(selected.name).toBe('a-rail')
  })

  it('rejects a destination without a compatible rail', () => {
    expect(() =>
      selectPaymentRail(request('BANK'), [rail('SOLANA_SPL', false)]),
    ).toThrow(UnsupportedRailError)
  })
})
