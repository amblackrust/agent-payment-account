import { z } from 'zod'
import {
  exactAmountSchema,
  v2AccountResponseSchema,
  v2ApprovalResponseSchema,
  v2BalanceResponseSchema,
  v2CredentialIssuanceRequestSchema,
  v2CredentialIssuanceResponseSchema,
  v2CredentialResponseSchema,
  v2CredentialScopeSchema,
  v2ErrorEnvelopeSchema,
  v2FundingDestinationResponseSchema,
  v2HistoryResponseSchema,
  v2PaymentCreateRequestSchema,
  v2PaymentListResponseSchema,
  v2PaymentResponseSchema,
  v2PaymentStatusSchema,
  v2PolicyResponseSchema,
  v2RecipientListResponseSchema,
  v2RecipientResponseSchema,
  v2ReceiveListResponseSchema,
  v2ReceiveResponseSchema,
} from './v2.js'

const identifier = z.string().min(1).max(64)
const nullableString = z.string().min(1).nullable()
const pageLimit = z.number().int().min(1).max(100)
const exactAmountInput = exactAmountSchema.max(256)
const receiveDestinationSchema = z
  .object({
    type: z.literal('external_transfer_target'),
    reference: z.string().min(1),
  })
  .strict()
const receiveSettlementSchema = z
  .object({
    owner: z.string().min(1),
    token_account: z.string().min(1),
    mint: z.string().min(1),
  })
  .strict()

export const v2AccountCreationRequestSchema = z
  .object({ name: z.string().min(1).max(120) })
  .strict()

export const v2AccountCreationResponseSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    status: z.literal('ACTIVE'),
    api_key: z.string().min(1),
    credential_id: z.string().min(1),
    receive: z
      .object({
        id: z.string().min(1),
        currency: z.literal('USD'),
        status: z.literal('OPEN'),
        destination: receiveDestinationSchema,
        settlement: receiveSettlementSchema,
      })
      .strict(),
  })
  .strict()

export const v2LifecycleRequestSchema = z
  .object({
    current_status: z.string().min(1),
    next_status: z.string().min(1),
    row_version: z.number().int().min(1),
    reason: z.string().min(1).max(500).optional(),
  })
  .strict()

export const v2LifecycleResponseSchema = z
  .object({
    id: z.string().min(1),
    status: z.enum(['PROVISIONING', 'ACTIVE', 'DISABLED', 'PROVISIONING_FAILED']),
    row_version: z.number().int().min(1),
    disabled_at: nullableString,
    disabled_reason: nullableString,
    provisioning_failure_code: nullableString,
  })
  .strict()

export const v2CredentialListResponseSchema = z
  .object({ credentials: z.array(v2CredentialResponseSchema) })
  .strict()

export const v2RotatedCredentialResponseSchema = z
  .object({
    credential_id: z.string().min(1),
    account_id: z.string().min(1),
    api_key: z.string().min(1),
    key_prefix: z.string().min(1),
    scopes: z.array(v2CredentialScopeSchema).min(1),
    expires_at: nullableString,
  })
  .strict()

export const v2PolicyRequestSchema = z
  .object({
    denomination_id: identifier,
    max_per_payment: exactAmountSchema.nullable().optional(),
    rolling_budget: exactAmountSchema.nullable().optional(),
    rolling_window_seconds: z.number().int().min(1).nullable().optional(),
    transaction_count_cap: z.number().int().min(1).nullable().optional(),
    approval_threshold: exactAmountSchema.nullable().optional(),
    version: z.number().int().min(1).optional(),
    rolling_budget_escalatable: z.boolean().optional(),
    transaction_count_escalatable: z.boolean().optional(),
  })
  .strict()

export const v2PolicyListResponseSchema = z
  .object({ policies: z.array(v2PolicyResponseSchema) })
  .strict()

