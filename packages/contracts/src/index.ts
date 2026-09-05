import { z } from 'zod'

const moneyString = z.string().regex(/^(0|[1-9][0-9]*)\.[0-9]{2}$/u)
const currency = z.literal('USD')
const paymentStatus = z.enum([
  'CREATED',
  'ROUTING',
  'SUBMITTED',
  'RECONCILING',
  'CONFIRMED',
  'FAILED',
])
const paymentKind = z.enum(['PAY', 'SEND', 'REFUND'])
const transactionKind = z.enum(['PAY', 'SEND', 'REFUND', 'RECEIVE'])
const transactionDirection = z.enum(['INCOMING', 'OUTGOING'])

export const counterpartyResponseSchema = z
  .object({
    recipient_id: z.string().nullable(),
    display_name: z.string().nullable(),
    account_id: z.string().nullable(),
    address: z.string().nullable(),
  })
  .strict()

export const balanceResponseSchema = z
  .object({
    currency,
    settled: moneyString,
    pending_outgoing: moneyString,
    available: moneyString,
  })
  .strict()

export const paymentResponseSchema = z
  .object({
    id: z.string().min(1),
    recipient_id: z.string().nullable(),
    kind: paymentKind,
    amount: moneyString,
    currency,
    status: paymentStatus,
    description: z.string().nullable(),
    external_reference: z.string().nullable(),
    route: z.string().nullable(),
    created_at: z.string().min(1),
    updated_at: z.string().min(1),
    confirmed_at: z.string().nullable(),
    failed_at: z.string().nullable(),
    failure_code: z.string().nullable(),
    failure_message: z.string().nullable(),
    original_payment_id: z.string().nullable(),
  })
  .strict()

export const receiveResponseSchema = z
  .object({
    id: z.string().min(1),
    account_id: z.string().min(1),
    amount: moneyString.nullable(),
    currency,
    reference: z.string().min(1),
    status: z.enum(['OPEN', 'PAID', 'EXPIRED', 'CANCELLED']),
    created_at: z.string().min(1),
    expires_at: z.string().nullable(),
    paid_at: z.string().nullable(),
    destination: z
      .object({
        type: z.literal('external_transfer_target'),
        reference: z.string().min(1),
      })
      .strict(),
    settlement: z
      .object({
        owner: z.string().min(1),
        token_account: z.string().min(1),
        mint: z.string().min(1),
      })
      .strict(),
  })
  .strict()

export const transactionResponseSchema = z
  .object({
    id: z.string().min(1),
    direction: transactionDirection,
    kind: transactionKind,
    amount: moneyString,
    currency,
    status: paymentStatus,
    counterparty: counterpartyResponseSchema,
    created_at: z.string().min(1),
    updated_at: z.string().min(1),
    confirmed_at: z.string().nullable(),
    signature: z.string().nullable(),
  })
  .strict()

export const transactionListResponseSchema = z
  .object({
    transactions: z.array(transactionResponseSchema),
    next_cursor: z.string().nullable(),
  })
  .strict()

export const apiErrorResponseSchema = z
  .object({
    statusCode: z.number().int().optional(),
    error: z.string().optional(),
    message: z.string().optional(),
    details: z.record(z.string(), z.string()).optional(),
  })
  .passthrough()

export const payRequestSchema = z
  .object({
    recipient_id: z.string().min(1),
    amount: z.string().min(1),
    currency,
    description: z.string().min(1).max(500).optional(),
    external_reference: z.string().min(1).max(255).optional(),
  })
  .strict()

export const sendRequestSchema = payRequestSchema

export const receiveRequestSchema = z
  .object({
    currency,
    amount: z.string().min(1).optional(),
    reference: z.string().min(1).max(255).optional(),
    expires_at: z.string().min(1).optional(),
  })
  .strict()

export const refundRequestSchema = z
  .object({
    original_payment_id: z.string().min(1),
    amount: z.string().min(1),
    currency,
  })
  .strict()

export type BalanceResponse = z.infer<typeof balanceResponseSchema>
export type PaymentResponse = z.infer<typeof paymentResponseSchema>
export type ReceiveResponse = z.infer<typeof receiveResponseSchema>
export type CounterpartyResponse = z.infer<typeof counterpartyResponseSchema>
export type TransactionResponse = z.infer<typeof transactionResponseSchema>
export type TransactionListResponse = z.infer<typeof transactionListResponseSchema>
export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>
export type PayRequest = z.infer<typeof payRequestSchema>
export type SendRequest = z.infer<typeof sendRequestSchema>
export type ReceiveRequest = z.infer<typeof receiveRequestSchema>
export type RefundRequest = z.infer<typeof refundRequestSchema>
