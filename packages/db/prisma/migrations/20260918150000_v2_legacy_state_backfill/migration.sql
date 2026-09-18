-- Project legacy status facts into V2 lifecycle dimensions only when the V2
-- columns still contain their additive-migration defaults. Rows with a V2
-- policy decision or an already-populated lifecycle projection are left alone.
UPDATE "payments"
SET "execution_state" = CASE
      WHEN "status" IN ('CONFIRMED', 'PROVED_NO_EFFECT', 'REJECTED_BY_POLICY')
        THEN 'TERMINAL'
      WHEN "status" IN ('SUBMITTED', 'RECONCILING')
        THEN 'RECONCILING'
      ELSE "execution_state"
    END,
    "settlement_state" = CASE
      WHEN "status" = 'CONFIRMED' THEN 'CONFIRMED'
      WHEN "status" = 'PROVED_NO_EFFECT' OR "status" = 'REJECTED_BY_POLICY'
        THEN 'NOT_SUBMITTED'
      WHEN "status" = 'SUBMITTED' THEN 'SUBMITTED'
      WHEN "status" = 'RECONCILING' THEN 'UNKNOWN'
      ELSE "settlement_state"
    END,
    "outcome_state" = CASE
      WHEN "status" = 'CONFIRMED' THEN 'CONFIRMED'
      WHEN "status" = 'PROVED_NO_EFFECT' OR "status" = 'REJECTED_BY_POLICY'
        THEN 'PROVED_NO_EFFECT'
      WHEN "status" = 'SUBMITTED' THEN 'SUBMITTED'
      WHEN "status" = 'RECONCILING' THEN 'UNDETERMINED'
      ELSE "outcome_state"
    END
WHERE "policy_decision_id" IS NULL
  AND "execution_state" = 'NOT_STARTED'
  AND "settlement_state" = 'NOT_SUBMITTED'
  AND "outcome_state" = 'NONE'
  AND "status" IN (
    'CONFIRMED', 'PROVED_NO_EFFECT', 'REJECTED_BY_POLICY',
    'SUBMITTED', 'RECONCILING'
  );

-- Legacy submitted/reconciling rows may predate durable V2 work items. Seed
-- one deterministic reconcile item per payment; the unique key makes this
-- safe to rerun after an interrupted migration or forward-fix deployment.
INSERT INTO "durable_work_items" (
  "id",
  "kind",
  "resource_type",
  "resource_id",
  "status",
  "available_at",
  "payload_json",
  "created_at",
  "updated_at"
)
SELECT
  'legacy_reconcile_' || md5(payment."id"),
  'RECONCILE_PAYMENT_ATTEMPT',
  'PAYMENT',
  payment."id",
  'AVAILABLE',
  NOW(),
  json_build_object('payment_id', payment."id")::TEXT,
  NOW(),
  NOW()
FROM "payments" AS payment
WHERE payment."status" IN ('SUBMITTED', 'RECONCILING')
ON CONFLICT ("kind", "resource_type", "resource_id") DO NOTHING;
