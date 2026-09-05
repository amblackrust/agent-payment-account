import { ValidationError, formatMoney, moneyFromAtomicUnits } from '@agent-payment/core'
import type { TransactionResponse } from '@agent-payment/contracts'
import type {
  IncomingPaymentRecord,
  IncomingPaymentRepository,
  PaymentRecord,
  PaymentRepository,
  RecipientRepository,
} from '@agent-payment/db'

const DEFAULT_TRANSACTION_LIMIT = 50
const MAX_TRANSACTION_LIMIT = 100

interface TransactionCursor {
  readonly createdAt: string
  readonly id: string
}

export interface TransactionPage {
  readonly transactions: readonly TransactionResponse[]
  readonly next_cursor: string | null
}

type TransactionStore = PaymentRepository &
  IncomingPaymentRepository &
  RecipientRepository

export class TransactionService {
  public constructor(private readonly repository: TransactionStore) {}

  public async listTransactions(accountId: string): Promise<readonly TransactionResponse[]> {
    const transactions: TransactionResponse[] = []
    let cursor: string | undefined
    do {
      const page = await this.listTransactionsPage(accountId, {
        limit: MAX_TRANSACTION_LIMIT,
        ...(cursor === undefined ? {} : { cursor }),
      })
      transactions.push(...page.transactions)
      cursor = page.next_cursor ?? undefined
    } while (cursor !== undefined)
    return transactions
  }

  public async listTransactionsPage(
    accountId: string,
    input: { readonly limit?: number; readonly cursor?: string },
  ): Promise<TransactionPage> {
    const limit = validateLimit(input.limit)
    const cursor = decodeCursor(input.cursor)
    const [payments, incoming] = await Promise.all([
      readPaymentPage(this.repository, accountId, limit + 1, cursor),
      readIncomingPage(this.repository, accountId, limit + 1, cursor),
    ])
    const recipientIds = payments
      .map((payment) => payment.recipientId)
      .filter((id): id is string => id !== null)
    const recipients = await findRecipients(
      this.repository,
      accountId,
      recipientIds,
    )
    const displayNames = new Map(
      recipients.map((recipient) => [recipient.id, recipient.displayName]),
    )
    const merged = [
      ...payments.map((payment) =>
        serializeOutgoing(payment, displayNames.get(payment.recipientId ?? '')),
      ),
      ...incoming.map(serializeIncoming),
    ]
      .sort(compareTransactions)
      .slice(0, limit)
    const last = merged.at(-1)
    const hasMore = payments.length + incoming.length > limit
    return {
      transactions: merged,
      next_cursor:
        hasMore && last !== undefined
          ? encodeCursor({ createdAt: last.created_at, id: last.id })
          : null,
    }
  }

  public async getTransaction(accountId: string, id: string) {
    const payment = await this.repository.findPaymentForOwner(accountId, id)
    if (payment !== null) {
      const recipients =
        payment.recipientId === null
          ? []
          : await findRecipients(this.repository, accountId, [payment.recipientId])
      return serializeOutgoing(payment, recipients[0]?.displayName)
    }
    const incoming = await this.repository.findIncomingPaymentForOwner(accountId, id)
    if (incoming !== null) return serializeIncoming(incoming)
    const error = new Error('Transaction not found')
    Object.assign(error, { statusCode: 404 })
    throw error
  }
}

function validateLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_TRANSACTION_LIMIT
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_TRANSACTION_LIMIT) {
    throw new ValidationError(
      `Transaction limit must be an integer from 1 to ${MAX_TRANSACTION_LIMIT}`,
    )
  }
  return limit
}

function decodeCursor(
  value: string | undefined,
): { createdAt: Date; id: string } | undefined {
  if (value === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as { createdAt?: unknown }).createdAt !== 'string' ||
      typeof (parsed as { id?: unknown }).id !== 'string'
    ) {
      throw new Error('invalid cursor')
    }
    const createdAt = new Date((parsed as { createdAt: string }).createdAt)
    if (Number.isNaN(createdAt.getTime())) throw new Error('invalid cursor')
    return { createdAt, id: (parsed as { id: string }).id }
  } catch {
    throw new ValidationError('Transaction cursor is invalid')
  }
}

function encodeCursor(cursor: TransactionCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url')
}

function compareTransactions(left: TransactionResponse, right: TransactionResponse): number {
  const created = right.created_at.localeCompare(left.created_at)
  return created === 0 ? right.id.localeCompare(left.id) : created
}

async function readPaymentPage(
  repository: TransactionStore,
  accountId: string,
  limit: number,
  cursor: { readonly createdAt: Date; readonly id: string } | undefined,
): Promise<readonly PaymentRecord[]> {
  if (repository.listPaymentsPage !== undefined) {
    return repository.listPaymentsPage(accountId, limit, cursor)
  }
  const payments = await repository.listPayments(accountId)
  return filterPage(payments, limit, cursor, (payment) => payment.createdAt)
}

async function readIncomingPage(
  repository: TransactionStore,
  accountId: string,
  limit: number,
  cursor: { readonly createdAt: Date; readonly id: string } | undefined,
): Promise<readonly IncomingPaymentRecord[]> {
  if (repository.listIncomingPaymentsPage !== undefined) {
    return repository.listIncomingPaymentsPage(accountId, limit, cursor)
  }
  const payments = await repository.listIncomingPayments(accountId)
  return filterPage(payments, limit, cursor, (payment) => payment.createdAt)
}

function filterPage<T extends { readonly id: string }>(
  records: readonly T[],
  limit: number,
  cursor: { readonly createdAt: Date; readonly id: string } | undefined,
  getCreatedAt: (record: T) => Date,
): readonly T[] {
  return records
    .filter(
      (record) =>
        cursor === undefined ||
        getCreatedAt(record) < cursor.createdAt ||
        (getCreatedAt(record).getTime() === cursor.createdAt.getTime() &&
          record.id < cursor.id),
    )
    .sort((left, right) => {
      const time = getCreatedAt(right).getTime() - getCreatedAt(left).getTime()
      return time === 0 ? right.id.localeCompare(left.id) : time
    })
    .slice(0, limit)
}

async function findRecipients(
  repository: TransactionStore,
  accountId: string,
  recipientIds: readonly string[],
) {
  if (repository.findRecipientsForOwner !== undefined) {
    return repository.findRecipientsForOwner(accountId, recipientIds)
  }
  return Promise.all(
    recipientIds.map((recipientId) =>
      repository.findRecipientForOwner(accountId, recipientId),
    ),
  ).then((recipients) => recipients.filter((recipient) => recipient !== null))
}

function serializeOutgoing(
  payment: PaymentRecord,
  recipientDisplayName: string | undefined,
): TransactionResponse {
  if (payment.currency !== 'USD') throw new Error('Unsupported transaction currency')
  return {
    id: payment.id,
    direction: 'OUTGOING',
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

function serializeIncoming(payment: IncomingPaymentRecord): TransactionResponse {
  if (payment.currency !== 'USD') throw new Error('Unsupported transaction currency')
  return {
    id: payment.id,
    direction: 'INCOMING',
    kind: 'RECEIVE',
    amount: formatMoney(moneyFromAtomicUnits(payment.amountAtomic, payment.currency)),
    currency: payment.currency,
    status: payment.status,
    counterparty: {
      recipient_id: null,
      display_name: null,
      account_id: null,
      address: payment.sourceAddress,
    },
    created_at: payment.createdAt.toISOString(),
    updated_at: payment.confirmedAt.toISOString(),
    confirmed_at: payment.confirmedAt.toISOString(),
    signature: payment.signature,
  }
}
