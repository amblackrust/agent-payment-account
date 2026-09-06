# API Reference

The Mux API is served at `http://127.0.0.1:3000` by default. Request and response field names are snake_case. All responses include `x-request-id`.

## Authentication

### Admin authentication

Account and credential administration uses `x-admin-api-key: <ADMIN_API_KEY>`. The admin key is runtime configuration and is separate from every Agent Account credential.

### Agent authentication

Balance, recipient, receive, payment, refund, and transaction routes use `Authorization: Bearer <agent_api_key>`.

An agent API key begins with `apa_` and is returned only when an account or replacement credential is created. Mux stores a SHA-256 hash and a non-secret prefix, not the plaintext key. Revoked credentials and credentials for disabled accounts are rejected.

## Accounts

### Create an account

`POST /v1/accounts`

Requires admin authentication. Creates an active account, its managed Solana signer, an initial one-time credential, and a default receive request.

Request:

```json
{"name":"research-agent"}
```

Response:

```json
{
  "id": "acct_...",
  "name": "research-agent",
  "status": "ACTIVE",
  "api_key": "apa_...",
  "credential_id": "cred_...",
  "receive": {
    "id": "recv_...",
    "currency": "USD",
    "status": "OPEN",
    "destination": {"type":"external_transfer_target","reference":"<spl-token-account>"},
    "settlement": {
      "owner": "<account-public-key>",
      "token_account": "<spl-token-account>",
      "mint": "<configured-mint>"
    }
  }
}
```

Store `api_key` when it is returned; it cannot be recovered later.

### List accounts

`GET /v1/accounts`

Requires admin authentication. Returns `{ "accounts": [...] }` with account identity, status, Solana public key, timestamps, and credential metadata (`id`, `key_prefix`, `created_at`, `revoked_at`). It never returns credential plaintext or signer secrets.

## Credentials

### Create a credential

`POST /v1/accounts/:accountId/credentials`

Requires admin authentication. Returns `201` with `credential_id`, `account_id`, the one-time `api_key`, `key_prefix`, and `created_at`.

### Revoke a credential

`POST /v1/accounts/:accountId/credentials/:credentialId/revoke`

Requires admin authentication. Returns `{ "status": "REVOKED" }`. A missing or already revoked credential returns `422`.

## Balance

### Get balance

`GET /v1/balance`

Requires agent authentication. Returns the observed on-chain balance, active outgoing reservations, and spendable balance:

```json
{
  "currency": "USD",
  "settled": "12.50",
  "pending_outgoing": "0.50",
  "available": "12.00"
}
```

Amounts are fixed two-decimal strings. `available` never drops below zero.

## Recipients

Recipients belong to the authenticated Agent Account.

### Create a recipient

`POST /v1/recipients`

Requires agent authentication and returns `201`.

```json
{
  "display_name": "data-provider",
  "type": "EXTERNAL",
  "destination": {
    "type": "SOLANA_SPL",
    "wallet_address": "<solana-address>"
  }
}
```

For another Mux-managed account, add `managed_account_id`. Its `wallet_address` must equal that account's canonical Solana public key. Self-payments are rejected.

Response fields are `id`, `display_name`, `type`, `managed_account_id`, `destinations`, `created_at`, and `updated_at`. Each destination includes `id`, `rail`, `type`, and `wallet_address`.

### List recipients

`GET /v1/recipients?limit=50&cursor=...`

Requires agent authentication. `limit` defaults to `50` and must be from `1` to `100`. Returns `{ "recipients": [...], "next_cursor": null }`. Treat `cursor` as opaque.

### Get a recipient

`GET /v1/recipients/:recipientId`

Requires agent authentication. Returns the recipient owned by the authenticated account or `404`.

### Update a recipient

`PATCH /v1/recipients/:recipientId`

Requires agent authentication. Supply at least one of `display_name`, `type`, `managed_account_id`, or a complete destination:

```json
{
  "destination": {
    "id": "dest_...",
    "type": "SOLANA_SPL",
    "wallet_address": "<solana-address>"
  }
}
```

Managed-account and self-payment checks are applied again after an update.

## Pay and Send

`POST /v1/pay` and `POST /v1/send` have the same request contract and execution pipeline. They differ in the recorded payment `kind`.

Both require agent authentication and `idempotency-key: <stable-key-for-this-operation>`.

```json
{
  "recipient_id": "rcpt_...",
  "amount": "0.50",
  "currency": "USD",
  "description": "dataset access",
  "external_reference": "order-123"
}
```

`description` and `external_reference` are optional. A new operation returns `201`; an exact idempotent replay returns `200` and the existing payment. Reusing the same key for a different request returns `409`.

