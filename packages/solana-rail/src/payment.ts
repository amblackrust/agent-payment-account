import { formatMoney, type PaymentRail } from '@agent-payment/core'

export const SOLANA_SPL_RAIL = 'SOLANA_SPL'

/**
 * Registers the real settlement route without pretending that Task 04
 * execution exists. The payload is an auditable preparation record, not a
 * serialized Solana transaction and cannot produce a success status.
 */
export function createSolanaPaymentPreparationRail(): PaymentRail {
  return {
    name: SOLANA_SPL_RAIL,
    canRoute: (request) =>
      request.currency === 'USD' && request.destination.rail === SOLANA_SPL_RAIL,
    quote: async (request) => ({
      rail: SOLANA_SPL_RAIL,
      amount: request.amount,
    }),
    prepare: async (request) => ({
      rail: SOLANA_SPL_RAIL,
      payloadSafe: JSON.stringify({
        operation: request.operation,
        recipient_id: request.recipientId,
        amount: formatMoney(request.amount),
        currency: request.currency,
        destination_reference: request.destination.reference,
      }),
    }),
  }
}
