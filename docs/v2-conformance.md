# V2 conformance status

This is the release-audit record for the current `v2` branch. It distinguishes
repository evidence from decisions or external evidence that cannot be created
inside this codebase.

## Implemented in the repository

- Exact atomic-unit and denomination-aware money contracts are shared by the
  core, database, API, SDK, and Solana rail packages.
- Payment policy, reservation, attempt, custody request, evidence,
  reconciliation, refund, timeline, exception, and webhook state are durable
  PostgreSQL-backed workflows.
- Work claims use durable leases and retry state. Database, RPC, custody, rail,
  and webhook capacity budgets use a shared PostgreSQL subject so replica count
  does not multiply the configured limit.
- API, outgoing, reconcile, incoming, webhook, and maintenance roles have
  separate startup paths. API request correlation IDs are carried through the
  payment, durable work item, worker, custody/rail payload, timeline, and
  webhook paths. Low-cardinality metrics, fixed-cardinality domain alerts,
  liveness/readiness, and domain health are exposed without putting resource
  identifiers in metric labels. Deployable Prometheus rules live in
  `ops/prometheus/mux-v2-alerts.yml`.
- The persisted financial runtime identity binds environment, rail and route
  versions, settlement asset and economic mapping versions, fee-payer public
  identity, and custody identity. Startup compares structured route identity,
  not only the primary rail and network strings.
- Legacy payment writes are routed through the V2 adapter in the production
  server path. The compatibility `PaymentService` class remains available for
  the migration window; its historical read-recovery behavior must be removed
  only after that window is explicitly closed.
- Encrypted backup creation, isolated restore checks, runtime identity
  reassociation, and the durable `money_worker_gate` are implemented. The
  platform-neutral deployment and restore procedure is documented in
  [deployment.md](./deployment.md) and [operations.md](./operations.md).
- V2 delegated credential issuance uses a durable request fingerprint and
  account-scoped idempotency record, stores only a verification hash plus an
  encrypted short-lived recovery envelope, and exposes an idempotent recovery
  acknowledgement command.

## Evidence currently available

The repository test suites cover unit, API, worker, SDK, database, migration,
and Solana-rail behavior. The current audit also requires the clean execution
of the repository `format:check`, `lint`, `typecheck`, `build`, full test suite,
and database-enabled test suite before release tagging. Results belong in the
release record rather than being inferred from source inspection.

## Known implementation gaps under review

The following items are concrete repository findings, not silently accepted
scope reductions:

- `packages/contracts/src/v2-http.ts` now generates the Draft-07 HTTP schemas
  from the canonical Zod contracts, and the API imports those generated
  documents through `apps/api/src/v2-response-schemas.ts`. The credential and
  payment contracts have direct contract tests. Some route-local wrappers
  remain intentionally local because they apply runtime-configured limits
  such as the maximum page size; those wrappers must not redefine money,
  status, error, or credential semantics.

## TASK-029..035 and TASK-039 audit

The following evidence is scoped to the Solana rail boundary and the runtime
operations requested by the implementation plan:

- TASK-029: `packages/solana-rail/src/payment.ts`,
  `packages/solana-rail/src/v2-outgoing.ts`, `read.ts`, and `incoming.ts`
  keep cluster/mint validation, bounded RPC calls, exact signed-payload
  persistence/resend, and authoritative reconciliation inside the rail
  adapter. Production custody remains an explicit boundary; no provider is
  selected here.
- TASK-030: `apps/api/src/observability.ts` and `apps/api/src/app.ts` provide
  redacted structured request logging, low-cardinality metrics, fixed-cardinality
  domain alert gauges with validated runtime-configurable thresholds, deployable
  Prometheus rules, and separate
  liveness/readiness/domain endpoints. Payment correlation is persisted through
  durable work, worker/custody/rail execution, timeline, webhook, and operator
  resolution events. Production alert-rule reload and failure-campaign evidence
  remain operational verification items.
- TASK-031: `apps/api/src/config.ts`, `server.ts`, `worker.ts`, and
  `runtime-identity.ts` enforce explicit role, mainnet, secret-source, custody,
  authority, fee-payer, route, asset, and economic-mapping configuration. The
  dedicated API initializes the persisted financial identity without decrypting
  legacy signer plaintext; workers fail closed when their structured identity
  differs from the durable record.
- TASK-032: the role-specific entrypoints, durable leases, health routes, and
  shutdown handling are in `apps/api/src/server.ts` and `worker.ts`. No
  orchestration manifest or CI deployment pipeline is claimed; the repository
  deliberately remains platform-neutral pending the deployment decision.
- TASK-033: `packages/db/prisma-preflight.mjs`, migration deploy scripts, and
  `packages/db/src/legacy-backfill.integration.test.ts` provide duplicate
  checks, repeatable migration execution, and conservative legacy mapping.
  Production-sized snapshot/backfill evidence is still an operational gate.
- TASK-034: `scripts/backup-verify.mjs`, `restore-safety.mjs`, and the
  maintenance runtime now require an explicit backup cadence and isolated
  verification material, create missing output directories, compare actual
  PostgreSQL backend identities, and reject reusing the source/restored runtime
  authority. A real restore drill and OD-008 RPO/RTO/retention values still
  require controlled infrastructure.
- TASK-035/TASK-039: repository regression commands and the exact changed-file
  evidence are recorded at handoff. Worker-kill, DB-restart, real custody, and
  paid external proof cannot be represented by unit tests in this workspace.

## Scoped dependency security remediation

The production audit findings were addressed without changing Prisma's major
version: the Prisma tooling transitive `deepmerge-ts` dependency is pinned to
the patched 8.0.0 release, and `mysql2` is pinned to patched 3.23.1. The former
is a major transitive override, so it is recorded separately from application
feature work and is guarded by Prisma schema validation, client generation,
typechecking, and the full test suite. Prisma itself remains on stable 7.10.0;
no release-candidate or unrelated major upgrade was introduced.

## Gated or external evidence

- Production outgoing execution is gated on the OD-003 custody backend and its
  provider adapter. The repository intentionally does not select a vendor or
  pretend that the local test signer is production custody.
- TASK-038 remains blocked until the operator supplies an OD-009 target that is
  independent, genuinely paid, and authorized for a real end-to-end proof.
  No target, credential, paid request, or proof artifact is invented here.
- TASK-036 and TASK-037 remain conditional on the selected external proof or an
  explicit OD-005/OD-006 decision.
- A production restore drill, production-sized migration snapshot, worker-kill
  campaign, database restart campaign, and external custody/rail proof require
  controlled infrastructure and must be recorded with their artifacts.

## Open decisions

OD-001 deployment model, OD-002 maximum precision, OD-003 custody backend,
OD-004 unresolved-reservation release policy, OD-005 second rail, OD-006
protocol adapter, OD-007 tenant-visible diagnostics, OD-008 RPO/RTO, and OD-009
the external payment-proof target remain explicit. This document records those
gates; it does not silently choose product or infrastructure behavior for them.
