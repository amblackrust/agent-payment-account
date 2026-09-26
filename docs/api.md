# API Reference

The Mux API is served at `http://127.0.0.1:3000` by default. Domain request and response payloads use snake_case; errors use the envelope documented below. All responses include `x-request-id`.

## Health and metrics

- `GET /health/live` — process liveness only; it does not require the database
  or settlement rail.
- `GET /health/ready` — dependency readiness, including database and the
  configured settlement rail/runtime gate.
- `GET /health/domain` — durable workflow health and active domain alerts such
  as review backlog, exhausted incoming issues, webhook backlog, restore
  verification failure, and runtime identity mismatch.
- `GET /metrics` — process metrics in Prometheus text format. These metrics are
  operational telemetry; durable workflow state remains the source of truth.

## Authentication

### Admin authentication

Account and credential administration uses `x-admin-api-key: <ADMIN_API_KEY>`. The admin key is runtime configuration and is separate from every Agent Account credential.

### Agent authentication

Balance, recipient, receive, payment, refund, and transaction routes use `Authorization: Bearer <agent_api_key>`.

An agent API key begins with `apa_` and is returned only when an account or replacement credential is created. Mux stores a SHA-256 hash and a non-secret prefix, not the plaintext key. Revoked credentials and credentials for disabled accounts are rejected.

## V2 API (canonical contract)

The `/v2` surface is the canonical Agent Payment Account contract. The `/v1`
surface below remains a compatibility API and keeps its fixed-two-decimal USD
wire format; production `/v1` payment, send, and refund operations are adapted
into the same durable V2 orchestrator.

V2 amounts are plain decimal strings bound to a `denomination_id`. They do not
use exponent notation, JavaScript numbers, or an implicit global two-decimal
scale. The denomination and settlement route determine the permitted logical
scale and asset conversion. Reusing an idempotency key with a different
request returns a conflict; exact replays return the original durable result.

Agent-authenticated V2 routes include:

- `GET /v2/accounts/:accountId` — account identity and lifecycle state for the
  authenticated account.
- `GET /v2/balance?denomination_id=...` and
  `GET /v2/accounts/:accountId/balance?denomination_id=...` — settled,
  reserved, and spendable exact balances.
- `GET /v2/funding-destination` and
  `GET /v2/accounts/:accountId/funding-destination` — the funding destination
  and its readiness for an optional route. Missing provisioning is returned as
  `readiness: "UNAVAILABLE"` with null destination fields and a stable failure
  code rather than as an indistinguishable 404.
- `POST`, `GET`, `PATCH`, and archive operations under `/v2/recipients` —
  account-owned recipient directory and approved destination checks.
- `POST`, `GET`, list, and cancel operations under `/v2/receive-requests` —
  exact-amount receive intents and their settlement destination.
- `POST /v2/payments`, `GET /v2/payments/:paymentId`, and
  `GET /v2/payments` — payment creation, polling, and cursor-paginated
  filtering by status, outcome, recipient, or denomination.
- `POST /v2/external-payments/x402` — creates an ordinary V2 payment intent for
  the configured x402 proof target. The body contains only
  `{ "denomination_id": "..." }`; `Idempotency-Key` is required. Mux performs
  the live `402 Payment Required` negotiation server-side, persists the
  resulting destination and amount in the normal payment snapshot, and never
  accepts a caller-supplied pay-to, fee payer, amount, or resource URL.
- `POST /v2/payments/:paymentId/refunds` — a new auditable refund payment.
- `GET /v2/history` and `GET /v2/timeline` — unified history and append-only
  operational events.
- `GET`, `POST`, and archive operations under `/v2/webhooks` — signed,
  at-least-once delivery subscriptions.

Payment and receive creation require `idempotency-key`. Payment responses
expose policy, approval, reservation, execution, settlement, outcome, attempt,
and failure dimensions; `status` is a deterministic projection and is not a
second source of truth. `RECONCILING`, `REVIEW_REQUIRED`, and
`CLOSED_UNRESOLVED` are not ordinary failures.

V2 payment and refund requests may include a JSON-object `metadata` field. It
is persisted with the payment, included in the idempotency fingerprint, and
returned unchanged in payment responses. Metadata is limited to 16 KiB after
canonical JSON serialization.

Admin-authenticated V2 routes manage account lifecycle and credentials,
policies, approvals, approved destinations, and the operator exception inbox:

- `POST /v2/accounts` provisions an account with an idempotent request.
- `GET /v2/accounts/:accountId/credentials` lists credentials.
- `POST /v2/accounts/:accountId/credentials` creates an independent delegated
  credential. The JSON body requires a non-empty `scopes` array and may include
  `expires_at`; the `Idempotency-Key` header is required. The recognized scopes
  are `payments:create`, `payments:read`, `contacts:manage`, `receive:manage`,
  `balance:read`, `history:read`, and `webhooks:manage`.
- `/v2/accounts/:accountId/credentials/:credentialId` lifecycle, revoke, and
  rotate routes apply the corresponding guarded commands.
- `POST /v2/accounts/:accountId/credentials/recovery/acknowledge` explicitly
  deletes the short-lived recovery envelope for the issuance identified by the
  `Idempotency-Key` header. Repeating the acknowledgement is safe.
- `GET|PUT /v2/accounts/:accountId/policy`,
  `/v2/accounts/:accountId/policies`, `/v2/policies/:policyId/activate`, and
  `/v2/accounts/:accountId/approvals` manage versioned policy and approval
  state. A replacement PUT creates a new immutable active version; when a
  policy already exists, the request must include its current `version`.
