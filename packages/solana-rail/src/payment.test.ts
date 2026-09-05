import { describe, expect, it } from 'vitest'

import { createPositiveMoney } from '@agent-payment/core'
import { createSolanaPaymentPreparationRail, SOLANA_SPL_RAIL } from './payment.js'

describe('Solana payment preparation route', () => {
  it('registers SOLANA_SPL without exposing an execution function', async () => {
    const rail = createSolanaPaymentPreparationRail()
    const request = {
      operation: 'SEND' as const,
      currency: 'USD' as const,
      amount: createPositiveMoney('1.20'),
      payerAccountId: 'acct_payer',
      recipientId: 'rcpt_recipient',
      destination: {
        rail: SOLANA_SPL_RAIL,
        type: SOLANA_SPL_RAIL,
        reference: 'wallet-address',
      },
    }

    expect(rail.canRoute(request)).toBe(true)
    expect(rail.execute).toBeUndefined()
    expect((await rail.prepare(request)).payloadSafe).toContain('"amount":"1.20"')
  })
})