export const v2ApprovalDecisionRequestSchema = z
  .object({
    action: z.enum(['APPROVE', 'REJECT', 'EXPIRE']),
    actor_id: z.string().min(1).max(255).optional(),
    comment: z.string().max(500).optional(),
    row_version: z.number().int().min(1),
  })
  .strict()

export const v2ApprovalListResponseSchema = z
  .object({ approvals: z.array(v2ApprovalResponseSchema) })
  .strict()

export const v2ApprovedDestinationCreateRequestSchema = z
  .object({
    fingerprint: z.string().min(1).max(64),
    rail: z.string().min(1).max(64),
    network: z.string().min(1).max(64),
    asset_reference: z.string().min(1).max(255),
    destination: z.string().min(1).max(255),
    actor_id: z.string().min(1).max(255).optional(),
    reason: z.string().max(500).optional(),
  })
  .strict()

export const v2ApprovedDestinationResponseSchema = z
  .object({
    id: z.string().min(1),
    account_id: z.string().min(1),
    fingerprint: z.string().min(1),
    rail: z.string().min(1),
    network: z.string().min(1),
    asset_reference: z.string().min(1),
    destination: z.string().min(1),
    status: z.enum(['ACTIVE', 'REVOKED']),
    actor_id: z.string().min(1),
    reason: nullableString,
    created_at: z.string().min(1),
    revoked_at: nullableString,
  })
  .strict()

export const v2ApprovedDestinationListResponseSchema = z
  .object({ approved_destinations: z.array(v2ApprovedDestinationResponseSchema) })
  .strict()

export const v2ApprovedDestinationRevokeRequestSchema = z
  .object({
    actor_id: z.string().min(1).max(255).optional(),
    reason: z.string().min(1).max(500),
  })
  .strict()

export const v2StatusResponseSchema = z.object({ status: z.string().min(1) }).strict()

const v2TimelineItemSchema = z
  .object({
    id: z.string().min(1),
    account_id: nullableString,
    resource_type: z.string().min(1),
    resource_id: z.string().min(1),
    event_type: z.string().min(1),
    actor_type: z.string().min(1),
    actor_id: nullableString,
    request_id: nullableString,
    correlation_id: nullableString,
    old_state: z.unknown(),
    new_state: z.unknown(),
    source: z.string().min(1),
    occurred_at: z.string().min(1),
    metadata: z.unknown(),
  })
  .strict()

export const v2TimelineResponseSchema = z
  .object({ items: z.array(v2TimelineItemSchema), next_cursor: nullableString })
  .strict()

export const v2WebhookCreateRequestSchema = z
  .object({
    endpoint: z.string().min(1).max(2048),
    event_types: z.array(z.string().min(1)).min(1),
    signing_key_ref: z.string().min(1).max(255),
    signing_key_version: z.number().int().min(1),
  })
  .strict()

export const v2WebhookSubscriptionResponseSchema = z
  .object({
    id: z.string().min(1),
    account_id: z.string().min(1),
    endpoint: z.string().min(1),
    event_types: z.array(z.string().min(1)).min(1),
    status: z.string().min(1),
    signing_key_ref: z.string().min(1),
    signing_key_version: z.number().int().min(1),
    created_at: z.string().min(1),
    archived_at: nullableString,
  })
  .strict()

export const v2WebhookSubscriptionListResponseSchema = z
  .object({ subscriptions: z.array(v2WebhookSubscriptionResponseSchema) })
  .strict()

export const v2ExceptionResponseSchema = z
  .object({
    id: z.string().min(1),
    account_id: nullableString,
    resource_type: z.string().min(1),
    resource_id: z.string().min(1),
    dedupe_key: z.string().min(1),
    status: z.string().min(1),
    severity: z.string().min(1),
    reason_code: z.string().min(1),
    details: z.unknown(),
    assigned_to: nullableString,
    row_version: z.number().int().min(1),
    created_at: z.string().min(1),
    updated_at: z.string().min(1),
    acknowledged_at: nullableString,
    resolved_at: nullableString,
  })
  .strict()

