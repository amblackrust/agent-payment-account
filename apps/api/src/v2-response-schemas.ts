import {
  v2CredentialIssuanceRequestJsonSchema,
  v2CredentialIssuanceResponseJsonSchema,
} from '@agent-payment/contracts'

const exactAmountSchema = {
  type: 'string',
  pattern: '^\\d+(?:\\.\\d+)?$',
} as const

const nullableStringSchema = { type: ['string', 'null'] } as const

const receiveDestinationSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    type: { type: 'string', const: 'external_transfer_target' },
    reference: { type: 'string', minLength: 1 },
  },
  required: ['type', 'reference'],
} as const

const receiveSettlementSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    owner: { type: 'string', minLength: 1 },
    token_account: { type: 'string', minLength: 1 },
    mint: { type: 'string', minLength: 1 },
  },
  required: ['owner', 'token_account', 'mint'],
} as const

export const v2AccountResponseSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', minLength: 1 },
    name: { type: 'string', minLength: 1 },
    status: {
      type: 'string',
      enum: ['PROVISIONING', 'ACTIVE', 'DISABLED', 'PROVISIONING_FAILED'],
    },
    solana_public_key: { type: 'string', minLength: 1 },
    workspace_id: nullableStringSchema,
    runtime_version: nullableStringSchema,
    provisioning_failure_code: nullableStringSchema,
    disabled_at: nullableStringSchema,
    disabled_reason: nullableStringSchema,
    row_version: { type: 'integer', minimum: 1 },
    created_at: { type: 'string', minLength: 1 },
    updated_at: { type: 'string', minLength: 1 },
  },
  required: [
    'id',
    'name',
    'status',
    'solana_public_key',
    'workspace_id',
    'runtime_version',
    'provisioning_failure_code',
    'disabled_at',
    'disabled_reason',
    'row_version',
    'created_at',
    'updated_at',
  ],
} as const

export const v2AccountCreationResponseSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', minLength: 1 },
    name: { type: 'string', minLength: 1 },
    status: { type: 'string', const: 'ACTIVE' },
    api_key: { type: 'string', minLength: 1 },
    credential_id: { type: 'string', minLength: 1 },
    receive: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', minLength: 1 },
        currency: { type: 'string', const: 'USD' },
        status: { type: 'string', const: 'OPEN' },
        destination: receiveDestinationSchema,
        settlement: receiveSettlementSchema,
      },
      required: ['id', 'currency', 'status', 'destination', 'settlement'],
    },
  },
  required: ['id', 'name', 'status', 'api_key', 'credential_id', 'receive'],
} as const

export const v2LifecycleResponseSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', minLength: 1 },
    status: {
      type: 'string',
      enum: ['PROVISIONING', 'ACTIVE', 'DISABLED', 'PROVISIONING_FAILED'],
    },
    row_version: { type: 'integer', minimum: 1 },
    disabled_at: nullableStringSchema,
    disabled_reason: nullableStringSchema,
    provisioning_failure_code: nullableStringSchema,
  },
  required: [
    'id',
    'status',
    'row_version',
    'disabled_at',
    'disabled_reason',
    'provisioning_failure_code',
  ],
} as const

export const v2CredentialResponseSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', minLength: 1 },
    account_id: { type: 'string', minLength: 1 },
    status: { type: 'string', enum: ['ACTIVE', 'EXPIRED', 'REVOKED', 'ROTATING'] },
    scopes: { type: 'array', items: { type: 'string', minLength: 1 } },
    expires_at: nullableStringSchema,
    rotated_from_id: nullableStringSchema,
    row_version: { type: 'integer', minimum: 1 },
    created_at: { type: 'string', minLength: 1 },
    revoked_at: nullableStringSchema,
  },
  required: [
    'id',
    'account_id',
    'status',
    'scopes',
    'expires_at',
    'rotated_from_id',
    'row_version',
    'created_at',
    'revoked_at',
  ],
} as const

export const v2CredentialListResponseSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    credentials: { type: 'array', items: v2CredentialResponseSchema },
  },
  required: ['credentials'],
} as const

