-- CreateTable
CREATE TABLE "incoming_reconciliation_issues" (
    "id" VARCHAR(64) NOT NULL,
    "account_id" VARCHAR(64) NOT NULL,
    "signature" VARCHAR(128) NOT NULL,
    "reason" VARCHAR(128) NOT NULL,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_tried_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retry_count" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "incoming_reconciliation_issues_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "incoming_reconciliation_issues_account_id_last_tried_at_idx" ON "incoming_reconciliation_issues"("account_id", "last_tried_at");

-- CreateIndex
CREATE UNIQUE INDEX "incoming_reconciliation_issues_account_id_signature_key" ON "incoming_reconciliation_issues"("account_id", "signature");

-- AddForeignKey
ALTER TABLE "incoming_reconciliation_issues" ADD CONSTRAINT "incoming_reconciliation_issues_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "agent_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
