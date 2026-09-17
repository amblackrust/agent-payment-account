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
    payment_id: z.string().min(1).optional(),
    payment_status: v2PaymentStatusSchema.optional(),
    reason_codes: z.array(z.string()).optional(),
  })
  .strict()

export const v2PaymentCreateRequestSchema = z
  .object({
    kind: z.enum(['PAY', 'SEND']).default('PAY'),
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
    denomination_symbol: z.string().min(1),
    status: v2PaymentStatusSchema,
    policy_decision: policyDecisionSchema,
    policy_reason_codes: z.array(z.string()),
    approval_state: approvalStateSchema,
    attempt_count: z.number().int().nonnegative(),
    reservation_status: z.enum(['NONE', 'HELD', 'RELEASED', 'CONSUMED']),
    route_id: z.string().nullable(),
    route_selection_reason: z.string().nullable(),
    settlement_asset_id: z.string().nullable(),
    execution_state: z.string().min(1),
    settlement_state: z.string().min(1),
    outcome_state: z.string().min(1),
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

export const v2PaymentListResponseSchema = z
  .object({
    payments: z.array(v2PaymentResponseSchema),
    next_cursor: z.string().nullable(),
  })
  .strict()

export const v2AccountResponseSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    status: z.enum(['PROVISIONING', 'ACTIVE', 'DISABLED', 'PROVISIONING_FAILED']),
    solana_public_key: z.string().min(1),
    workspace_id: z.string().nullable(),
    runtime_version: z.string().nullable(),
    provisioning_failure_code: z.string().nullable(),
    disabled_at: z.string().nullable(),
    disabled_reason: z.string().nullable(),
    row_version: z.number().int().positive(),
    created_at: z.string().min(1),
    updated_at: z.string().min(1),
  })
  .strict()

export const v2CredentialResponseSchema = z
  .object({
    id: z.string().min(1),
    account_id: z.string().min(1),
    status: z.enum(['ACTIVE', 'EXPIRED', 'REVOKED', 'ROTATING']),
    scopes: z.array(z.string()),
    expires_at: z.string().nullable(),
    rotated_from_id: z.string().nullable(),
    row_version: z.number().int().positive(),
    created_at: z.string().min(1),
    revoked_at: z.string().nullable(),
  })
  .strict()

export const v2PolicyResponseSchema = z
  .object({
    id: z.string().min(1),
    account_id: z.string().min(1),
    version: z.number().int().positive(),
    status: z.enum(['DRAFT', 'ACTIVE', 'RETIRED']),
    denomination_id: z.string().min(1),
    max_per_payment: exactAmountSchema.nullable(),
    rolling_budget: exactAmountSchema.nullable(),
    rolling_window_seconds: z.number().int().positive().nullable(),
    transaction_count_cap: z.number().int().positive().nullable(),
    approval_threshold: exactAmountSchema.nullable(),
    rolling_budget_escalatable: z.boolean(),
    transaction_count_escalatable: z.boolean(),
    created_at: z.string().min(1),
    activated_at: z.string().nullable(),
    retired_at: z.string().nullable(),
  })
  .strict()

export const v2ApprovalResponseSchema = z
  .object({
    id: z.string().min(1),
    payment_id: z.string().min(1),
    account_id: z.string().min(1),
    status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED']),
    expires_at: z.string().min(1),
    actor_id: z.string().nullable(),
    comment: z.string().nullable(),
    row_version: z.number().int().positive(),
    created_at: z.string().min(1),
    decided_at: z.string().nullable(),
  })
  .strict()

export const v2FundingDestinationResponseSchema = z
  .object({
    id: z.string().min(1),
    account_id: z.string().min(1),
    route_id: z.string().min(1),
    network: z.string().min(1),
    asset_id: z.string().min(1),
    destination: z.string().min(1),
    readiness: z.enum(['READY', 'PENDING', 'DEGRADED', 'UNAVAILABLE']),
    sender_constraints: z.record(z.string(), z.unknown()),
    last_validated_at: z.string().nullable(),
    last_failure_code: z.string().nullable(),
  })
  .strict()

export const v2HistoryItemSchema = z
  .object({
    id: z.string().min(1),
    direction: z.enum(['INCOMING', 'OUTGOING']),
    kind: z.string().min(1),
    status: z.string().min(1),
    amount: z.string().min(1),
    denomination_id: z.string().nullable(),
    currency: z.string().min(1),
    recipient_id: z.string().nullable(),
    external_id: z.string().nullable(),
    occurred_at: z.string().min(1),
  })
  .strict()

export const v2HistoryResponseSchema = z
  .object({
    items: z.array(v2HistoryItemSchema),
    next_cursor: z.string().nullable(),
  })
  .strict()

export const v2RecipientDestinationSchema = z
  .object({
    id: z.string().min(1),
    rail: z.string().min(1),
    type: z.string().min(1),
    wallet_address: z.string().min(1),
  })
  .strict()

export const v2RecipientResponseSchema = z
  .object({
    id: z.string().min(1),
    display_name: z.string().min(1),
    type: z.string().min(1),
    managed_account_id: z.string().nullable(),
    destinations: z.array(v2RecipientDestinationSchema),
    created_at: z.string().min(1),
    updated_at: z.string().min(1),
  })
  .strict()

export const v2RecipientListResponseSchema = z
  .object({
    recipients: z.array(v2RecipientResponseSchema),
    next_cursor: z.string().nullable(),
  })
  .strict()

export const v2ReceiveResponseSchema = z
  .object({
    id: z.string().min(1),
    account_id: z.string().min(1),
    amount: exactAmountSchema.nullable(),
    denomination_id: z.string().nullable(),
    currency: z.string().min(1),
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

export const v2ReceiveListResponseSchema = z
  .object({
    receive_requests: z.array(v2ReceiveResponseSchema),
    next_cursor: z.string().nullable(),
  })
  .strict()

export type V2PaymentStatus = z.infer<typeof v2PaymentStatusSchema>
export type V2ErrorCode = z.infer<typeof v2ErrorCodeSchema>
export type V2ErrorEnvelope = z.infer<typeof v2ErrorEnvelopeSchema>
export type V2PaymentCreateRequest = z.infer<typeof v2PaymentCreateRequestSchema>
export type V2PaymentResponse = z.infer<typeof v2PaymentResponseSchema>
export type V2BalanceResponse = z.infer<typeof v2BalanceResponseSchema>
export type V2PaymentListResponse = z.infer<typeof v2PaymentListResponseSchema>
export type V2AccountResponse = z.infer<typeof v2AccountResponseSchema>
export type V2CredentialResponse = z.infer<typeof v2CredentialResponseSchema>
export type V2PolicyResponse = z.infer<typeof v2PolicyResponseSchema>
export type V2ApprovalResponse = z.infer<typeof v2ApprovalResponseSchema>
export type V2FundingDestinationResponse = z.infer<
  typeof v2FundingDestinationResponseSchema
>
export type V2HistoryItem = z.infer<typeof v2HistoryItemSchema>
export type V2HistoryResponse = z.infer<typeof v2HistoryResponseSchema>
export type V2RecipientDestination = z.infer<typeof v2RecipientDestinationSchema>
export type V2RecipientResponse = z.infer<typeof v2RecipientResponseSchema>
export type V2RecipientListResponse = z.infer<typeof v2RecipientListResponseSchema>
export type V2ReceiveResponse = z.infer<typeof v2ReceiveResponseSchema>
export type V2ReceiveListResponse = z.infer<typeof v2ReceiveListResponseSchema>
