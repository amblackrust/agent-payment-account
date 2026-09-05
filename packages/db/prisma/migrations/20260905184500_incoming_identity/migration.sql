DROP INDEX "incoming_payments_signature_key";

CREATE UNIQUE INDEX "incoming_payments_account_id_signature_key"
  ON "incoming_payments"("account_id", "signature");
