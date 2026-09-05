-- CreateTable
CREATE TABLE "fee_sponsorships" (
    "id" VARCHAR(64) NOT NULL,
    "account_id" VARCHAR(64) NOT NULL,
    "payment_id" VARCHAR(64) NOT NULL,
    "lamports" BIGINT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fee_sponsorships_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "fee_sponsorships_payment_id_key" ON "fee_sponsorships"("payment_id");

-- CreateIndex
CREATE INDEX "fee_sponsorships_account_id_created_at_idx" ON "fee_sponsorships"("account_id", "created_at");

-- AddForeignKey
ALTER TABLE "fee_sponsorships" ADD CONSTRAINT "fee_sponsorships_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "agent_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
