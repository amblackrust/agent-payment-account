-- AlterEnum
ALTER TYPE "PaymentAttemptStatus" ADD VALUE 'RECONCILING';

-- AlterEnum
ALTER TYPE "PaymentStatus" ADD VALUE 'RECONCILING';

-- AlterTable
ALTER TABLE "payment_attempts" ADD COLUMN     "blockhash" VARCHAR(128),
ADD COLUMN     "confirmed_slot" BIGINT,
ADD COLUMN     "expected_signature" VARCHAR(128),
ADD COLUMN     "last_valid_block_height" BIGINT,
ADD COLUMN     "signed_transaction_base64" TEXT;