export const v2ExceptionListResponseSchema = z
  .object({ exceptions: z.array(v2ExceptionResponseSchema) })
  .strict()

export const v2PaymentRefundRequestSchema = z
  .object({
    amount: exactAmountInput,
    denomination_id: identifier,
    description: z.string().min(1).max(500).optional(),
    external_reference: z.string().min(1).max(255).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    route_preference: z.string().min(1).max(64).optional(),
  })
  .strict()

export const v2RecipientCreateRequestSchema = z
  .object({
    display_name: z.string().min(1).max(120),
    type: z.string().min(1).max(64),
    managed_account_id: identifier.optional(),
    destination: z
      .object({
        type: z.literal('SOLANA_SPL'),
        wallet_address: z.string().min(1).max(128),
      })
      .strict(),
  })
  .strict()

export const v2RecipientUpdateRequestSchema = z
  .object({
    display_name: z.string().min(1).max(120).optional(),
    type: z.string().min(1).max(64).optional(),
    managed_account_id: identifier.nullable().optional(),
    row_version: z.number().int().min(1),
    destination: z
      .object({
        id: identifier,
        type: z.literal('SOLANA_SPL'),
        wallet_address: z.string().min(1).max(128),
      })
      .strict()
      .optional(),
  })
  .strict()

export const v2RowVersionRequestSchema = z
  .object({ row_version: z.number().int().min(1) })
  .strict()

export const v2ReceiveCreateRequestSchema = z
  .object({
    amount: exactAmountInput.optional(),
    denomination_id: identifier,
    reference: z.string().min(1).max(255).optional(),
    expires_at: z.string().min(1).optional(),
  })
  .strict()

export const v2IdempotencyHeadersSchema = z
  .object({ 'idempotency-key': z.string().min(1).max(255) })
  .passthrough()

export const v2PageQuerySchema = z
  .object({ limit: pageLimit.optional(), cursor: z.string().min(1).optional() })
  .strict()

export const v2PaymentListQuerySchema = v2PageQuerySchema
  .extend({
    status: v2PaymentStatusSchema.optional(),
    outcome_state: z.string().min(1).max(32).optional(),
    recipient_id: identifier.optional(),
    denomination_id: identifier.optional(),
  })
  .strict()

export const v2BalanceQuerySchema = z.object({ denomination_id: identifier }).strict()

export const v2FundingQuerySchema = z
  .object({ route_id: identifier.optional() })
  .strict()

export const v2TimelineQuerySchema = v2PageQuerySchema
  .extend({
    resource_type: z.string().min(1).max(64).optional(),
    resource_id: identifier.optional(),
  })
  .strict()

export const v2ExceptionListQuerySchema = z
  .object({
    status: z.string().min(1).max(32).optional(),
    limit: pageLimit.optional(),
  })
  .strict()

export const v2AccountParamsSchema = z.object({ accountId: identifier }).strict()
export const v2CredentialParamsSchema = v2AccountParamsSchema
  .extend({ credentialId: identifier })
  .strict()
export const v2RecipientParamsSchema = z.object({ recipientId: identifier }).strict()
export const v2PaymentParamsSchema = z.object({ paymentId: identifier }).strict()
export const v2ReceiveParamsSchema = z.object({ receiveId: identifier }).strict()
export const v2PolicyParamsSchema = z.object({ policyId: identifier }).strict()
export const v2ApprovalParamsSchema = v2AccountParamsSchema
  .extend({ approvalId: identifier })
  .strict()
export const v2ApprovedDestinationParamsSchema = v2AccountParamsSchema
  .extend({ destinationId: identifier })
  .strict()
export const v2WebhookParamsSchema = z.object({ webhookId: identifier }).strict()
export const v2ExceptionParamsSchema = z.object({ exceptionId: identifier }).strict()

