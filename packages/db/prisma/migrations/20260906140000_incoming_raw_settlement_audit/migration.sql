-- AlterTable
ALTER TABLE "incoming_payments"
ADD COLUMN "token_atomic_units" BIGINT,
ADD COLUMN "token_decimals" INTEGER;

-- Existing records predate raw settlement audit fields. Their normalized
-- product cents are the only available representation, so preserve them at
-- the product scale while all new records store the exact rail values.
UPDATE "incoming_payments"
SET "token_atomic_units" = "amount_atomic",
    "token_decimals" = 2
WHERE "token_atomic_units" IS NULL OR "token_decimals" IS NULL;

-- AlterTable
ALTER TABLE "incoming_payments"
ALTER COLUMN "token_atomic_units" SET NOT NULL,
ALTER COLUMN "token_decimals" SET NOT NULL;
