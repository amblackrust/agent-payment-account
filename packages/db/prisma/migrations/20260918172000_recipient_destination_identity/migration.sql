ALTER TABLE "recipient_destinations"
  ADD COLUMN "network" VARCHAR(64),
  ADD COLUMN "asset_reference" VARCHAR(255),
  ADD COLUMN "status" VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

CREATE INDEX "recipient_destinations_recipient_id_status_idx"
  ON "recipient_destinations"("recipient_id", "status");
