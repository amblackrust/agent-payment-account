-- V2 is an additive expansion. Existing payment facts remain readable and
-- legacy writers continue to use their columns during the migration window.

ALTER TYPE "AgentAccountStatus" ADD VALUE IF NOT EXISTS 'PROVISIONING';
ALTER TYPE "AgentAccountStatus" ADD VALUE IF NOT EXISTS 'PROVISIONING_FAILED';
ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'AWAITING_APPROVAL';
ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'REJECTED_BY_POLICY';
ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'REJECTED';
ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'PROVED_NO_EFFECT';
ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'REVIEW_REQUIRED';
ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'CLOSED_UNRESOLVED';
ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'EXPIRED';
CREATE TYPE "AgentCredentialStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'REVOKED', 'ROTATING');

ALTER TABLE "agent_accounts"
  ADD COLUMN "workspace_id" VARCHAR(64),
  ADD COLUMN "runtime_version" VARCHAR(64),
  ADD COLUMN "provisioning_failure_code" VARCHAR(128),
  ADD COLUMN "disabled_at" TIMESTAMP(3),
  ADD COLUMN "disabled_reason" TEXT,
  ADD COLUMN "row_version" INTEGER NOT NULL DEFAULT 1;
CREATE INDEX "agent_accounts_workspace_id_idx" ON "agent_accounts"("workspace_id");

ALTER TABLE "api_credentials"
  ADD COLUMN "status" "AgentCredentialStatus" NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "scopes" TEXT NOT NULL DEFAULT '[]',
  ADD COLUMN "expires_at" TIMESTAMP(3),
  ADD COLUMN "rotated_from_id" VARCHAR(64),
  ADD COLUMN "row_version" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "recipients"
  ADD COLUMN "archived_at" TIMESTAMP(3),
  ADD COLUMN "row_version" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "payments"
  ADD COLUMN "denomination_id" VARCHAR(64),
  ADD COLUMN "amount_scale" INTEGER,
  ADD COLUMN "route_id" VARCHAR(64),
  ADD COLUMN "route_selection_reason" VARCHAR(64),
  ADD COLUMN "settlement_asset_id" VARCHAR(64),
  ADD COLUMN "destination_snapshot_json" TEXT,
  ADD COLUMN "policy_decision_id" VARCHAR(64),
  ADD COLUMN "approval_id" VARCHAR(64),
  ADD COLUMN "execution_state" VARCHAR(32) NOT NULL DEFAULT 'NOT_STARTED',
  ADD COLUMN "settlement_state" VARCHAR(32) NOT NULL DEFAULT 'NOT_SUBMITTED',
  ADD COLUMN "outcome_state" VARCHAR(32) NOT NULL DEFAULT 'NONE',
  ADD COLUMN "row_version" INTEGER NOT NULL DEFAULT 1;
CREATE INDEX "payments_payer_account_id_denomination_id_created_at_idx"
  ON "payments"("payer_account_id", "denomination_id", "created_at");
CREATE INDEX "payments_policy_decision_id_idx" ON "payments"("policy_decision_id");

ALTER TABLE "payment_attempts"
  ADD COLUMN "outcome" VARCHAR(32) NOT NULL DEFAULT 'NOT_STARTED',
  ADD COLUMN "route_id" VARCHAR(64),
  ADD COLUMN "prepared_effect_hash" CHAR(64),
  ADD COLUMN "signed_payload_hash" CHAR(64),
  ADD COLUMN "signed_payload_encrypted" TEXT,
  ADD COLUMN "validity_expires_at" TIMESTAMP(3),
  ADD COLUMN "validity_slot" BIGINT,
  ADD COLUMN "row_version" INTEGER NOT NULL DEFAULT 1;
DROP INDEX IF EXISTS "payment_attempts_payment_id_key";

ALTER TABLE "idempotency_records"
  ADD COLUMN "fingerprint" CHAR(64),
  ADD COLUMN "response_snapshot" TEXT,
  ADD COLUMN "expires_at" TIMESTAMP(3);

ALTER TABLE "outgoing_reservations"
  ADD COLUMN "lifecycle_state" VARCHAR(16) NOT NULL DEFAULT 'HELD',
  ADD COLUMN "release_reason" VARCHAR(128),
  ADD COLUMN "consumed_at" TIMESTAMP(3),
  ADD COLUMN "row_version" INTEGER NOT NULL DEFAULT 1;

