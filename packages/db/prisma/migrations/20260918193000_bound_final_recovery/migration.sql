ALTER TABLE "durable_work_items"
  ADD COLUMN "lease_recovery_count" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "incoming_reconciliation_issues"
  ADD COLUMN "recovery_count" INTEGER NOT NULL DEFAULT 0;
