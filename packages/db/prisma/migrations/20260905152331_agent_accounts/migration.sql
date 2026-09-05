-- CreateEnum
CREATE TYPE "AgentAccountStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateTable
CREATE TABLE "agent_accounts" (
    "id" VARCHAR(64) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "status" "AgentAccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "solana_public_key" VARCHAR(64) NOT NULL,
    "encrypted_solana_secret" TEXT NOT NULL,
    "encryption_nonce" VARCHAR(32) NOT NULL,
    "encryption_auth_tag" VARCHAR(32) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_credentials" (
    "id" VARCHAR(64) NOT NULL,
    "account_id" VARCHAR(64) NOT NULL,
    "key_hash" VARCHAR(128) NOT NULL,
    "key_prefix" VARCHAR(32) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),
    "last_used_at" TIMESTAMP(3),

    CONSTRAINT "api_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agent_accounts_solana_public_key_key" ON "agent_accounts"("solana_public_key");

-- CreateIndex
CREATE UNIQUE INDEX "api_credentials_key_hash_key" ON "api_credentials"("key_hash");

-- CreateIndex
CREATE INDEX "api_credentials_account_id_idx" ON "api_credentials"("account_id");

-- AddForeignKey
ALTER TABLE "api_credentials" ADD CONSTRAINT "api_credentials_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "agent_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
