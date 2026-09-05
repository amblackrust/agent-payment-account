# End-to-end tests

The required product E2E lives with the API and Solana rail integration tests so
it can share the real PostgreSQL and offline Surfpool setup. Run it with:

```bash
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/agent_payment_account \
  pnpm test:solana
```

The scenario uses the public HTTP API and SDK, real SPL transfers, durable
reconciliation, and real refund execution. It does not use demo fixtures or a
fake production rail.
