-- CreateEnum
CREATE TYPE "ReceiveRequestStatus" AS ENUM ('OPEN', 'PAID', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "IncomingPaymentStatus" AS ENUM ('CONFIRMED');

-- AlterEnum
ALTER TYPE "PaymentKind" ADD VALUE 'REFUND';

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "original_payment_id" VARCHAR(64),
ADD COLUMN     "recipient_managed_account_id" VARCHAR(64);

-- AlterTable
ALTER TABLE "recipients" ADD COLUMN     "managed_account_id" VARCHAR(64);

-- CreateTable
CREATE TABLE "receive_requests" (
    "id" VARCHAR(64) NOT NULL,
    "account_id" VARCHAR(64) NOT NULL,
    "amount_atomic" BIGINT,
    "currency" VARCHAR(3) NOT NULL,
    "reference" VARCHAR(255) NOT NULL,
    "status" "ReceiveRequestStatus" NOT NULL DEFAULT 'OPEN',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3),
    "paid_at" TIMESTAMP(3),
    "matched_incoming_payment_id" VARCHAR(64),

    CONSTRAINT "receive_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "incoming_payments" (
    "id" VARCHAR(64) NOT NULL,
    "account_id" VARCHAR(64) NOT NULL,
    "signature" VARCHAR(128) NOT NULL,
    "amount_atomic" BIGINT NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "source_address" VARCHAR(128),
    "reference" VARCHAR(255),
    "token_account" VARCHAR(128) NOT NULL,
    "settlement_mint" VARCHAR(128) NOT NULL,
    "status" "IncomingPaymentStatus" NOT NULL DEFAULT 'CONFIRMED',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "receive_request_id" VARCHAR(64),

    CONSTRAINT "incoming_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "indexer_checkpoints" (
    "id" VARCHAR(64) NOT NULL,
    "account_id" VARCHAR(64) NOT NULL,
    "rail" VARCHAR(64) NOT NULL,
    "address" VARCHAR(128) NOT NULL,
    "cursor_signature" VARCHAR(128),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "indexer_checkpoints_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "receive_requests_matched_incoming_payment_id_key" ON "receive_requests"("matched_incoming_payment_id");

-- CreateIndex
CREATE INDEX "receive_requests_account_id_status_idx" ON "receive_requests"("account_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "receive_requests_account_id_reference_key" ON "receive_requests"("account_id", "reference");

-- CreateIndex
CREATE UNIQUE INDEX "incoming_payments_signature_key" ON "incoming_payments"("signature");

-- CreateIndex
CREATE INDEX "incoming_payments_account_id_created_at_idx" ON "incoming_payments"("account_id", "created_at");

-- CreateIndex
CREATE INDEX "incoming_payments_account_id_receive_request_id_idx" ON "incoming_payments"("account_id", "receive_request_id");

-- CreateIndex
CREATE UNIQUE INDEX "indexer_checkpoints_account_id_rail_address_key" ON "indexer_checkpoints"("account_id", "rail", "address");

-- CreateIndex
CREATE INDEX "recipients_managed_account_id_idx" ON "recipients"("managed_account_id");

-- AddForeignKey
ALTER TABLE "recipients" ADD CONSTRAINT "recipients_managed_account_id_fkey" FOREIGN KEY ("managed_account_id") REFERENCES "agent_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_original_payment_id_fkey" FOREIGN KEY ("original_payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receive_requests" ADD CONSTRAINT "receive_requests_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "agent_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receive_requests" ADD CONSTRAINT "receive_requests_matched_incoming_payment_id_fkey" FOREIGN KEY ("matched_incoming_payment_id") REFERENCES "incoming_payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incoming_payments" ADD CONSTRAINT "incoming_payments_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "agent_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incoming_payments" ADD CONSTRAINT "incoming_payments_receive_request_id_fkey" FOREIGN KEY ("receive_request_id") REFERENCES "receive_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "indexer_checkpoints" ADD CONSTRAINT "indexer_checkpoints_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "agent_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
