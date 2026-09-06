# Mux

Mux is a developer-facing financial runtime for AI agents.
It gives an application a persistent custodial account, normalized money
operations, balance reads, receive instructions, transaction history, and a
TypeScript SDK. The agent works with account, recipient, amount, currency, pay,
send, receive, and refund concepts; Solana transaction construction stays inside
the settlement adapter.

## What problem it solves

Developers can provide an agent with a programmable financial account without
making the agent understand token accounts, decimals, RPC, transaction signing,
or chain-specific routing. The backend owns custody, payment lifecycle,
idempotency, reservations, confirmation, and reconciliation.

## Architecture

```text
apps/api                  Fastify HTTP API and reconciliation timer
packages/core             Money, payment lifecycle, routing contracts, errors
packages/db               Prisma schema, migrations, repositories
packages/solana-rail      Kit-first SPL read/write and incoming reconciliation
packages/contracts        Shared Zod HTTP wire schemas
packages/sdk              Agent-facing TypeScript HTTP client
tests/e2e                 E2E documentation and entrypoint reference
```

PostgreSQL stores accounts, credential hashes, encrypted wallet material,
recipients, payments, attempts, reservations, receive requests, incoming
transfers, and reconciliation cursors.

## Product v1 scope

- One agent-facing currency: `USD`.
- One real settlement rail: classic Solana SPL Token.
- `SOLANA_SETTLEMENT_MINT` selects the configured stablecoin mint; this is not
  an FX engine or a promise of fiat custody.
- Custody is a prototype custodial boundary, not an HSM/MPC architecture.
- Card, bank, x402, FX, off-ramp, KYC, frontend, and agent orchestration are
  outside product v1.

## Quick start

Requirements: Node.js 22+, pnpm 11+, Docker with Compose, and a configured
classic SPL settlement mint for real payments.

```bash
git clone <repository-url>
cd agent-payment-account
pnpm install --frozen-lockfile
cp .env.example .env
# Edit .env with the local settlement mint and fee-payer secret.
docker compose up -d postgres
pnpm db:migrate
pnpm dev
```

The API listens on `http://127.0.0.1:3000` by default.

```bash
curl http://127.0.0.1:3000/health
curl http://127.0.0.1:3000/ready
```

`/health` reports process health. `/ready` performs bounded, fresh checks for
PostgreSQL, the configured Solana network/mint, and the platform fee payer
operating threshold. It returns `503 {"status":"not_ready"}` whenever any
required dependency is unavailable.

## Environment variables

All runtime configuration is loaded and validated centrally. See [`.env.example`](.env.example).

- `DATABASE_URL` — PostgreSQL connection URL.
- `PORT` — HTTP port, default `3000`.
- `NODE_ENV` — `development`, `test`, or `production`.
- `ADMIN_API_KEY` — bootstrap credential for account administration.
- `SOLANA_RPC_URL` — custom Kit-compatible Solana RPC URL.
- `SOLANA_CLUSTER` — `localnet`, `devnet`, `testnet`, or `mainnet-beta`.
- `SOLANA_SETTLEMENT_MINT` — configured classic SPL stablecoin mint address.
- `SOLANA_FEE_PAYER_SECRET` — 64-byte key in JSON-array, hex, or base64 form.
- `WALLET_MASTER_KEY` — 32 bytes encoded as 64 hexadecimal characters.
- `ALLOW_MAINNET` — must be explicitly `true` for mainnet; default is `false`.

Generate local secret material with:

```bash
openssl rand -hex 32                 # WALLET_MASTER_KEY or an admin secret
```

Generate a Solana fee-payer key using the Solana tooling appropriate for the
operator, then provide its 64-byte secret as JSON, hex, or base64. Keep all
secrets outside source control and never put them in logs.

## Create an account

The admin bootstrap endpoint returns the agent API key exactly once. Store it
securely; it is not persisted in plaintext.

