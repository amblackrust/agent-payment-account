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
  separate startup paths. API request correlation IDs, low-cardinality metrics,
  domain alerts, liveness/readiness, and domain health are exposed without
  putting resource identifiers in metric labels.
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

- `packages/contracts` contains canonical Zod contracts, but Fastify response
  schemas are still maintained separately. Generated schema output and an
  automated HTTP/SDK/webhook parity check are not yet present.

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
