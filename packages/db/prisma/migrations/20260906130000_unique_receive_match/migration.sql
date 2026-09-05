-- CreateIndex
CREATE UNIQUE INDEX "incoming_payments_receive_request_id_key"
ON "incoming_payments"("receive_request_id");