export const v2OperatorActionRequestSchema = z
  .object({
    operator_id: z.string().min(1).max(255).optional(),
    row_version: z.number().int().min(1),
  })
  .strict()

export const v2OperatorResolutionRequestSchema = v2OperatorActionRequestSchema
  .extend({ evidence_id: identifier.optional() })
  .strict()

export const v2AccountResponseJsonSchema = z.toJSONSchema(v2AccountResponseSchema, {
  target: 'draft-07',
})
export const v2AccountCreationRequestJsonSchema = z.toJSONSchema(
  v2AccountCreationRequestSchema,
  { target: 'draft-07' },
)
export const v2AccountCreationResponseJsonSchema = z.toJSONSchema(
  v2AccountCreationResponseSchema,
  { target: 'draft-07' },
)
export const v2LifecycleRequestJsonSchema = z.toJSONSchema(v2LifecycleRequestSchema, {
  target: 'draft-07',
})
export const v2LifecycleResponseJsonSchema = z.toJSONSchema(v2LifecycleResponseSchema, {
  target: 'draft-07',
})
export const v2CredentialListResponseJsonSchema = z.toJSONSchema(
  v2CredentialListResponseSchema,
  { target: 'draft-07' },
)
export const v2CredentialIssuanceRequestJsonSchema = z.toJSONSchema(
  v2CredentialIssuanceRequestSchema,
  { target: 'draft-07' },
)
export const v2CredentialIssuanceResponseJsonSchema = z.toJSONSchema(
  v2CredentialIssuanceResponseSchema,
  { target: 'draft-07' },
)
export const v2RotatedCredentialResponseJsonSchema = z.toJSONSchema(
  v2RotatedCredentialResponseSchema,
  { target: 'draft-07' },
)
export const v2PolicyRequestJsonSchema = z.toJSONSchema(v2PolicyRequestSchema, {
  target: 'draft-07',
})
export const v2PolicyListResponseJsonSchema = z.toJSONSchema(
  v2PolicyListResponseSchema,
  { target: 'draft-07' },
)
export const v2PolicyResponseJsonSchema = z.toJSONSchema(v2PolicyResponseSchema, {
  target: 'draft-07',
})
export const v2ApprovalDecisionRequestJsonSchema = z.toJSONSchema(
  v2ApprovalDecisionRequestSchema,
  { target: 'draft-07' },
)
export const v2ApprovalListResponseJsonSchema = z.toJSONSchema(
  v2ApprovalListResponseSchema,
  { target: 'draft-07' },
)
export const v2ApprovalResponseJsonSchema = z.toJSONSchema(v2ApprovalResponseSchema, {
  target: 'draft-07',
})
export const v2ApprovedDestinationCreateRequestJsonSchema = z.toJSONSchema(
  v2ApprovedDestinationCreateRequestSchema,
  { target: 'draft-07' },
)
export const v2ApprovedDestinationRevokeRequestJsonSchema = z.toJSONSchema(
  v2ApprovedDestinationRevokeRequestSchema,
  { target: 'draft-07' },
)
export const v2ApprovedDestinationListResponseJsonSchema = z.toJSONSchema(
  v2ApprovedDestinationListResponseSchema,
  { target: 'draft-07' },
)
export const v2ApprovedDestinationResponseJsonSchema = z.toJSONSchema(
  v2ApprovedDestinationResponseSchema,
  { target: 'draft-07' },
)
export const v2StatusResponseJsonSchema = z.toJSONSchema(v2StatusResponseSchema, {
  target: 'draft-07',
})
export const v2TimelineResponseJsonSchema = z.toJSONSchema(v2TimelineResponseSchema, {
  target: 'draft-07',
})
export const v2WebhookCreateRequestJsonSchema = z.toJSONSchema(
  v2WebhookCreateRequestSchema,
  { target: 'draft-07' },
)
export const v2WebhookSubscriptionListResponseJsonSchema = z.toJSONSchema(
  v2WebhookSubscriptionListResponseSchema,
  { target: 'draft-07' },
)
export const v2WebhookSubscriptionResponseJsonSchema = z.toJSONSchema(
  v2WebhookSubscriptionResponseSchema,
  { target: 'draft-07' },
)
export const v2ExceptionListResponseJsonSchema = z.toJSONSchema(
  v2ExceptionListResponseSchema,
  { target: 'draft-07' },
)
export const v2ExceptionResponseJsonSchema = z.toJSONSchema(v2ExceptionResponseSchema, {
  target: 'draft-07',
})
export const v2ErrorEnvelopeJsonSchema = z.toJSONSchema(v2ErrorEnvelopeSchema, {
  target: 'draft-07',
})
export const v2PaymentCreateRequestJsonSchema = z.toJSONSchema(
  v2PaymentCreateRequestSchema,
  { target: 'draft-07' },
)
export const v2PaymentRefundRequestJsonSchema = z.toJSONSchema(
  v2PaymentRefundRequestSchema,
  { target: 'draft-07' },
)
export const v2PaymentListResponseJsonSchema = z.toJSONSchema(
  v2PaymentListResponseSchema,
  { target: 'draft-07' },
)
export const v2PaymentResponseJsonSchema = z.toJSONSchema(v2PaymentResponseSchema, {
  target: 'draft-07',
})
export const v2RecipientCreateRequestJsonSchema = z.toJSONSchema(
  v2RecipientCreateRequestSchema,
  { target: 'draft-07' },
)
export const v2RecipientUpdateRequestJsonSchema = z.toJSONSchema(
  v2RecipientUpdateRequestSchema,
  { target: 'draft-07' },
)
export const v2RowVersionRequestJsonSchema = z.toJSONSchema(v2RowVersionRequestSchema, {
  target: 'draft-07',
})
export const v2RecipientListResponseJsonSchema = z.toJSONSchema(
  v2RecipientListResponseSchema,
  { target: 'draft-07' },
)
export const v2RecipientResponseJsonSchema = z.toJSONSchema(v2RecipientResponseSchema, {
  target: 'draft-07',
})
export const v2ReceiveCreateRequestJsonSchema = z.toJSONSchema(
  v2ReceiveCreateRequestSchema,
  { target: 'draft-07' },
)
export const v2ReceiveListResponseJsonSchema = z.toJSONSchema(
  v2ReceiveListResponseSchema,
  { target: 'draft-07' },
)
export const v2ReceiveResponseJsonSchema = z.toJSONSchema(v2ReceiveResponseSchema, {
  target: 'draft-07',
})
export const v2BalanceResponseJsonSchema = z.toJSONSchema(v2BalanceResponseSchema, {
  target: 'draft-07',
})
export const v2FundingDestinationResponseJsonSchema = z.toJSONSchema(
  v2FundingDestinationResponseSchema,
  { target: 'draft-07' },
)
export const v2HistoryResponseJsonSchema = z.toJSONSchema(v2HistoryResponseSchema, {
  target: 'draft-07',
})
export const v2IdempotencyHeadersJsonSchema = z.toJSONSchema(
  v2IdempotencyHeadersSchema,
  { target: 'draft-07' },
)
export const v2PageQueryJsonSchema = z.toJSONSchema(v2PageQuerySchema, {
  target: 'draft-07',
})
export const v2PaymentListQueryJsonSchema = z.toJSONSchema(v2PaymentListQuerySchema, {
  target: 'draft-07',
})
export const v2BalanceQueryJsonSchema = z.toJSONSchema(v2BalanceQuerySchema, {
  target: 'draft-07',
})
export const v2FundingQueryJsonSchema = z.toJSONSchema(v2FundingQuerySchema, {
  target: 'draft-07',
})
export const v2TimelineQueryJsonSchema = z.toJSONSchema(v2TimelineQuerySchema, {
  target: 'draft-07',
})
export const v2ExceptionListQueryJsonSchema = z.toJSONSchema(
  v2ExceptionListQuerySchema,
  { target: 'draft-07' },
)
export const v2AccountParamsJsonSchema = z.toJSONSchema(v2AccountParamsSchema, {
  target: 'draft-07',
})
export const v2CredentialParamsJsonSchema = z.toJSONSchema(v2CredentialParamsSchema, {
  target: 'draft-07',
})
export const v2RecipientParamsJsonSchema = z.toJSONSchema(v2RecipientParamsSchema, {
  target: 'draft-07',
})
export const v2PaymentParamsJsonSchema = z.toJSONSchema(v2PaymentParamsSchema, {
  target: 'draft-07',
})
export const v2ReceiveParamsJsonSchema = z.toJSONSchema(v2ReceiveParamsSchema, {
  target: 'draft-07',
})
export const v2PolicyParamsJsonSchema = z.toJSONSchema(v2PolicyParamsSchema, {
  target: 'draft-07',
})
export const v2ApprovalParamsJsonSchema = z.toJSONSchema(v2ApprovalParamsSchema, {
  target: 'draft-07',
})
export const v2ApprovedDestinationParamsJsonSchema = z.toJSONSchema(
  v2ApprovedDestinationParamsSchema,
  { target: 'draft-07' },
)
export const v2WebhookParamsJsonSchema = z.toJSONSchema(v2WebhookParamsSchema, {
  target: 'draft-07',
})
export const v2ExceptionParamsJsonSchema = z.toJSONSchema(v2ExceptionParamsSchema, {
  target: 'draft-07',
})

