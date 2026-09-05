import { formatMoney, moneyFromAtomicUnits } from '@agent-payment/core'
import type {
  IncomingPaymentRepository,
  PaymentRecord,
  PaymentRepository,
  RecipientRepository,
} from '@agent-payment/db'

type TransactionStore = PaymentRepository &
  IncomingPaymentRepository &
  RecipientRepository

export class TransactionService {
  public constructor(private readonly repository: TransactionStore) {}

  public async listTransactions(accountId: string) {
    const [payments, incoming] = await Promise.all([
      this.repository.listPayments(accountId),
      this.repository.listIncomingPayments(accountId),
    ])
    const outgoing = await Promise.all(
      payments.map(async (payment) =>
        serializeOutgoing(
          payment,
          payment.recipientId === null
            ? undefined
            : (
                await this.repository.findRecipientForOwner(
                  accountId,
                  payment.recipientId,
                )
              )?.displayName,
        ),
      ),
    )
    return [...outgoing, ...incoming.map(serializeIncoming)].sort((left, right) =>
      right.created_at.localeCompare(left.created_at),
    )
  }

  public async getTransaction(accountId: string, id: string) {
    const payment = await this.repository.findPaymentForOwner(accountId, id)
    if (payment !== null) {
      return serializeOutgoing(
        payment,
        payment.recipientId === null
          ? undefined
          : (
              await this.repository.findRecipientForOwner(
                accountId,
                payment.recipientId,
              )
            )?.displayName,
      )
    }
    const incoming = await this.repository.findIncomingPaymentForOwner(accountId, id)
    if (incoming !== null) {
      return serializeIncoming(incoming)
    }
    const error = new Error('Transaction not found')
    Object.assign(error, { statusCode: 404 })
    throw error
  }
}

function serializeOutgoing(
  payment: PaymentRecord,
  recipientDisplayName: string | undefined,
) {
  return {
    id: payment.id,
    direction: 'OUTGOING' as const,
    kind: payment.kind,
    amount: formatMoney(moneyFromAtomicUnits(payment.amountAtomic, payment.currency)),
    currency: payment.currency,
    status: payment.status,
    counterparty: {
      recipient_id: payment.recipientId,
      display_name: recipientDisplayName ?? null,
      account_id: payment.counterpartyAccountId,
      address: payment.counterpartyAddress,
    },
    created_at: payment.createdAt.toISOString(),
    updated_at: payment.updatedAt.toISOString(),
    confirmed_at: payment.confirmedAt?.toISOString() ?? null,
    signature: null,
  }
}

function serializeIncoming(payment: {
  id: string
  accountId: string
  signature: string
  amountAtomic: bigint
  currency: string
  sourceAddress: string | null
  status: 'CONFIRMED'
  createdAt: Date
  confirmedAt: Date
}) {
  return {
    id: payment.id,
    direction: 'INCOMING' as const,
    kind: 'RECEIVE' as const,
    amount: formatMoney(moneyFromAtomicUnits(payment.amountAtomic, payment.currency)),
    currency: payment.currency,
    status: payment.status,
    counterparty: { address: payment.sourceAddress },
    created_at: payment.createdAt.toISOString(),
    updated_at: payment.confirmedAt.toISOString(),
    confirmed_at: payment.confirmedAt.toISOString(),
    signature: payment.signature,
  }
}
