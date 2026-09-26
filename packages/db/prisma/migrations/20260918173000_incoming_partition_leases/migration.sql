ALTER TABLE "indexer_checkpoints"
  ADD COLUMN "lease_owner" VARCHAR(128),
  ADD COLUMN "lease_expires_at" TIMESTAMP(3);

CREATE INDEX "indexer_checkpoints_lease_expires_at_idx"
  ON "indexer_checkpoints"("lease_expires_at");