export type V2AccountCreationRequest = z.infer<typeof v2AccountCreationRequestSchema>
export type V2AccountCreationResponse = z.infer<typeof v2AccountCreationResponseSchema>
export type V2LifecycleRequest = z.infer<typeof v2LifecycleRequestSchema>
export type V2LifecycleResponse = z.infer<typeof v2LifecycleResponseSchema>
export type V2CredentialListResponse = z.infer<typeof v2CredentialListResponseSchema>
export type V2RotatedCredentialResponse = z.infer<
  typeof v2RotatedCredentialResponseSchema
>
export type V2PolicyRequest = z.infer<typeof v2PolicyRequestSchema>
export type V2PolicyListResponse = z.infer<typeof v2PolicyListResponseSchema>
export type V2ApprovalDecisionRequest = z.infer<typeof v2ApprovalDecisionRequestSchema>
export type V2ApprovalListResponse = z.infer<typeof v2ApprovalListResponseSchema>
export type V2ApprovedDestinationCreateRequest = z.infer<
  typeof v2ApprovedDestinationCreateRequestSchema
>
export type V2ApprovedDestinationResponse = z.infer<
  typeof v2ApprovedDestinationResponseSchema
>
export type V2ApprovedDestinationListResponse = z.infer<
  typeof v2ApprovedDestinationListResponseSchema
>
export type V2WebhookCreateRequest = z.infer<typeof v2WebhookCreateRequestSchema>
export type V2WebhookSubscriptionResponse = z.infer<
  typeof v2WebhookSubscriptionResponseSchema
>
export type V2WebhookSubscriptionListResponse = z.infer<
  typeof v2WebhookSubscriptionListResponseSchema
>
export type V2ExceptionResponse = z.infer<typeof v2ExceptionResponseSchema>
export type V2ExceptionListResponse = z.infer<typeof v2ExceptionListResponseSchema>
export type V2PaymentRefundRequest = z.infer<typeof v2PaymentRefundRequestSchema>
export type V2RecipientCreateRequest = z.infer<typeof v2RecipientCreateRequestSchema>
export type V2RecipientUpdateRequest = z.infer<typeof v2RecipientUpdateRequestSchema>
export type V2ReceiveCreateRequest = z.infer<typeof v2ReceiveCreateRequestSchema>
