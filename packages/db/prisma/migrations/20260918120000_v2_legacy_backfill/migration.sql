-- Complete the additive migration for facts that can be copied without
-- changing their economic meaning. Financial policy decisions and settlement
-- routes stay nullable until their source-specific identity is validated.

UPDATE "api_credentials"
SET "scopes" = '["payments:create","payments:read","contacts:manage","receive:manage","balance:read","history:read","webhooks:manage"]'
WHERE "scopes" = '[]' OR "scopes" = '';

UPDATE "payments" AS payment
SET "denomination_id" = denomination.id,
    "amount_scale" = denomination.max_scale
FROM "denominations" AS denomination
WHERE payment."denomination_id" IS NULL
  AND payment."currency" = denomination.symbol
  AND denomination.status = 'ACTIVE'
  AND denomination.max_scale = 2
  AND denomination.version = (
    SELECT MAX(candidate.version)
    FROM "denominations" AS candidate
    WHERE candidate.symbol = denomination.symbol
      AND candidate.status = 'ACTIVE'
      AND candidate.max_scale = 2
  );
