# Operations

## Runtime roles

Production starts with one explicit `RUNTIME_ROLE`: `api`, `outgoing`,
`reconcile`, `incoming`, `webhook`, or `maintenance`. The API role does not
load the platform fee-payer secret, submit settlement effects, or decrypt
existing signer secrets. Development may use `RUNTIME_ROLE=all` for the local
compatibility runtime.

`ADMIN_API_KEY` is required only by the `api` (or development `all`) role;
dedicated workers must not receive that admin secret. Production still
requires the public `SOLANA_FEE_PAYER_IDENTITY` as part of the persisted
financial runtime identity, while the fee-payer secret remains restricted to
the outgoing role.

The platform-neutral topology, secret boundaries, promotion sequence, and
shutdown contract are in [deployment.md](./deployment.md).

Run the API and a dedicated worker from the API package after building:

```bash
pnpm --filter @agent-payment/api build
RUNTIME_ROLE=api pnpm --filter @agent-payment/api start
RUNTIME_ROLE=incoming pnpm --filter @agent-payment/api start:worker
RUNTIME_ROLE=outgoing pnpm --filter @agent-payment/api start:worker
RUNTIME_ROLE=reconcile pnpm --filter @agent-payment/api start:worker
RUNTIME_ROLE=webhook pnpm --filter @agent-payment/api start:worker
```

Use separate service identities and secret-manager-injected environments for
each deployment. Worker leases are durable; stopping a worker allows its
claims to expire and be recovered by another worker.

## x402 external payment proof

The x402 proof endpoint is an adapter over the ordinary V2 payment lifecycle;
it does not create a second payment engine. `POST
/v2/external-payments/x402` creates a normal payment with credential
authorization, approved-destination checks, spend policy, reservation,
attempt, custody, evidence, reconciliation, timeline, and history handling.

The adapter performs a live unauthenticated `GET` to the configured proof
resource and accepts only one x402 v2 exact requirement for Solana mainnet and
canonical USDC. Amount, recipient, and external fee-payer values are read from
that response and persisted in the prepared effect; they are never hardcoded.
The absolute proof spend cap is `100000` USDC atomic units (`$0.10`).

The Agent Account signs only its payer position in the durable Solana
transaction. The provider-advertised external fee payer/facilitator completes
and submits the transaction; it is not the Mux Agent Account and does not
replace the configured Mux platform fee payer used by the existing Solana
rail. Mux does not import or handle a personal wallet's seed/private key.

After a paid request, Mux requires both a successful x402 settlement response
and a confirmed/finalized Solana signature from RPC before finalizing the V2
payment. Transport errors, missing settlement headers, pending/failed
signatures, and RPC uncertainty remain `UNKNOWN`. Recovery reuses the durable
signed payload and never creates a fresh transaction solely because the prior
response was lost. The adapter does not create a missing recipient token
account automatically.

## Health

- `GET /health/live` checks only that the process is serving requests.
- `GET /health/ready` checks PostgreSQL and configured settlement dependencies.
- `GET /health/domain` reports worker/dependency degradation separately from
  process liveness.
- `GET /metrics` exposes low-cardinality process metrics. Resource IDs and
  secrets are intentionally excluded from metric labels.
- Prometheus installations can load
  [`ops/prometheus/mux-v2-alerts.yml`](../ops/prometheus/mux-v2-alerts.yml).
  The rules use the fixed-cardinality `mux_domain_alert_active` gauges and
  keep workflow/resource IDs out of labels.
- Alert thresholds are runtime configuration rather than metric labels:
  `REVIEW_REQUIRED_BACKLOG_ALERT_THRESHOLD`,
  `REVIEW_REQUIRED_AGE_ALERT_SECONDS`, `NO_PROGRESS_ALERT_SECONDS`,
  `DATABASE_SATURATION_ALERT_RATIO`, and
  `WEBHOOK_BACKLOG_ALERT_THRESHOLD`. The defaults are documented in
  [`.env.example`](../.env.example); production should inject them through
  the deployment configuration or secret/config backend.

## Encrypted backup and verified restore

Backups require `pg_dump` and `age`. The database URL and age material are
read only from environment variables; private custody keys are not exported
into the dump.

Create an encrypted custom-format backup:

```bash
BACKUP_AGE_RECIPIENT='age1...' \
  pnpm backup:create -- .local/backups/mux-$(date -u +%Y%m%dT%H%M%SZ).dump.age
```

Restore into an isolated PostgreSQL database and validate required tables,
runtime identity, payment/credential metadata, evidence and reservation links,
payment-attempt links, and the no-terminal-held-reservation invariant:

```bash
BACKUP_AGE_IDENTITY=/secure/restore/age-key.txt \
BACKUP_VERIFY_DATABASE_URL='postgresql://.../mux_restore' \
BACKUP_VERIFY_CUSTODY_IDENTITY='provider/key-reference' \
BACKUP_VERIFY_RUNTIME_AUTHORITY_ID='runtime-restore-20260917' \
BACKUP_VERIFY_ENVIRONMENT=isolated-restore \
  pnpm backup:verify -- .local/backups/mux-20260917T000000Z.dump.age
```

Do not point verification at production. A restored environment must remain
non-authoritative until its runtime identity, custody configuration, and new
runtime authority are validated. Verification leaves the durable
`money_worker_gate` blocked on failure and sets it to
`RESTORE_RECONCILIATION_REQUIRED` after local checks pass. Reconcile external
facts after the backup point, preserve evidence for any unprovable gap, then
complete the gate explicitly:

```bash
BACKUP_VERIFY_DATABASE_URL='postgresql://.../mux_restore' \
BACKUP_VERIFY_CUSTODY_IDENTITY='provider/key-reference' \
BACKUP_VERIFY_RUNTIME_AUTHORITY_ID='runtime-restore-20260917' \
BACKUP_VERIFY_ENVIRONMENT=isolated-restore \
  pnpm backup:complete-reconciliation -- restore-ticket-123
```

The command records the evidence reference and changes the gate to
`RESTORE_VERIFIED`. Configure the promoted outgoing runtime with the same
`RUNTIME_AUTHORITY_ID`, `RESTORE_GATE_REQUIRED=true`,
`RESTORE_GATE_ENVIRONMENT=isolated-restore`, and matching custody identity.
Start incoming reconciliation first, inspect the durable
`backup_restore_verifications` record, and only then enable outgoing workers.
The original authority must be fenced before promotion; a restored copy never
reuses its source authority ID.
Exact RPO/RTO and retention values remain workload/risk decisions (OD-008).

The maintenance role additionally requires `BACKUP_INTERVAL_SECONDS`,
`BACKUP_AGE_IDENTITY`, and `BACKUP_VERIFY_DATABASE_URL`; its backup cadence is
independent from the worker claim loop. The restore command rejects a target
that resolves to the same PostgreSQL backend as the source and rejects reusing
the source or restored snapshot's runtime authority.