```bash
curl -X POST http://127.0.0.1:3000/v1/accounts \
  -H "x-admin-api-key: $ADMIN_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"name":"research-agent"}'
```

The response includes `id`, one-time `api_key`, and normalized receive
settlement details. The account signer private key is never returned.

If the bootstrap HTTP response is lost, an administrator can list accounts and
their non-secret credential metadata with `GET /v1/accounts`, then issue a new
one-time credential with `POST /v1/accounts/:accountId/credentials`. Existing
credentials can be revoked with the returned `credential_id`.

## Fund / receive

Use the returned settlement `owner`, `token_account`, and `mint` as developer
settlement details for a real SPL transfer. An agent can request normalized
receive instructions through the SDK:

```ts
const receive = await account.receive({
  amount: '1.25',
  reference: 'invoice-123',
})
```

The incoming reconciler validates the configured mint, successful transfer,
positive external token delta, and optional reference. An unmatched incoming
transfer remains visible as a generic `RECEIVE` transaction.

## Create a recipient

Recipients are owned by the authenticated account and payments use `recipient_id`,
never a wallet address in the agent-facing payment request.

```bash
curl -X POST http://127.0.0.1:3000/v1/recipients \
  -H "authorization: Bearer $AGENT_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"display_name":"managed-recipient","type":"AGENT","managed_account_id":"acct_...","destination":{"type":"SOLANA_SPL","wallet_address":"..."}}'
```

Managed-account destinations are server-verified against the target account's
canonical Solana public key.

## Get balance

```ts
const balance = await account.getBalance()
// { currency: 'USD', settled: '12.50', pendingOutgoing: '0.00', available: '12.50' }
```

Balances are normalized USD strings. Internally all calculations use integer
atomic units; the configured token's raw units never cross the public contract.

## Pay and send

```ts
const paid = await account.pay(
  {
    recipientId: 'rcpt_...',
    amount: '0.50',
    description: 'dataset access',
    externalReference: 'order-123',
  },
  { idempotencyKey: 'order-123-payment' },
)

const sent = await account.send(
  { recipientId: 'rcpt_...', amount: '0.25' },
  { idempotencyKey: 'order-123-send' },
)
```

Both operations use the same reservation, durable attempt, signed-payload,
confirmation, and recovery pipeline. Always inspect the returned `status`
alongside the HTTP status: `CONFIRMED` means that the chain transaction reached
the configured confirmation level, while `RECONCILING` means that the outcome
is not known yet. An HTTP `200` or `201` alone must never be interpreted as
proof of blockchain success. Poll `getPayment()` or retry with the same
idempotency key while the payment remains recoverable.

## Receive and refund

`receive()` creates a persistent receive request; it does not itself move funds.
Refund is a new reverse SPL transfer, not a cancellation of an immutable chain
transaction. It is supported only when the original recipient is another
managed account controlled by this system and the original payer destination is
known.

```ts
const refund = await account.refund(
  { originalPaymentId: 'pay_...', amount: '0.50' },
  { idempotencyKey: 'refund-pay-...' },
)
```

External uncontrolled recipients return `REFUND_NOT_SUPPORTED`.

For ordinary external recipients, the destination SPL token account must
already exist; Mux does not sponsor arbitrary ATA rent. Verified managed
recipients may have their ATA created, subject to a per-account sponsorship
budget (10,000,000 lamports per UTC day and 60 sponsored transactions per
hour) and the platform fee-payer minimum operating balance.

## Transaction lifecycle

Payments move through `CREATED`, `ROUTING`, `SUBMITTED`, `RECONCILING`,
`CONFIRMED`, or `FAILED`. A network ambiguity remains recoverable and keeps its
reservation until chain status is known. Transaction history is available via
`GET /v1/transactions` and `account.listTransactions()`.

Transaction history is cursor-paginated with `limit` (default 50, maximum 100)
and an opaque `cursor`; `account.listTransactionsPage()` exposes one page and
`account.listTransactions()` explicitly collects all pages for compatibility.
The cursor uses `(created_at, id)` ordering so new inserts do not create gaps or
duplicates in an existing traversal.

