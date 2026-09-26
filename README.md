# Mux

Mux is a custodial payment runtime for AI-agent applications: an HTTP API and TypeScript SDK for programmable accounts, policy-controlled payments, and durable Solana settlement.

[Quick start](#quick-start) · [Architecture](#architecture) · [API reference](docs/api.md) · [Development](#local-development)

## Quick Start

Requirements: Node.js 22+, pnpm 11+, Docker Compose, the Solana CLI
(`solana-keygen` and `solana-test-validator`), and `spl-token`.

```bash
pnpm install --frozen-lockfile
pnpm local:setup
pnpm dev
```

In another terminal, check readiness:

```bash
curl http://127.0.0.1:3000/ready
pnpm local:status
```

The readiness endpoint returns `{"status":"ok"}` when the API and its
dependencies are ready. `pnpm local:setup` creates an isolated localnet,
PostgreSQL database, test mint, and local-only secrets. It uses no mainnet,
real funds, or external faucet; `.env` and generated keys are Git-ignored.

## Problem

Giving an agent a raw blockchain wallet also gives it responsibility for RPC calls, token accounts, mint decimals, transaction construction, signing, retries, confirmation, and reconciliation. Those concerns make ordinary tasks such as checking a balance or paying a known recipient chain-specific and difficult to recover safely.

## Solution

Mux exposes an account-oriented model: balances, recipients, `pay`, `send`, `receive`, refunds, payment status, and transaction history. The backend owns the managed signer, persists the payment lifecycle, reserves outgoing funds, submits settlement transactions, and reconciles ambiguous or incoming activity.

## Why Solana

Solana is the settlement rail in the current implementation, not a detail the agent must operate directly. Every Agent Account has a real Solana signer, and confirmed payments correspond to classic SPL Token transfers of one configured mint. Mux constructs and signs those transactions, pays network fees from a separate platform fee payer, and ties confirmation and reconciliation to on-chain transaction state.

The custody boundary is intentionally narrow:

- account signers are managed by the backend;
- signer secrets are encrypted with `WALLET_MASTER_KEY`, but this prototype does not use an HSM or MPC;
- one classic SPL settlement mint is configured for the runtime;
- the public `USD` contract is a normalized accounting interface, not fiat custody, an FX service, or a claim that every configured mint is redeemable for dollars.

## Features

- Agent Account creation with one-time API credentials, hashed credential storage, rotation, and revocation
- Encrypted per-account Solana signer custody and a separate platform fee payer
- Settled, pending-outgoing, and available balance reads
- Account-owned recipients for external or managed Solana destinations
- Idempotent `pay`, `send`, and managed-account refund operations
- Durable reservations, attempts, confirmation, recovery, and reconciliation
- Canonical V2 exact-money contracts with policy, approval, evidence, and
  operator-control projections; `/v1` payment routes remain compatibility
  adapters into the same durable workflow
- V2 delegated credentials with idempotent issuance and short-lived encrypted
  recovery envelopes
- x402 v2 protocol adapter integrated with the regular payment lifecycle
- A local fake x402 service for acceptance tests; it never substitutes for MUX
  custody or settlement
- Persistent receive requests and discovery of incoming SPL transfers
- Payment lookup plus cursor-paginated payment and transaction history
- TypeScript SDK for the agent-facing account operations
- Automated local PostgreSQL, Solana validator, fee payer, and test-mint setup
- Explicit mainnet opt-in and runtime network/mint validation

## Architecture

```mermaid
flowchart LR
  Agent[Agent application] --> Client[Mux SDK or HTTP API]
  Client --> API[Fastify API]
  API --> Runtime[Payment runtime]
  Runtime --> DB[(PostgreSQL)]
  Runtime --> Custody[Managed signer custody]
  Runtime --> Rail[Solana settlement rail]
  Workers[Reconciliation workers] <--> DB
  Workers <--> Rail
  Custody --> Rail
  Rail --> RPC[Solana RPC / network]
```

See [Architecture](docs/architecture.md) for component boundaries, payment states, custody, and reconciliation.

## Fake x402 Proof on Solana Devnet

The devnet E2E test uses a dedicated PostgreSQL database. After
`pnpm local:setup` starts PostgreSQL, create and migrate that database once
(skip database creation if it already exists):

```bash
docker compose exec -T postgres createdb -U postgres agent_payment_devnet_x402
DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:5432/agent_payment_devnet_x402?schema=public' pnpm db:migrate:deploy
```

Run the test with that database URL:

```bash
DEVNET_X402_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:5432/agent_payment_devnet_x402?schema=public' \
  pnpm test:e2e:devnet-x402
```

The test persists devnet accounts and payments for inspection. It refuses the
local application's `DATABASE_URL` and does not fall back to it. The test
requires public devnet RPC and faucet availability.

The test starts a separate local fake x402 service and performs a real SPL token
transfer on Solana devnet using a generated `TEST_USDC` mint with no economic
value. The fake service charges `0.001 TEST_USDC` and returns a deterministic
fixture (`bitcoin.usd: 60000`) only after verifying the confirmed devnet
transaction. It does not call x402engine or any other paid API, and it does not
use mainnet funds.

When finished, stop local infrastructure without deleting its state:

```bash
pnpm local:down
```

## SDK Usage

The following example uses the `/v1` compatibility API. Create an Agent
Account with the admin API; its API key is returned once. The generated `.env`
is loaded by project commands, but shell variables are not modified. Load only
the admin key before the manual request.

Bash or zsh:

```bash
export ADMIN_API_KEY="$(node scripts/run-with-root-env.mjs --require=ADMIN_API_KEY node -e 'process.stdout.write(process.env.ADMIN_API_KEY ?? "")')"
```

Fish:

```fish
set -gx ADMIN_API_KEY (node scripts/run-with-root-env.mjs --require=ADMIN_API_KEY node -e 'process.stdout.write(process.env.ADMIN_API_KEY ?? "")')
```

Then create the account:

```bash
curl -X POST http://127.0.0.1:3000/v1/accounts \
  -H "x-admin-api-key: $ADMIN_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"name":"research-agent"}'
```

The response contains an `api_key` shown once. Use it with the workspace SDK:

```ts
import { AgentPaymentAccount } from '@agent-payment/sdk'

const account = new AgentPaymentAccount({
  baseUrl: 'http://127.0.0.1:3000',
  apiKey: process.env.AGENT_API_KEY!,
})

const balance = await account.getBalance()
const payment = await account.pay(
  {
    recipientId: 'rcpt_...',
    amount: '0.50',
    description: 'dataset access',
  },
  { idempotencyKey: 'order-123-payment' },
)
```

An HTTP `200` or `201` is not proof of blockchain confirmation. Treat only a payment with `status: "CONFIRMED"` as confirmed; poll `getPayment()` when a result remains `RECONCILING`.

## Local Development

Root project commands load the checkout's root `.env` explicitly, even when pnpm runs tooling from a workspace directory. Root `.env` values for project configuration take precedence over stale shell values; system variables such as `PATH`, `HOME`, and temporary-directory settings are preserved.

Useful commands:

| Command                  | Purpose                                                                             |
| ------------------------ | ----------------------------------------------------------------------------------- |
| `pnpm local:setup`       | Create or restart the preserved local environment and deploy committed migrations   |
| `pnpm local:status`      | Report PostgreSQL, Solana, mint, fee-payer, and API status without printing secrets |
| `pnpm local:down`        | Stop only this checkout's local infrastructure while preserving state               |
| `pnpm db:migrate`        | Author a new Prisma migration during schema development                             |
| `pnpm db:migrate:deploy` | Apply already committed migrations                                                  |
| `pnpm build`             | Build all workspace packages                                                        |
| `pnpm typecheck`         | Type-check all workspace packages                                                   |
| `pnpm lint`              | Run ESLint                                                                          |
| `pnpm test`              | Run the Vitest suite                                                                |

### Configuration

See [`.env.example`](.env.example) for safe manual defaults and accepted secret formats.

| Variable                          | Purpose                                                                  |
| --------------------------------- | ------------------------------------------------------------------------ |
| `DATABASE_URL`                    | PostgreSQL connection URL                                                |
| `PORT`                            | API port; defaults to `3000`                                             |
| `NODE_ENV`                        | `development`, `test`, or `production`                                   |
| `ADMIN_API_KEY`                   | Administrative account and credential authentication                     |
| `SOLANA_RPC_URL`                  | RPC endpoint for the configured cluster                                  |
| `SOLANA_CLUSTER`                  | `localnet`, `devnet`, `testnet`, or `mainnet-beta`                       |
| `SOLANA_SETTLEMENT_MINT`          | One classic SPL mint used for settlement                                 |
| `SOLANA_PLATFORM_COST_ASSET_ID`   | Explicit asset identity for durable SOL fee/rent cost records            |
| `SOLANA_FEE_PAYER_SECRET`         | Separate platform fee-payer signer secret                                |
| `X402_RESOURCE_URL`               | Resource URL; the devnet test uses its local fake service                |
| `X402_HTTP_TIMEOUT_MS`            | x402 discovery/resource request timeout                                  |
| `X402_MAX_PAYMENT_ATOMIC`         | x402 token atomic-unit cap; `$0.10` only for mainnet USDC at the maximum |
| `WALLET_MASTER_KEY`               | 32-byte key used to encrypt managed signer secrets                       |
| `CREDENTIAL_RECOVERY_TTL_SECONDS` | Encrypted credential-recovery lifetime; defaults to 900 seconds          |
| `ALLOW_MAINNET`                   | Additional explicit mainnet opt-in; defaults to `false`                  |

Request abuse protection is durable and shared across API replicas. The
`REQUEST_RATE_LIMIT_*` variables control the per-client rolling window and
short burst bucket; payment and receive mutation limits remain separate from
these HTTP limits.

For a custom RPC, devnet, or testnet, create `.env` from `.env.example` and supply a mint and funded fee payer belonging to that cluster. Do not use `local:setup` to prepare a custom network. Mainnet is never part of Quick Start and requires both `SOLANA_CLUSTER=mainnet-beta` and `ALLOW_MAINNET=true`.

Root `.env` loading is for local development only. Production must supply
secrets through the configured secret backend; the local dotenv helper rejects
production mode.

## Repository map

```text
apps/api/              ⚙️  Fastify API and payment workers
packages/contracts/    📐 Shared API and domain contracts
packages/core/         🧠 Money, policy, routing, and lifecycle logic
packages/db/           🗄️  Prisma schema, migrations, and repositories
packages/sdk/          🧩 TypeScript client for agent applications
packages/solana-rail/  ⛓️  Solana transaction and settlement boundary
tests/fake-x402/       🧪  Separate local paid-resource test service
ops/prometheus/        📈 Alert rules
```

## Documentation

- [Product model](docs/product.md) — users, mental model, v1 scope, and non-goals
- [Architecture](docs/architecture.md) — components, lifecycle, custody, data, and trust boundaries
- [API Reference](docs/api.md) — authentication, routes, payloads, statuses, and errors
- [Operations](docs/operations.md) — runtime roles, health, backup, and restore gate
- [Deployment](docs/deployment.md) — platform-neutral topology and secret boundaries
- [Roadmap](docs/roadmap.md) — implemented scope and explicitly uncommitted future directions

## Current Scope and Limitations

- The runtime is custodial and stores encrypted signer material in PostgreSQL.
- V2 exposes exact denomination-bound amounts; the current deployment still
  activates one classic SPL settlement route. V1 remains a fixed-two-decimal
  `USD` compatibility contract.
- Refunds are supported only when the original recipient is another managed account and the reverse destination is known.
- External recipient token accounts must already exist; sponsored associated-token-account creation is limited to verified managed recipients.
- V1 is a compatibility surface, not a claim of fiat custody or banking. Cards,
  bank rails, FX, off-ramp, KYC, a browser UI, and agent orchestration are not
  implemented.
- The automated x402 acceptance path uses a local fake provider and valueless
  `TEST_USDC` on devnet. No real third-party paid-service or mainnet proof is
  claimed.
- This repository does not claim HSM/MPC custody or an external security audit.

## License

Copyright (c) 2026 amblackrust. All rights reserved. The source is publicly
viewable, but no permission is granted to use, copy, modify, or distribute it
without prior written permission. See [LICENSE](LICENSE).