export const v2RotatedCredentialResponseSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    credential_id: { type: 'string', minLength: 1 },
    account_id: { type: 'string', minLength: 1 },
    api_key: { type: 'string', minLength: 1 },
    key_prefix: { type: 'string', minLength: 1 },
    scopes: { type: 'array', items: { type: 'string', minLength: 1 } },
    expires_at: nullableStringSchema,
  },
  required: [
    'credential_id',
    'account_id',
    'api_key',
    'key_prefix',
    'scopes',
    'expires_at',
  ],
} as const

export const v2CredentialIssuanceResponseSchema = v2CredentialIssuanceResponseJsonSchema
export const v2CredentialIssuanceRequestSchema = v2CredentialIssuanceRequestJsonSchema

export const v2PolicyResponseSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', minLength: 1 },
    account_id: { type: 'string', minLength: 1 },
    version: { type: 'integer', minimum: 1 },
    status: { type: 'string', enum: ['DRAFT', 'ACTIVE', 'RETIRED'] },
    denomination_id: { type: 'string', minLength: 1 },
    max_per_payment: { type: ['string', 'null'], pattern: '^\\d+(?:\\.\\d+)?$' },
    rolling_budget: { type: ['string', 'null'], pattern: '^\\d+(?:\\.\\d+)?$' },
    rolling_window_seconds: { type: ['integer', 'null'], minimum: 1 },
    transaction_count_cap: { type: ['integer', 'null'], minimum: 1 },
    approval_threshold: { type: ['string', 'null'], pattern: '^\\d+(?:\\.\\d+)?$' },
    rolling_budget_escalatable: { type: 'boolean' },
    transaction_count_escalatable: { type: 'boolean' },
    created_at: { type: 'string', minLength: 1 },
    activated_at: nullableStringSchema,
    retired_at: nullableStringSchema,
  },
  required: [
    'id',
    'account_id',
    'version',
    'status',
    'denomination_id',
    'max_per_payment',
    'rolling_budget',
    'rolling_window_seconds',
    'transaction_count_cap',
    'approval_threshold',
    'rolling_budget_escalatable',
    'transaction_count_escalatable',
    'created_at',
    'activated_at',
    'retired_at',
  ],
} as const

export const v2PolicyListResponseSchema = {
  type: 'object',
  additionalProperties: false,
  properties: { policies: { type: 'array', items: v2PolicyResponseSchema } },
  required: ['policies'],
} as const

export const v2ApprovalResponseSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', minLength: 1 },
    payment_id: { type: 'string', minLength: 1 },
    account_id: { type: 'string', minLength: 1 },
    status: { type: 'string', enum: ['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED'] },
    expires_at: { type: 'string', minLength: 1 },
    actor_id: nullableStringSchema,
    comment: nullableStringSchema,
    row_version: { type: 'integer', minimum: 1 },
    created_at: { type: 'string', minLength: 1 },
    decided_at: nullableStringSchema,
  },
  required: [
    'id',
    'payment_id',
    'account_id',
    'status',
    'expires_at',
    'actor_id',
    'comment',
    'row_version',
    'created_at',
    'decided_at',
  ],
} as const

export const v2ApprovalListResponseSchema = {
  type: 'object',
  additionalProperties: false,
  properties: { approvals: { type: 'array', items: v2ApprovalResponseSchema } },
  required: ['approvals'],
} as const

export const v2ApprovedDestinationResponseSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', minLength: 1 },
    account_id: { type: 'string', minLength: 1 },
    fingerprint: { type: 'string', minLength: 1 },
    rail: { type: 'string', minLength: 1 },
    network: { type: 'string', minLength: 1 },
    asset_reference: { type: 'string', minLength: 1 },
    destination: { type: 'string', minLength: 1 },
    status: { type: 'string', enum: ['ACTIVE', 'REVOKED'] },
    actor_id: { type: 'string', minLength: 1 },
    reason: nullableStringSchema,
    created_at: { type: 'string', minLength: 1 },
    revoked_at: nullableStringSchema,
  },
  required: [
    'id',
    'account_id',
    'fingerprint',
    'rail',
    'network',
    'asset_reference',
    'destination',
    'status',
    'actor_id',
    'reason',
    'created_at',
    'revoked_at',
  ],
} as const

export const v2ApprovedDestinationListResponseSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    approved_destinations: {
      type: 'array',
      items: v2ApprovedDestinationResponseSchema,
    },
  },
  required: ['approved_destinations'],
} as const

export const v2StatusResponseSchema = {
  type: 'object',
  additionalProperties: false,
  properties: { status: { type: 'string', minLength: 1 } },
  required: ['status'],
} as const

const v2TimelineItemSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', minLength: 1 },
    account_id: nullableStringSchema,
    resource_type: { type: 'string', minLength: 1 },
    resource_id: { type: 'string', minLength: 1 },
    event_type: { type: 'string', minLength: 1 },
    actor_type: { type: 'string', minLength: 1 },
    actor_id: nullableStringSchema,
    request_id: nullableStringSchema,
    correlation_id: nullableStringSchema,
    old_state: {},
    new_state: {},
    source: { type: 'string', minLength: 1 },
    occurred_at: { type: 'string', minLength: 1 },
    metadata: {},
  },
  required: [
    'id',
    'account_id',
    'resource_type',
    'resource_id',
    'event_type',
    'actor_type',
    'actor_id',
    'request_id',
    'correlation_id',
    'old_state',
    'new_state',
    'source',
    'occurred_at',
    'metadata',
  ],
} as const

export const v2TimelineResponseSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    items: { type: 'array', items: v2TimelineItemSchema },
    next_cursor: nullableStringSchema,
  },
  required: ['items', 'next_cursor'],
} as const

export const v2WebhookSubscriptionResponseSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', minLength: 1 },
    account_id: { type: 'string', minLength: 1 },
    endpoint: { type: 'string', minLength: 1 },
    event_types: {
      type: 'array',
      minItems: 1,
      items: { type: 'string', minLength: 1 },
    },
    status: { type: 'string', minLength: 1 },
    signing_key_ref: { type: 'string', minLength: 1 },
    signing_key_version: { type: 'integer', minimum: 1 },
    created_at: { type: 'string', minLength: 1 },
    archived_at: nullableStringSchema,
  },
  required: [
    'id',
    'account_id',
    'endpoint',
    'event_types',
    'status',
    'signing_key_ref',
    'signing_key_version',
    'created_at',
    'archived_at',
  ],
} as const

export const v2WebhookSubscriptionListResponseSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    subscriptions: {
      type: 'array',
      items: v2WebhookSubscriptionResponseSchema,
    },
  },
  required: ['subscriptions'],
} as const

export const v2ExceptionResponseSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', minLength: 1 },
    account_id: nullableStringSchema,
    resource_type: { type: 'string', minLength: 1 },
    resource_id: { type: 'string', minLength: 1 },
    dedupe_key: { type: 'string', minLength: 1 },
    status: { type: 'string', minLength: 1 },
    severity: { type: 'string', minLength: 1 },
    reason_code: { type: 'string', minLength: 1 },
    details: {},
    assigned_to: nullableStringSchema,
    row_version: { type: 'integer', minimum: 1 },
    created_at: { type: 'string', minLength: 1 },
    updated_at: { type: 'string', minLength: 1 },
    acknowledged_at: nullableStringSchema,
    resolved_at: nullableStringSchema,
  },
  required: [
    'id',
    'account_id',
    'resource_type',
    'resource_id',
    'dedupe_key',
    'status',
    'severity',
    'reason_code',
    'details',
    'assigned_to',
    'row_version',
    'created_at',
    'updated_at',
    'acknowledged_at',
    'resolved_at',
  ],
} as const

export const v2ExceptionListResponseSchema = {
  type: 'object',
  additionalProperties: false,
  properties: { exceptions: { type: 'array', items: v2ExceptionResponseSchema } },
  required: ['exceptions'],
} as const

export const v2BalanceResponseSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    account_id: { type: 'string', minLength: 1 },
    denomination_id: { type: 'string', minLength: 1 },
    settled: exactAmountSchema,
    reserved: exactAmountSchema,
    spendable: exactAmountSchema,
    observed_at: { type: 'string', minLength: 1 },
    degraded: { type: 'boolean' },
  },
  required: [
    'account_id',
    'denomination_id',
    'settled',
    'reserved',
    'spendable',
    'observed_at',
    'degraded',
  ],
} as const

