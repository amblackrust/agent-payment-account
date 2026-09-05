-- AlterTable
ALTER TABLE "payment_attempts" ADD COLUMN     "confirmation_metadata" TEXT,
ADD COLUMN     "durable_payload" TEXT,
ADD COLUMN     "expected_external_id" VARCHAR(255),
ADD COLUMN     "recovery_metadata" TEXT;

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "destination_rail" VARCHAR(64),
ADD COLUMN     "destination_reference" VARCHAR(255),
ADD COLUMN     "destination_type" VARCHAR(64),
ADD COLUMN     "payer_public_key" VARCHAR(64);
