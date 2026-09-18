-- Project legacy attempt facts into the durable V2 outcome dimension without
-- manufacturing settlement evidence. Unknown legacy submissions remain
-- reconciling until the rail can provide authoritative evidence.
UPDATE "payment_attempts"
SET "outcome" = CASE
      WHEN "status" = 'CONFIRMED' THEN 'CONFIRMED'
      WHEN "status" = 'SUBMITTED' THEN 'SUBMITTED'
      WHEN "status" = 'RECONCILING' THEN 'UNKNOWN'
      WHEN "status" = 'FAILED' THEN 'FAILED'
      ELSE "outcome"
    END,
    "expected_external_id" = COALESCE(
      "expected_external_id",
      "expected_signature"
    ),
    "validity_slot" = COALESCE(
      "validity_slot",
      "last_valid_block_height"
    )
WHERE "outcome" = 'NOT_STARTED'
  AND "status" IN ('CONFIRMED', 'SUBMITTED', 'RECONCILING', 'FAILED');

-- Some early legacy rows have a payment but no durable attempt. Create only
-- the minimal attempt needed to reconcile the already-observed lifecycle.
INSERT INTO "payment_attempts" (
  "id",
  "payment_id",
  "attempt_number",
  "rail",
  "status",
  "outcome",
  "expected_external_id",
  "validity_slot",
  "row_version",
  "created_at",
  "updated_at"
)
SELECT
  'legacy_attempt_' || md5(payment."id"),
  payment."id",
  1,
  COALESCE(payment."route", 'LEGACY'),
  CASE
    WHEN payment."status" = 'SUBMITTED' THEN 'SUBMITTED'::"PaymentAttemptStatus"
    WHEN payment."status" = 'RECONCILING' THEN 'RECONCILING'::"PaymentAttemptStatus"
    ELSE 'FAILED'::"PaymentAttemptStatus"
  END,
  CASE
    WHEN payment."status" = 'SUBMITTED' THEN 'SUBMITTED'
    WHEN payment."status" = 'RECONCILING' THEN 'UNKNOWN'
    ELSE 'FAILED'
  END,
  NULL,
  NULL,
  1,
  payment."created_at",
  payment."updated_at"
FROM "payments" AS payment
WHERE payment."status" IN ('SUBMITTED', 'RECONCILING')
  AND NOT EXISTS (
    SELECT 1
    FROM "payment_attempts" AS attempt
    WHERE attempt."payment_id" = payment."id"
  );
