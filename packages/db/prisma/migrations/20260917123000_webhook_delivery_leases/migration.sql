ALTER TABLE "webhook_deliveries"
  ADD COLUMN "lease_owner" VARCHAR(128),
  ADD COLUMN "lease_expires_at" TIMESTAMP(3);

CREATE INDEX "webhook_deliveries_lease_idx"
  ON "webhook_deliveries"("status", "available_at", "lease_expires_at");