Payment responses contain:

```json
{
  "id": "pay_...",
  "recipient_id": "rcpt_...",
  "kind": "PAY",
  "amount": "0.50",
  "currency": "USD",
  "status": "CONFIRMED",
  "description": "dataset access",
  "external_reference": "order-123",
  "route": "SOLANA_SPL",
  "created_at": "2026-01-01T00:00:00.000Z",
  "updated_at": "2026-01-01T00:00:01.000Z",
  "confirmed_at": "2026-01-01T00:00:01.000Z",
  "failed_at": null,
  "failure_code": null,
  "failure_message": null,
  "original_payment_id": null
}
```

Possible statuses are `CREATED`, `ROUTING`, `SUBMITTED`, `RECONCILING`, `CONFIRMED`, and `FAILED`. HTTP success means the operation was accepted or replayed; only `CONFIRMED` proves the configured chain confirmation was observed.

## Receive

### Create a receive request

`POST /v1/receives`

Requires agent authentication. Only `currency` is required:

```json
{
  "currency": "USD",
  "amount": "1.25",
  "reference": "invoice-123",
  "expires_at": "2026-12-31T23:59:59Z"
}
```

If `reference` is omitted, the generated receive-request ID is used. `expires_at`, when supplied, must be a future RFC 3339 instant.

The response contains `id`, `account_id`, nullable `amount`, `currency`, `reference`, `status`, timestamps, and the same `destination` and `settlement` structures returned during account creation. Receive statuses are `OPEN`, `PAID`, `EXPIRED`, and `CANCELLED`. Creating the request does not transfer funds.

### Get a receive request

`GET /v1/receives/:receiveId`

Requires agent authentication. Returns a receive request owned by the authenticated account or `404`.

## Refund

### Create a refund

`POST /v1/refunds`

Requires agent authentication and `idempotency-key`.

```json
{
  "original_payment_id": "pay_...",
  "amount": "0.50",
  "currency": "USD"
}
```

A refund is a new payment with `kind: "REFUND"` and `original_payment_id` set. It is supported only when the original recipient is another managed account and the original payer destination is known. Unsupported destinations return `422` with `REFUND_NOT_SUPPORTED`.

## Payments and Payment Status

### Get a payment

`GET /v1/payments/:paymentId`

Requires agent authentication. Returns the payment owned by the authenticated account or `404`. Use this route to poll `SUBMITTED` or `RECONCILING` operations.

### List payments

`GET /v1/payments?limit=50&cursor=...`

Requires agent authentication. `limit` defaults to `50` and must be from `1` to `100`. Returns `{ "payments": [...], "next_cursor": null }`. Treat the cursor as opaque.

## Transactions

### List transactions

`GET /v1/transactions?limit=50&cursor=...`

Requires agent authentication. Returns `{ "transactions": [...], "next_cursor": null }`. Each transaction contains `id`, `direction`, `kind`, `amount`, `currency`, `status`, `counterparty`, timestamps, and nullable `signature`.

`direction` is `INCOMING` or `OUTGOING`. `kind` is `PAY`, `SEND`, `REFUND`, or `RECEIVE`. The `counterparty` object contains nullable `recipient_id`, `display_name`, `account_id`, and `address`.

### Get a transaction

`GET /v1/transactions/:transactionId`

Requires agent authentication. Accepts an outgoing payment ID or incoming transaction ID owned by the authenticated account and returns the normalized transaction, otherwise `404`.

## Health and Readiness

### Process health

`GET /health`

Public. Returns `200 { "status": "ok" }`.

### Dependency readiness

`GET /ready`

Public. Checks PostgreSQL and the configured Solana network, settlement mint, and platform fee payer. Returns `200 { "status": "ok" }` when ready or `503 { "status": "not_ready" }` when a dependency check fails.

## Errors

Errors use this shape:

```json
{
  "statusCode": 422,
  "error": "VALIDATION_ERROR",
  "message": "Request validation failed",
  "details": {}
}
```

`details` is optional. Messages for server-side failures are sanitized to `Internal Server Error`.

| Status | Typical meaning |
| --- | --- |
| `400` | Fastify request-schema validation failed |
| `401` | Admin or agent authentication failed |
| `404` | An account-owned recipient, receive request, payment, or transaction was not found |
| `409` | Insufficient available funds or conflicting idempotency/resource state |
| `422` | Domain validation, recipient resolution, unsupported rail/currency/refund, or deterministic rail failure |
| `502` | Retryable or ambiguous external rail failure |
| `500` | Internal failure with a sanitized response |

For money operations, a transport failure can leave the outcome unknown. Retry with the same idempotency key or fetch the payment rather than creating a new logical operation.
