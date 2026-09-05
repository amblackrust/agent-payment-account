-- CreateEnum
CREATE TYPE "PaymentKind" AS ENUM ('PAY', 'SEND');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('CREATED', 'ROUTING', 'SUBMITTED', 'CONFIRMED', 'FAILED');

-- CreateEnum
CREATE TYPE "PaymentAttemptStatus" AS ENUM ('CREATED', 'PREPARED', 'SUBMITTED', 'CONFIRMED', 'FAILED');

-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('ACTIVE', 'RELEASED');

-- CreateTable
CREATE TABLE "recipients" (
    "id" VARCHAR(64) NOT NULL,
    "owner_account_id" VARCHAR(64) NOT NULL,
    "display_name" VARCHAR(120) NOT NULL,
    "type" VARCHAR(64) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recipients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recipient_destinations" (
    "id" VARCHAR(64) NOT NULL,
    "recipient_id" VARCHAR(64) NOT NULL,
    "rail" VARCHAR(64) NOT NULL,
    "type" VARCHAR(64) NOT NULL,
    "wallet_address" VARCHAR(128) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recipient_destinations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" VARCHAR(64) NOT NULL,
    "payer_account_id" VARCHAR(64) NOT NULL,
    "recipient_id" VARCHAR(64) NOT NULL,
    "kind" "PaymentKind" NOT NULL,
    "amount_atomic" BIGINT NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'CREATED',
    "description" TEXT,
    "external_reference" VARCHAR(255),
    "route" VARCHAR(64),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "confirmed_at" TIMESTAMP(3),
    "failed_at" TIMESTAMP(3),
    "failure_code" VARCHAR(64),
    "failure_message_safe" TEXT,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_attempts" (
    "id" VARCHAR(64) NOT NULL,
    "payment_id" VARCHAR(64) NOT NULL,
    "attempt_number" INTEGER NOT NULL,
    "rail" VARCHAR(64) NOT NULL,
    "status" "PaymentAttemptStatus" NOT NULL DEFAULT 'CREATED',
    "rail_transaction_id" VARCHAR(255),
    "serialized_payload_safe" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_records" (
    "id" VARCHAR(64) NOT NULL,
    "owner_account_id" VARCHAR(64) NOT NULL,
    "operation" VARCHAR(32) NOT NULL,
    "key" VARCHAR(255) NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "resource_id" VARCHAR(64) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outgoing_reservations" (
    "id" VARCHAR(64) NOT NULL,
    "payment_id" VARCHAR(64) NOT NULL,
    "owner_account_id" VARCHAR(64) NOT NULL,
    "amount_atomic" BIGINT NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "status" "ReservationStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "released_at" TIMESTAMP(3),

    CONSTRAINT "outgoing_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "recipients_owner_account_id_idx" ON "recipients"("owner_account_id");

-- CreateIndex
CREATE INDEX "recipient_destinations_recipient_id_idx" ON "recipient_destinations"("recipient_id");

-- CreateIndex
CREATE INDEX "payments_payer_account_id_created_at_idx" ON "payments"("payer_account_id", "created_at");

-- CreateIndex
CREATE INDEX "payments_recipient_id_created_at_idx" ON "payments"("recipient_id", "created_at");

-- CreateIndex
CREATE INDEX "payments_payer_account_id_status_idx" ON "payments"("payer_account_id", "status");

-- CreateIndex
CREATE INDEX "payment_attempts_payment_id_created_at_idx" ON "payment_attempts"("payment_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "payment_attempts_payment_id_attempt_number_key" ON "payment_attempts"("payment_id", "attempt_number");

-- CreateIndex
CREATE INDEX "idempotency_records_owner_account_id_created_at_idx" ON "idempotency_records"("owner_account_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_records_owner_account_id_operation_key_key" ON "idempotency_records"("owner_account_id", "operation", "key");

-- CreateIndex
CREATE UNIQUE INDEX "outgoing_reservations_payment_id_key" ON "outgoing_reservations"("payment_id");

-- CreateIndex
CREATE INDEX "outgoing_reservations_owner_account_id_status_idx" ON "outgoing_reservations"("owner_account_id", "status");

-- AddForeignKey
ALTER TABLE "recipients" ADD CONSTRAINT "recipients_owner_account_id_fkey" FOREIGN KEY ("owner_account_id") REFERENCES "agent_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recipient_destinations" ADD CONSTRAINT "recipient_destinations_recipient_id_fkey" FOREIGN KEY ("recipient_id") REFERENCES "recipients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_payer_account_id_fkey" FOREIGN KEY ("payer_account_id") REFERENCES "agent_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_recipient_id_fkey" FOREIGN KEY ("recipient_id") REFERENCES "recipients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotency_records" ADD CONSTRAINT "idempotency_records_owner_account_id_fkey" FOREIGN KEY ("owner_account_id") REFERENCES "agent_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outgoing_reservations" ADD CONSTRAINT "outgoing_reservations_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outgoing_reservations" ADD CONSTRAINT "outgoing_reservations_owner_account_id_fkey" FOREIGN KEY ("owner_account_id") REFERENCES "agent_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
