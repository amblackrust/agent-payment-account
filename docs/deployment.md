# Deployment and lifecycle

This repository deliberately documents the deployment boundary without selecting
an orchestration platform or custody vendor. Those choices remain OD-001 and
OD-003 decisions.

## Runtime topology

Deploy the following independently scalable roles against one PostgreSQL
coordination database:

- `api` — stateless HTTPS API. It owns no fee-payer or agent private-key
  material.
- `outgoing` — prepares, signs through the constrained custody boundary, and
  submits new settlement effects.
- `reconcile` — inspects submitted or unknown effects and records only
  authoritative outcomes. It does not create a replacement effect for an
  unresolved outcome and does not require the platform fee-payer secret.
- `incoming` — scans indexed accounts with durable cursors and bounded account
  concurrency.
- `webhook` — claims and delivers durable webhook events with bounded retries.
- `maintenance` — creates encrypted backups and runs isolated restore
  verification.

The roles share PostgreSQL leases, work-item state, rate limits, capacity
budgets, runtime identity, and restore-gate state. A second replica therefore
adds availability and throughput within the same durable limits; it does not
implicitly multiply a dependency budget.

## Perimeter and secret boundaries

- Terminate TLS at the selected ingress and forward only authenticated traffic
  to the API role.
- Inject `DATABASE_URL`, API credentials, runtime identity, custody identity,
  webhook keys, and backup age material from the deployment secret manager.
- Do not place private keys, decrypted wallet material, signed payloads, or
  recovery plaintext in PostgreSQL backups, API containers, logs, or metrics.
- Keep the external custody adapter behind the constrained signing contract.
  `LOCAL_TEST` is for development/test only; production requires an explicit
  `EXTERNAL` custody mode and a provider adapter selected under OD-003.
- Set a unique `RUNTIME_AUTHORITY_ID` per promoted authority. A restored copy
  must be fenced and assigned a new authority before money workers start.

## Health and shutdown

Expose `/health/live` for process liveness, `/health/ready` for PostgreSQL and
settlement dependency readiness, and `/health/domain` for workflow backlog and
dependency degradation. Worker processes expose the same endpoints while their
worker health is included in domain checks.

On shutdown, stop accepting work, stop the claim loop, drain the current safe
step, and close the Fastify and database resources. If a worker cannot finish a
durable step, its lease must expire and be recoverable by another worker; no
recovery-critical state may exist only in memory.

## Promotion and restore gate

1. Apply an additive migration and verify its status before starting a new
   binary.
2. Start API and read-only/incoming services against the intended database.
3. For a restore, decrypt into an isolated database, run
   `pnpm backup:verify`, inspect the durable verification record, and reconcile
   external facts after the backup point. Complete the gate with
   `complete-reconciliation <evidence-reference>` only after that review.
4. Fence the previous authority, validate runtime identity and custody
   association, and set `RESTORE_GATE_REQUIRED=true` for the promoted outgoing
   and reconcile roles.
5. Enable outgoing execution only after the restore gate is
   `RESTORE_VERIFIED`; leave unprovable effects in review/reconciliation.

Do not define exact backup frequency, retention, RPO, or RTO here. Those remain
the explicit OD-008 workload and risk decision. Record the chosen values in the
deployment control plane and the restore-drill evidence when that decision is
made.