## Idempotency

`pay`, `send`, and `refund` require an idempotency key at the HTTP boundary.
The SDK accepts a caller key or generates one for the operation. Retries reuse
the same key and do not create a second logical payment. Conflicting reuse of a
key returns `409`. If a POST outcome is ambiguous, `PaymentPendingError` exposes
the same `idempotencyKey` and, when known, `paymentId`; poll or retry with that
key instead of creating a new one.

## Local development

```bash
pnpm install --frozen-lockfile
cp .env.example .env
docker compose up -d postgres
pnpm db:migrate
pnpm dev
```

## Local Solana integration test with Surfpool

The product integration suite uses isolated, offline Surfpool and PostgreSQL;
it does not fork mainnet or use an external faucet.

```bash
docker compose up -d postgres
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/agent_payment_account \
  pnpm db:migrate
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/agent_payment_account \
  pnpm test:solana
```

The suite performs real SPL transfers, incoming reconciliation, restart/replay
checks, and a managed-account refund through the HTTP API/SDK.

## Solana stack and signer roles

The adapter uses `@solana/kit` and official `@solana-program/token` and memo
primitives. The agent account signer is the SPL token authority; the separate
platform fee payer supplies SOL for network fees and ATA rent. The fee payer and
agent signer must not be the same key. Solana types remain inside the adapter,
not in core or the SDK public API.

## Mainnet safety

Mainnet is blocked unless both `SOLANA_CLUSTER=mainnet-beta` and
`ALLOW_MAINNET=true` are configured. The adapter validates RPC network identity
through genesis information, including custom RPC URLs. Automated tests always
use offline local Surfpool.

## Known product-v1 limitations

Product v1 supports one configured classic SPL settlement mint represented as
USD. It does not provide fiat custody, FX, card/bank rails, x402, off-ramp,
KYC/compliance tooling, HSM/MPC custody, frontend, or AI-agent orchestration.

## SDK usage

```ts
import { AgentPaymentAccount } from '@agent-payment/sdk'

const account = new AgentPaymentAccount({
  baseUrl: 'http://127.0.0.1:3000',
  apiKey: process.env.AGENT_PAYMENT_API_KEY ?? '',
})

const balance = await account.getBalance()
const payment = await account.pay(
  { recipientId: 'rcpt_preconfigured', amount: '0.50' },
  { idempotencyKey: 'technical-example-001' },
)

let current = payment
while (['CREATED', 'ROUTING', 'SUBMITTED', 'RECONCILING'].includes(current.status)) {
  await new Promise((resolve) => setTimeout(resolve, 500))
  current = await account.getPayment(current.id)
}

const transactions = await account.listTransactions()
console.log(balance.available, current.status, transactions.length)
```

The polling loop is explicit application code; the SDK does not silently poll.
The SDK package has no Solana dependency.

After startup, API workers recover bounded batches of pending outgoing payments
and reconcile incoming transfers. They are single-flight, stop accepting new
runs during shutdown, drain active runs, and only then disconnect PostgreSQL.

## Release / CI verification

The release gate creates a disposable PostgreSQL Compose project backed by
tmpfs, applies every migration to an empty database with `prisma migrate deploy`,
runs all PostgreSQL-backed tests, builds the workspace, and runs the offline
Surfpool E2E. It removes the disposable database on success or failure and
does not touch the normal developer volume.

```bash
pnpm install --frozen-lockfile
pnpm verify
```

`pnpm verify` is the final release gate. It provides `DATABASE_URL` itself, so
required PostgreSQL and Surfpool suites cannot be silently skipped.

If a payment remains `RECONCILING` beyond the normal confirmation window, do
not create a new idempotency key or manually send a second transfer. Poll the
payment and inspect the persisted expected transaction signature. An operator
may resolve it only after checking that signature on the configured cluster;
automatic recovery never creates a replacement transfer after an unknown
expired outcome.
