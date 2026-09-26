ALTER TYPE "IncomingReconciliationIssueStatus" ADD VALUE IF NOT EXISTS 'EXHAUSTED';

ALTER TABLE "operational_exceptions"
  ADD COLUMN "row_version" INTEGER NOT NULL DEFAULT 1;

CREATE OR REPLACE FUNCTION prevent_operation_timeline_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'operation timeline events are append-only';
END;
$$;

DROP TRIGGER IF EXISTS operation_timeline_events_append_only ON "operation_timeline_events";
CREATE TRIGGER operation_timeline_events_append_only
BEFORE UPDATE OR DELETE ON "operation_timeline_events"
FOR EACH ROW EXECUTE FUNCTION prevent_operation_timeline_mutation();
