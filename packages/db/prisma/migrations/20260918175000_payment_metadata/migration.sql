ALTER TABLE "payments"
  ADD COLUMN "metadata_json" TEXT NOT NULL DEFAULT '{}';
