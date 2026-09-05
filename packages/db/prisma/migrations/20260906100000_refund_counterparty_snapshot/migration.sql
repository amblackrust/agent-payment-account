ALTER TABLE "payments"
  ALTER COLUMN "recipient_id" DROP NOT NULL,
  ADD COLUMN "counterparty_account_id" VARCHAR(64),
  ADD COLUMN "counterparty_address" VARCHAR(128);
