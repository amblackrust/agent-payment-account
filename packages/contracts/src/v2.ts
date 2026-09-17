import { z } from 'zod'

export const v2PaymentStatusSchema = z.enum([
  'CREATED',
  'ROUTING',
  'AWAITING_APPROVAL',
  'REJECTED_BY_POLICY',
  'REJECTED',
  'SUBMITTED',
  'RECONCILING',
  'CONFIRMED',
  'PROVED_NO_EFFECT',
  'REVIEW_REQUIRED',
  'CLOSED_UNRESOLVED',
  'FAILED',
  'EXPIRED',
])

export const policyDecisionSchema = z.enum(['ALLOW', 'REQUIRE_APPROVAL', 'DENY'])
export const approvalStateSchema = z.enum([
  'NOT_REQUIRED',
  'PENDING',
  'APPROVED',
  'REJECTED',
  'EXPIRED',
])

/** Exact decimal syntax; denomination-specific scale is enforced by the domain. */
export const exactAmountSchema = z
  .string()
  .regex(/^\d+(?:\.\d+)?$/u, 'amount must be a plain decimal string')

export const v2ErrorCodeSchema = z.enum([
  'VALIDATION_ERROR',
  'AUTHENTICATION_ERROR',
  'AUTHORIZATION_ERROR',
  'NOT_FOUND',
  'CONFLICT',
  'IDEMPOTENCY_CONFLICT',
  'INSUFFICIENT_FUNDS',
  'POLICY_DENIED',
  'APPROVAL_REQUIRED',
  'REVIEW_REQUIRED',
  'DEPENDENCY_UNAVAILABLE',
  'CUSTODY_UNAVAILABLE',
  'INVALID_STATE',
  'RATE_LIMITED',
  'EXTERNAL_RAIL_FAILURE',
  'INTERNAL_ERROR',
])

export const v2ErrorEnvelopeSchema = z
  .object({
    code: v2ErrorCodeSchema,
    message: z.string().min(1),
    request_id: z.string().min(1).optional(),
    details: z.record(z.string(), z.string()).optional(),
  })
  .strict()

export const v2PaymentCreateRequestSchema = z
  .object({
    recipient_id: z.string().min(1),
    amount: exactAmountSchema,
    denomination_id: z.string().min(1),
    description: z.string().min(1).max(500).optional(),
    external_reference: z.string().min(1).max(255).optional(),
    route_preference: z.string().min(1).max(64).optional(),
  })
  .strict()

export const v2PaymentResponseSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(['PAY', 'SEND', 'REFUND']),
    recipient_id: z.string().nullable(),
    amount: exactAmountSchema,
    denomination_id: z.string().min(1),
    status: v2PaymentStatusSchema,
    policy_decision: policyDecisionSchema,
    approval_state: approvalStateSchema,
    attempt_count: z.number().int().nonnegative(),
    reservation_status: z.enum(['NONE', 'HELD', 'RELEASED', 'CONSUMED']),
    created_at: z.string().min(1),
    updated_at: z.string().min(1),
    confirmed_at: z.string().nullable(),
    failure_code: z.string().nullable(),
    failure_message: z.string().nullable(),
    original_payment_id: z.string().nullable(),
  })
  .strict()

export const v2BalanceResponseSchema = z
  .object({
    account_id: z.string().min(1),
    denomination_id: z.string().min(1),
    settled: exactAmountSchema,
    reserved: exactAmountSchema,
    spendable: exactAmountSchema,
    observed_at: z.string().min(1),
    degraded: z.boolean(),
  })
  .strict()

export type V2PaymentStatus = z.infer<typeof v2PaymentStatusSchema>
export type V2ErrorCode = z.infer<typeof v2ErrorCodeSchema>
export type V2ErrorEnvelope = z.infer<typeof v2ErrorEnvelopeSchema>
export type V2PaymentCreateRequest = z.infer<typeof v2PaymentCreateRequestSchema>
export type V2PaymentResponse = z.infer<typeof v2PaymentResponseSchema>
export type V2BalanceResponse = z.infer<typeof v2BalanceResponseSchema>