CREATE TABLE "denominations" (
  "id" VARCHAR(64) NOT NULL,
  "symbol" VARCHAR(32) NOT NULL,
  "max_scale" INTEGER NOT NULL,
  "status" VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "denominations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "denominations_symbol_version_key" ON "denominations"("symbol", "version");

CREATE TABLE "settlement_assets" (
  "id" VARCHAR(64) NOT NULL,
  "rail" VARCHAR(64) NOT NULL,
  "network" VARCHAR(64) NOT NULL,
  "asset_reference" VARCHAR(255) NOT NULL,
  "decimals" INTEGER NOT NULL,
  "status" VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "settlement_assets_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "settlement_assets_rail_network_asset_reference_version_key"
  ON "settlement_assets"("rail", "network", "asset_reference", "version");

CREATE TABLE "economic_mappings" (
  "id" VARCHAR(64) NOT NULL,
  "denomination_id" VARCHAR(64) NOT NULL,
  "settlement_asset_id" VARCHAR(64) NOT NULL,
  "numerator" BIGINT NOT NULL,
  "denominator" BIGINT NOT NULL,
  "status" VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "economic_mappings_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "economic_mappings_denomination_id_status_idx" ON "economic_mappings"("denomination_id", "status");
CREATE INDEX "economic_mappings_settlement_asset_id_status_idx" ON "economic_mappings"("settlement_asset_id", "status");

CREATE TABLE "settlement_routes" (
  "id" VARCHAR(64) NOT NULL,
  "rail" VARCHAR(64) NOT NULL,
  "rail_version" VARCHAR(64) NOT NULL,
  "network" VARCHAR(64) NOT NULL,
  "settlement_asset_id" VARCHAR(64) NOT NULL,
  "economic_mapping_id" VARCHAR(64) NOT NULL,
  "status" VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  "priority" INTEGER NOT NULL DEFAULT 0,
  "config_version" VARCHAR(64) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "settlement_routes_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "settlement_routes_status_priority_id_idx" ON "settlement_routes"("status", "priority", "id");

CREATE TABLE "spend_policies" (
  "id" VARCHAR(64) NOT NULL,
  "account_id" VARCHAR(64) NOT NULL,
  "version" INTEGER NOT NULL,
  "status" VARCHAR(16) NOT NULL DEFAULT 'DRAFT',
  "denomination_id" VARCHAR(64) NOT NULL,
  "max_per_payment_atomic" BIGINT,
  "rolling_budget_atomic" BIGINT,
  "rolling_window_seconds" INTEGER,
  "transaction_count_cap" INTEGER,
  "approval_threshold_atomic" BIGINT,
  "rolling_budget_escalatable" BOOLEAN NOT NULL DEFAULT false,
  "transaction_count_escalatable" BOOLEAN NOT NULL DEFAULT false,
  "rules_json" TEXT NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "activated_at" TIMESTAMP(3),
  "retired_at" TIMESTAMP(3),
  CONSTRAINT "spend_policies_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "spend_policies_account_id_version_key" ON "spend_policies"("account_id", "version");
CREATE INDEX "spend_policies_account_id_status_idx" ON "spend_policies"("account_id", "status");
CREATE UNIQUE INDEX "spend_policies_one_active_per_account_key"
  ON "spend_policies"("account_id") WHERE "status" = 'ACTIVE';

CREATE TABLE "policy_decisions" (
  "id" VARCHAR(64) NOT NULL,
  "payment_id" VARCHAR(64) NOT NULL,
  "account_id" VARCHAR(64) NOT NULL,
  "policy_id" VARCHAR(64) NOT NULL,
  "policy_version" INTEGER NOT NULL,
  "decision" VARCHAR(32) NOT NULL,
  "reason_codes_json" TEXT NOT NULL,
  "context_json" TEXT NOT NULL,
  "fingerprint" CHAR(64) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "policy_decisions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "policy_decisions_payment_id_key" ON "policy_decisions"("payment_id");
CREATE INDEX "policy_decisions_account_id_created_at_idx" ON "policy_decisions"("account_id", "created_at");

CREATE TABLE "approved_destinations" (
  "id" VARCHAR(64) NOT NULL,
  "account_id" VARCHAR(64) NOT NULL,
  "fingerprint" CHAR(64) NOT NULL,
  "rail" VARCHAR(64) NOT NULL,
  "network" VARCHAR(64) NOT NULL,
  "asset_reference" VARCHAR(255) NOT NULL,
  "destination" VARCHAR(255) NOT NULL,
  "status" VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  "actor_id" VARCHAR(128) NOT NULL,
  "reason" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revoked_at" TIMESTAMP(3),
  CONSTRAINT "approved_destinations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "approved_destinations_account_id_fingerprint_key" ON "approved_destinations"("account_id", "fingerprint");
CREATE INDEX "approved_destinations_account_id_status_idx" ON "approved_destinations"("account_id", "status");

CREATE TABLE "approvals" (
  "id" VARCHAR(64) NOT NULL,
  "payment_id" VARCHAR(64) NOT NULL,
  "account_id" VARCHAR(64) NOT NULL,
  "fingerprint" CHAR(64) NOT NULL,
  "policy_decision_id" VARCHAR(64) NOT NULL,
  "status" VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  "expires_at" TIMESTAMP(3) NOT NULL,
  "actor_id" VARCHAR(128),
  "comment" TEXT,
  "row_version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decided_at" TIMESTAMP(3),
  CONSTRAINT "approvals_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "approvals_payment_id_key" ON "approvals"("payment_id");
CREATE INDEX "approvals_account_id_status_expires_at_idx" ON "approvals"("account_id", "status", "expires_at");

CREATE TABLE "durable_work_items" (
  "id" VARCHAR(64) NOT NULL,
  "kind" VARCHAR(64) NOT NULL,
  "resource_type" VARCHAR(64) NOT NULL,
  "resource_id" VARCHAR(64) NOT NULL,
  "status" VARCHAR(16) NOT NULL DEFAULT 'AVAILABLE',
  "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lease_owner" VARCHAR(128),
  "lease_expires_at" TIMESTAMP(3),
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "max_attempts" INTEGER NOT NULL DEFAULT 10,
  "last_error_code" VARCHAR(128),
  "last_error_safe" TEXT,
  "retry_after" TIMESTAMP(3),
  "payload_json" TEXT NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "completed_at" TIMESTAMP(3),
  CONSTRAINT "durable_work_items_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "durable_work_items_kind_resource_type_resource_id_key" ON "durable_work_items"("kind", "resource_type", "resource_id");
CREATE INDEX "durable_work_items_status_available_at_lease_expires_at_idx" ON "durable_work_items"("status", "available_at", "lease_expires_at");

CREATE TABLE "evidence_records" (
  "id" VARCHAR(64) NOT NULL,
  "payment_id" VARCHAR(64) NOT NULL,
  "attempt_id" VARCHAR(64),
  "authority" VARCHAR(64) NOT NULL,
  "source" VARCHAR(64) NOT NULL,
  "outcome" VARCHAR(32) NOT NULL,
  "observed_at" TIMESTAMP(3) NOT NULL,
  "external_id" VARCHAR(255),
  "expected_external_id" VARCHAR(255),
  "payload_hash" CHAR(64),
  "provider_correlation" VARCHAR(255),
  "metadata_json" TEXT NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "evidence_records_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "evidence_records_payment_id_observed_at_idx" ON "evidence_records"("payment_id", "observed_at");
CREATE INDEX "evidence_records_attempt_id_observed_at_idx" ON "evidence_records"("attempt_id", "observed_at");

CREATE TABLE "custody_key_versions" (
  "id" VARCHAR(64) NOT NULL,
  "account_id" VARCHAR(64),
  "key_version" INTEGER NOT NULL,
  "backend_identity" VARCHAR(128) NOT NULL,
  "key_reference" VARCHAR(255) NOT NULL,
  "root_key_fingerprint" CHAR(64) NOT NULL,
  "status" VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "retired_at" TIMESTAMP(3),
  CONSTRAINT "custody_key_versions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "custody_key_versions_account_id_key_version_key" ON "custody_key_versions"("account_id", "key_version");
CREATE INDEX "custody_key_versions_status_idx" ON "custody_key_versions"("status");

CREATE TABLE "signing_requests" (
  "id" VARCHAR(64) NOT NULL,
  "payment_id" VARCHAR(64) NOT NULL,
  "attempt_id" VARCHAR(64) NOT NULL,
  "effect_hash" CHAR(64) NOT NULL,
  "route_id" VARCHAR(64) NOT NULL,
  "network" VARCHAR(64) NOT NULL,
  "asset_reference" VARCHAR(255) NOT NULL,
  "destination" VARCHAR(255) NOT NULL,
  "amount_atomic" BIGINT NOT NULL,
  "fee_payer_identity" VARCHAR(255) NOT NULL,
  "key_version" INTEGER NOT NULL,
  "status" VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  "service_identity" VARCHAR(255) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMP(3),
  CONSTRAINT "signing_requests_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "signing_requests_attempt_id_key" ON "signing_requests"("attempt_id");
CREATE INDEX "signing_requests_payment_id_created_at_idx" ON "signing_requests"("payment_id", "created_at");

CREATE TABLE "operation_timeline_events" (
  "id" VARCHAR(64) NOT NULL,
  "account_id" VARCHAR(64),
  "resource_type" VARCHAR(64) NOT NULL,
  "resource_id" VARCHAR(64) NOT NULL,
  "event_type" VARCHAR(128) NOT NULL,
  "actor_type" VARCHAR(64) NOT NULL,
  "actor_id" VARCHAR(255),
  "request_id" VARCHAR(255),
  "correlation_id" VARCHAR(255),
  "old_state_json" TEXT,
  "new_state_json" TEXT,
  "source" VARCHAR(64) NOT NULL,
  "occurred_at" TIMESTAMP(3) NOT NULL,
  "metadata_json" TEXT NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "operation_timeline_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "operation_timeline_events_account_id_occurred_at_id_idx" ON "operation_timeline_events"("account_id", "occurred_at", "id");
CREATE INDEX "operation_timeline_events_resource_type_resource_id_occurred_at_idx" ON "operation_timeline_events"("resource_type", "resource_id", "occurred_at");

CREATE TABLE "platform_cost_records" (
  "id" VARCHAR(64) NOT NULL,
  "account_id" VARCHAR(64) NOT NULL,
  "payment_id" VARCHAR(64),
  "attempt_id" VARCHAR(64),
  "asset_id" VARCHAR(64) NOT NULL,
  "estimated_amount" BIGINT NOT NULL,
  "actual_amount" BIGINT,
  "reconciliation_status" VARCHAR(32) NOT NULL DEFAULT 'ESTIMATED',
  "observed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "platform_cost_records_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "platform_cost_records_account_id_created_at_idx" ON "platform_cost_records"("account_id", "created_at");
CREATE INDEX "platform_cost_records_payment_id_idx" ON "platform_cost_records"("payment_id");

CREATE TABLE "operational_exceptions" (
  "id" VARCHAR(64) NOT NULL,
  "account_id" VARCHAR(64),
  "resource_type" VARCHAR(64) NOT NULL,
  "resource_id" VARCHAR(64) NOT NULL,
  "dedupe_key" VARCHAR(255) NOT NULL,
  "active_dedupe_key" VARCHAR(255),
  "status" VARCHAR(32) NOT NULL DEFAULT 'OPEN',
  "severity" VARCHAR(16) NOT NULL DEFAULT 'ERROR',
  "reason_code" VARCHAR(128) NOT NULL,
  "details_json" TEXT NOT NULL DEFAULT '{}',
  "assigned_to" VARCHAR(255),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "acknowledged_at" TIMESTAMP(3),
  "resolved_at" TIMESTAMP(3),
  CONSTRAINT "operational_exceptions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "operational_exceptions_active_dedupe_key_key" ON "operational_exceptions"("active_dedupe_key");
CREATE INDEX "operational_exceptions_status_severity_created_at_idx" ON "operational_exceptions"("status", "severity", "created_at");
CREATE INDEX "operational_exceptions_resource_type_resource_id_idx" ON "operational_exceptions"("resource_type", "resource_id");

CREATE TABLE "webhook_subscriptions" (
  "id" VARCHAR(64) NOT NULL,
  "account_id" VARCHAR(64) NOT NULL,
  "endpoint" VARCHAR(2048) NOT NULL,
  "event_types_json" TEXT NOT NULL,
  "status" VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  "signing_key_ref" VARCHAR(255) NOT NULL,
  "signing_key_version" INTEGER NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "archived_at" TIMESTAMP(3),
  CONSTRAINT "webhook_subscriptions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "webhook_subscriptions_account_id_status_idx" ON "webhook_subscriptions"("account_id", "status");

CREATE TABLE "webhook_events" (
  "id" VARCHAR(64) NOT NULL,
  "event_id" VARCHAR(128) NOT NULL,
  "resource_type" VARCHAR(64) NOT NULL,
  "resource_id" VARCHAR(64) NOT NULL,
  "resource_version" INTEGER NOT NULL,
  "event_type" VARCHAR(128) NOT NULL,
  "event_version" VARCHAR(32) NOT NULL,
  "raw_body" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "webhook_events_event_id_key" ON "webhook_events"("event_id");
CREATE INDEX "webhook_events_resource_type_resource_id_created_at_idx" ON "webhook_events"("resource_type", "resource_id", "created_at");

CREATE TABLE "webhook_deliveries" (
  "id" VARCHAR(64) NOT NULL,
  "event_id" VARCHAR(128) NOT NULL,
  "subscription_id" VARCHAR(64) NOT NULL,
  "delivery_number" INTEGER NOT NULL,
  "status" VARCHAR(16) NOT NULL DEFAULT 'AVAILABLE',
  "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "next_retry_at" TIMESTAMP(3),
  "response_status" INTEGER,
  "error_safe" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "webhook_deliveries_event_id_subscription_id_key" ON "webhook_deliveries"("event_id", "subscription_id");
CREATE INDEX "webhook_deliveries_status_available_at_next_retry_at_idx" ON "webhook_deliveries"("status", "available_at", "next_retry_at");

CREATE TABLE "funding_destinations" (
  "id" VARCHAR(64) NOT NULL,
  "account_id" VARCHAR(64) NOT NULL,
  "route_id" VARCHAR(64) NOT NULL,
  "network" VARCHAR(64) NOT NULL,
  "asset_id" VARCHAR(64) NOT NULL,
  "destination" VARCHAR(255) NOT NULL,
  "readiness" VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  "sender_constraints_json" TEXT NOT NULL DEFAULT '{}',
  "last_validated_at" TIMESTAMP(3),
  "last_failure_code" VARCHAR(128),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "funding_destinations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "funding_destinations_account_id_route_id_asset_id_key" ON "funding_destinations"("account_id", "route_id", "asset_id");
CREATE INDEX "funding_destinations_account_id_readiness_idx" ON "funding_destinations"("account_id", "readiness");

CREATE TABLE "backup_restore_verifications" (
  "id" VARCHAR(64) NOT NULL,
  "backup_reference" VARCHAR(255) NOT NULL,
  "environment" VARCHAR(64) NOT NULL,
  "status" VARCHAR(32) NOT NULL DEFAULT 'RUNNING',
  "schema_version" VARCHAR(64) NOT NULL,
  "invariant_summary_json" TEXT NOT NULL DEFAULT '{}',
  "custody_identity" VARCHAR(255),
  "verified_at" TIMESTAMP(3),
  "failure_safe" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "backup_restore_verifications_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "backup_restore_verifications_status_created_at_idx" ON "backup_restore_verifications"("status", "created_at");

CREATE TABLE "rate_limit_buckets" (
  "id" VARCHAR(255) NOT NULL,
  "subject_type" VARCHAR(64) NOT NULL,
  "subject_id" VARCHAR(255) NOT NULL,
  "bucket" VARCHAR(64) NOT NULL,
  "window_started_at" TIMESTAMP(3) NOT NULL,
  "request_count" INTEGER NOT NULL DEFAULT 0,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "rate_limit_buckets_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "rate_limit_buckets_subject_type_subject_id_bucket_window_started_at_key"
  ON "rate_limit_buckets"("subject_type", "subject_id", "bucket", "window_started_at");
