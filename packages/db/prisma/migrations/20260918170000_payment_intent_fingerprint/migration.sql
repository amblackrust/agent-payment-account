ALTER TABLE "payments"
  ADD COLUMN "intent_fingerprint" CHAR(64);

UPDATE "payments" AS payment
SET "intent_fingerprint" = approval."fingerprint"
FROM "approvals" AS approval
WHERE approval."payment_id" = payment."id"
  AND payment."intent_fingerprint" IS NULL;
