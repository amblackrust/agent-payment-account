# Agent Payment Account

Developer-facing financial runtime for AI agents. Task 01 establishes the repository,
domain contracts, API skeleton, and local PostgreSQL runtime. It does not move money.

## Requirements

- Node.js 22 or newer
- pnpm 11 or newer
- Docker with Compose

## Local setup

```bash
pnpm install
cp .env.example .env
docker compose up -d postgres
pnpm db:migrate -- --name foundation
pnpm db:generate
pnpm dev
```

The API listens on `http://localhost:3000` by default. `GET /health` is a process
health check and `GET /ready` checks PostgreSQL connectivity.

## Verification

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

The Solana settlement configuration is defined now for later tasks. Mainnet requires
both `SOLANA_CLUSTER=mainnet-beta` and `ALLOW_MAINNET=true`; the default is safe localnet.