- `/v2/accounts/:accountId/approved-destinations` manages separately
  authorized destinations.
- `/v2/operator/exceptions` and its domain-command routes expose operational
  review without allowing an operator to release an unresolved reservation by
  timeout alone.

### V2 webhook verification

Webhook deliveries use the exact durable JSON body and include these headers:

- `x-mux-event-id` — stable event identity; duplicate deliveries are possible.
- `x-mux-signature-version` — signing-key version to select at the secret
  boundary.
- `x-mux-timestamp` — Unix timestamp in seconds.
- `x-mux-signature` — `sha256=<hex HMAC>`.

Compute `HMAC-SHA256(secret, "<timestamp>.<raw_body>")` without parsing or
re-serializing the body. Accept a delivery only when the timestamp is within
the five-minute replay window and compare the decoded MAC in constant time.
Subscriptions store a secret reference and version; the signing secret is
never returned by the API. Delivery is at-least-once with bounded retries, so
consumers should deduplicate by event ID.

V2 errors use the canonical envelope:

```json
{
  "code": "REVIEW_REQUIRED",
  "message": "Payment requires operational review",
  "request_id": "req_...",
  "payment_id": "pay_...",
  "payment_status": "REVIEW_REQUIRED",
  "reason_codes": ["CUSTODY_RETRY_EXHAUSTED"]
}
```

## Accounts

### Create an account

`POST /v1/accounts`

Requires admin authentication. Creates an active account, its managed Solana signer, an initial one-time credential, and a default receive request.

Request:

```json
{ "name": "research-agent" }
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
    "destination": {
      "type": "external_transfer_target",
      "reference": "<spl-token-account>"
    },
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

### Create a delegated V2 credential

`POST /v2/accounts/:accountId/credentials`

Requires admin authentication and an `Idempotency-Key` header. A successful
first request returns `201` and creates one independent credential. The same
key with the same normalized request fingerprint returns the same credential;
while its recovery envelope is alive, the replay may return the same `api_key`.
The same key with a different fingerprint returns `409`
`IDEMPOTENCY_KEY_REUSED`, and never creates a second credential.

The plaintext key is not stored as credential state. Only its verification
hash and an encrypted recovery envelope are persisted. The recovery envelope
TTL is controlled by `CREDENTIAL_RECOVERY_TTL_SECONDS` and defaults to 900
seconds. Once it is consumed, acknowledged, or expired, a replay returns the
same credential with `api_key: null`; issue or rotate a new credential to get a
new secret.

Example request:

```http
POST /v2/accounts/acct_123/credentials
Idempotency-Key: issue-2026-09-18-001
X-Admin-Api-Key: <ADMIN_API_KEY>
Content-Type: application/json

{"scopes":["payments:read","history:read"],"expires_at":"2026-10-01T00:00:00Z"}
```

The recovery acknowledgement uses the same issuance idempotency key:

```http
POST /v2/accounts/acct_123/credentials/recovery/acknowledge
Idempotency-Key: issue-2026-09-18-001
X-Admin-Api-Key: <ADMIN_API_KEY>
```

### Revoke a credential

`POST /v1/accounts/:accountId/credentials/:credentialId/revoke`

Requires admin authentication. Returns `{ "status": "REVOKED" }`. A missing or already revoked credential returns `422`.

### Rotate a V2 credential

`POST /v2/accounts/:accountId/credentials/:credentialId/rotate`

Requires admin authentication and an `idempotency-key` header. The active
credential is revoked only after its replacement and encrypted recovery
envelope are durable. The response contains the replacement `api_key` once;
the plaintext is never stored as credential state. If the response is lost,
retry with the same idempotency key within the recovery TTL to consume the
one-time encrypted envelope. After that envelope is consumed or expires, the
plaintext cannot be recovered and a new rotation is required.

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

`wallet_address` is the recipient's Solana owner/public key, not an SPL token-account address. Mux derives its associated token account for the configured settlement mint. For an external recipient, that derived token account must already exist; Mux does not sponsor its creation.

For another Mux-managed account, add `managed_account_id`. Its `wallet_address` must equal that account's canonical Solana public key. Verified managed recipients may receive sponsored associated-token-account creation through the platform fee payer. Self-payments are rejected.

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

The x402 proof adapter accepts only x402 v2 `exact` requirements for Solana
mainnet and canonical USDC. It selects the current requirement from the
provider's live 402 response and enforces an absolute cap of `100000` USDC
atomic units (`$0.10`). Provider payment parameters are not configuration
constants. The external provider's advertised `feePayer` remains distinct from
the Mux platform fee payer; no Mux wallet secret is sent to the provider.

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

| Status | Typical meaning                                                                                          |
| ------ | -------------------------------------------------------------------------------------------------------- |
| `400`  | Fastify request-schema validation failed                                                                 |
| `401`  | Admin or agent authentication failed                                                                     |
| `404`  | An account-owned recipient, receive request, payment, or transaction was not found                       |
| `409`  | Insufficient available funds or conflicting idempotency/resource state                                   |
| `422`  | Domain validation, recipient resolution, unsupported rail/currency/refund, or deterministic rail failure |
| `502`  | Retryable or ambiguous external rail failure                                                             |
| `500`  | Internal failure with a sanitized response                                                               |

For money operations, a transport failure can leave the outcome unknown. Retry with the same idempotency key or fetch the payment rather than creating a new logical operation.
