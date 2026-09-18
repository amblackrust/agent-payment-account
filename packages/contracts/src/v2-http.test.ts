import { describe, expect, it } from 'vitest'

import {
  v2CredentialIssuanceRequestJsonSchema,
  v2CredentialIssuanceResponseJsonSchema,
  v2RotatedCredentialResponseSchema,
  v2PaymentResponseJsonSchema,
} from './v2-http.js'
import {
  v2CredentialIssuanceRequestSchema,
  v2ErrorEnvelopeSchema,
  v2PaymentResponseSchema,
} from './v2.js'

describe('canonical V2 HTTP contracts', () => {
  it('keeps credential scopes non-empty and constrained to the canonical set', () => {
    expect(
      v2CredentialIssuanceRequestSchema.safeParse({
        scopes: ['history:read', 'payments:read'],
      }).success,
    ).toBe(true)
    expect(v2CredentialIssuanceRequestSchema.safeParse({ scopes: [] }).success).toBe(
      false,
    )
    expect(
      v2CredentialIssuanceRequestSchema.safeParse({ scopes: ['payments:write'] })
        .success,
    ).toBe(false)
  })

  it('keeps the generated Draft-07 schemas aligned with the Zod contracts', () => {
    expect(v2CredentialIssuanceRequestJsonSchema).toMatchObject({
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      additionalProperties: false,
      required: ['scopes'],
    })
    expect(v2CredentialIssuanceResponseJsonSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: [
        'credential_id',
        'account_id',
        'api_key',
        'key_prefix',
        'scopes',
        'expires_at',
      ],
    })
    expect(
      v2RotatedCredentialResponseSchema.safeParse({
        credential_id: 'cred_1',
        account_id: 'acct_1',
        api_key: 'apa_secret',
        key_prefix: 'apa_secret',
        scopes: ['payments:write'],
        expires_at: null,
      }).success,
    ).toBe(false)
    expect(v2PaymentResponseJsonSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
    })
    expect(v2PaymentResponseJsonSchema.required).toEqual(
      expect.arrayContaining(['metadata', 'amount', 'status']),
    )
  })

  it('rejects malformed exact-money responses and preserves stable error codes', () => {
    expect(
      v2PaymentResponseSchema.safeParse({
        id: 'pay_1',
        kind: 'PAY',
        recipient_id: 'recipient_1',
        description: null,
        external_reference: null,
        metadata: {},
        amount: '1e-2',
        denomination_id: 'usd',
        denomination_symbol: 'USD',
        status: 'CREATED',
        policy_decision: 'ALLOW',
        policy_reason_codes: [],
        approval_state: 'NOT_REQUIRED',
        attempt_count: 0,
        reservation_status: 'NONE',
        route_id: null,
        route_selection_reason: null,
        settlement_asset_id: null,
        execution_state: 'NOT_STARTED',
        settlement_state: 'NOT_STARTED',
        outcome_state: 'NONE',
        created_at: '2026-09-18T00:00:00.000Z',
        updated_at: '2026-09-18T00:00:00.000Z',
        confirmed_at: null,
        failure_code: null,
        failure_message: null,
        original_payment_id: null,
      }).success,
    ).toBe(false)
    expect(
      v2ErrorEnvelopeSchema.safeParse({
        code: 'IDEMPOTENCY_KEY_REUSED',
        message: 'Idempotency key was already used for another request',
      }).success,
    ).toBe(true)
  })
})
