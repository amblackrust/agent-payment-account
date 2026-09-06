-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "last_recovery_attempt_at" TIMESTAMP(3),
ADD COLUMN     "next_recovery_at" TIMESTAMP(3),
ADD COLUMN     "recovery_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "stuck_since" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "payments_status_next_recovery_at_last_recovery_attempt_at_idx" ON "payments"("status", "next_recovery_at", "last_recovery_attempt_at");