export const v2FundingDestinationResponseSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: nullableStringSchema,
    account_id: { type: 'string', minLength: 1 },
    route_id: nullableStringSchema,
    network: nullableStringSchema,
    asset_id: nullableStringSchema,
    destination: nullableStringSchema,
    readiness: {
      type: 'string',
      enum: ['READY', 'PENDING', 'DEGRADED', 'UNAVAILABLE'],
    },
    sender_constraints: { type: 'object', additionalProperties: true },
    last_validated_at: nullableStringSchema,
    last_failure_code: nullableStringSchema,
  },
  required: [
    'id',
    'account_id',
    'route_id',
    'network',
    'asset_id',
    'destination',
    'readiness',
    'sender_constraints',
    'last_validated_at',
    'last_failure_code',
  ],
} as const

const v2HistoryItemSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', minLength: 1 },
    direction: { type: 'string', enum: ['INCOMING', 'OUTGOING'] },
    kind: { type: 'string', minLength: 1 },
    status: { type: 'string', minLength: 1 },
    amount: exactAmountSchema,
    denomination_id: nullableStringSchema,
    currency: { type: 'string', minLength: 1 },
    recipient_id: nullableStringSchema,
    external_id: nullableStringSchema,
    occurred_at: { type: 'string', minLength: 1 },
  },
  required: [
    'id',
    'direction',
    'kind',
    'status',
    'amount',
    'denomination_id',
    'currency',
    'recipient_id',
    'external_id',
    'occurred_at',
  ],
} as const

export const v2HistoryResponseSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    items: { type: 'array', items: v2HistoryItemSchema },
    next_cursor: nullableStringSchema,
  },
  required: ['items', 'next_cursor'],
} as const

const v2RecipientDestinationSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', minLength: 1 },
    rail: { type: 'string', minLength: 1 },
    type: { type: 'string', minLength: 1 },
    wallet_address: { type: 'string', minLength: 1 },
    network: nullableStringSchema,
    asset_reference: nullableStringSchema,
    status: { type: 'string', enum: ['ACTIVE', 'REVOKED'] },
    version: { type: 'integer', minimum: 1 },
  },
  required: [
    'id',
    'rail',
    'type',
    'wallet_address',
    'network',
    'asset_reference',
    'status',
    'version',
  ],
} as const

export const v2RecipientResponseSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', minLength: 1 },
    display_name: { type: 'string', minLength: 1 },
    type: { type: 'string', minLength: 1 },
    managed_account_id: nullableStringSchema,
    destinations: { type: 'array', items: v2RecipientDestinationSchema },
    created_at: { type: 'string', minLength: 1 },
    updated_at: { type: 'string', minLength: 1 },
  },
  required: [
    'id',
    'display_name',
    'type',
    'managed_account_id',
    'destinations',
    'created_at',
    'updated_at',
  ],
} as const

export const v2RecipientListResponseSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    recipients: { type: 'array', items: v2RecipientResponseSchema },
    next_cursor: nullableStringSchema,
  },
  required: ['recipients', 'next_cursor'],
} as const

export const v2ReceiveResponseSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', minLength: 1 },
    account_id: { type: 'string', minLength: 1 },
    amount: { type: ['string', 'null'], pattern: '^\\d+(?:\\.\\d+)?$' },
    denomination_id: nullableStringSchema,
    currency: { type: 'string', minLength: 1 },
    reference: { type: 'string', minLength: 1 },
    status: { type: 'string', enum: ['OPEN', 'PAID', 'EXPIRED', 'CANCELLED'] },
    created_at: { type: 'string', minLength: 1 },
    expires_at: nullableStringSchema,
    paid_at: nullableStringSchema,
    destination: receiveDestinationSchema,
    settlement: receiveSettlementSchema,
  },
  required: [
    'id',
    'account_id',
    'amount',
    'denomination_id',
    'currency',
    'reference',
    'status',
    'created_at',
    'expires_at',
    'paid_at',
    'destination',
    'settlement',
  ],
} as const

export const v2ReceiveListResponseSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    receive_requests: { type: 'array', items: v2ReceiveResponseSchema },
    next_cursor: nullableStringSchema,
  },
  required: ['receive_requests', 'next_cursor'],
} as const
