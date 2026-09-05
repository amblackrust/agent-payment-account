-- AlterEnum
ALTER TYPE "PaymentAttemptStatus" ADD VALUE 'EXECUTING';

-- CreateIndex
CREATE UNIQUE INDEX "payment_attempts_payment_id_key" ON "payment_attempts"("payment_id");
