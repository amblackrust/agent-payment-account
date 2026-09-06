# Contributing

## Development Setup

Follow the [README Quick Start](README.md#quick-start) to install dependencies and prepare the local PostgreSQL and Solana environment. The generated `.env`, `.local/` keypairs, ledger, and database state must remain outside version control.

Use [Product](docs/product.md), [Architecture](docs/architecture.md), and the [API Reference](docs/api.md) to understand the current v1 boundaries before changing behavior.

## Making Changes

- Keep changes focused and preserve existing public API and financial semantics unless the change explicitly requires otherwise.
- Match the existing TypeScript, Fastify, Prisma, and workspace conventions.
- Do not log credentials, wallet secrets, database URLs, or RPC URLs containing secrets.
- Update the relevant document when a public route, command, configuration variable, lifecycle state, or product boundary changes.
- Avoid committing generated output, local validator state, `.env`, or dependencies.

## Database Changes

`pnpm db:migrate` is the migration-authoring command. Use it only when intentionally changing the Prisma schema, inspect the generated SQL, and commit the migration with the schema change.

`pnpm db:migrate:deploy` applies migrations already committed to the repository. `pnpm local:setup` uses this deployment path and must not author migrations.

Do not edit an already applied migration to disguise a new schema change.

## Verification

The repository provides these checks:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm verify
```

`pnpm verify` is the clean release gate. It creates a disposable PostgreSQL environment and runs the existing static, unit, build, and Solana integration checks against that isolated database. Run the checks appropriate to the change and report anything that could not be run.

## Pull Requests

A pull request should:

- explain the problem and the chosen solution;
- stay within one coherent scope;
- call out changes to APIs, configuration, migrations, custody, settlement, or mainnet behavior;
- include or update tests when behavior changes;
- include verification results and known limitations;
- contain no secrets, generated ledgers, local database data, or unrelated cleanup.

## Reporting Issues

Include reproduction steps, expected and actual behavior, relevant request IDs, and the affected Node.js, pnpm, PostgreSQL, and Solana environment. Redact API keys, wallet material, database credentials, private RPC URLs, and transaction data that should not be public.
