CREATE TYPE "IncomingReconciliationIssueStatus" AS ENUM ('PENDING', 'RESOLVED');

ALTER TABLE "incoming_reconciliation_issues"
  ADD COLUMN "status" "IncomingReconciliationIssueStatus" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "next_retry_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "resolved_at" TIMESTAMP(3),
  ALTER COLUMN "last_tried_at" DROP NOT NULL,
  ALTER COLUMN "last_tried_at" DROP DEFAULT,
  ALTER COLUMN "retry_count" SET DEFAULT 0;

DROP INDEX "incoming_reconciliation_issues_account_id_last_tried_at_idx";
CREATE INDEX "incoming_reconciliation_issues_status_next_retry_at_idx"
  ON "incoming_reconciliation_issues"("status", "next_retry_at");
CREATE INDEX "incoming_reconciliation_issues_account_id_status_idx"
  ON "incoming_reconciliation_issues"("account_id", "status");
