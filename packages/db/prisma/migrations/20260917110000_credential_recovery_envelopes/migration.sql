CREATE TABLE "credential_recovery_envelopes" (
  "idempotency_key" VARCHAR(255) NOT NULL,
  "account_id" VARCHAR(64) NOT NULL,
  "credential_id" VARCHAR(64) NOT NULL,
  "ciphertext" TEXT NOT NULL,
  "nonce" VARCHAR(64) NOT NULL,
  "auth_tag" VARCHAR(64) NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "acknowledged_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "credential_recovery_envelopes_pkey" PRIMARY KEY ("idempotency_key")
);

CREATE INDEX "credential_recovery_envelopes_account_id_expires_at_idx"
  ON "credential_recovery_envelopes"("account_id", "expires_at");

ALTER TABLE "credential_recovery_envelopes"
  ADD CONSTRAINT "credential_recovery_envelopes_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "agent_accounts"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "receive_requests"
  ADD COLUMN "denomination_id" VARCHAR(64),
  ADD COLUMN "amount_scale" INTEGER;
