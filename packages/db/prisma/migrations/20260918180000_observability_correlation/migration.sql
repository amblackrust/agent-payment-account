ALTER TABLE "payments"
  ADD COLUMN "correlation_id" VARCHAR(128);

ALTER TABLE "webhook_events"
  ADD COLUMN "correlation_id" VARCHAR(128);

CREATE INDEX "payments_correlation_id_idx" ON "payments"("correlation_id");
CREATE INDEX "webhook_events_correlation_id_idx" ON "webhook_events"("correlation_id");
