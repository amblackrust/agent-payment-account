import { describe, expect, it } from 'vitest'
import { TransactionService } from './transactions.js'

function outgoing(id: string, createdAt: string) {
  return {
    id,
    payerAccountId: 'acct_1',
    payerPublicKey: null,
    recipientId: null,
    kind: 'SEND' as const,
    amountAtomic: 100n,
    currency: 'USD',
    status: 'CONFIRMED' as const,
    description: null,
    externalReference: null,
    route: 'SOLANA_SPL',
    createdAt: new Date(createdAt),
    updatedAt: new Date(createdAt),
    confirmedAt: new Date(createdAt),
    failedAt: null,
    failureCode: null,
    failureMessageSafe: null,
    destinationRail: 'SOLANA_SPL',
    destinationType: 'wallet',
    destinationReference: 'address',
    recipientManagedAccountId: null,
    originalPaymentId: null,
    counterpartyAccountId: null,
    counterpartyAddress: 'address',
  }
}

function incoming(id: string, createdAt: string) {
  return {
    id,
    accountId: 'acct_1',
    signature: `signature-${id}`,
    amountAtomic: 100n,
    currency: 'USD',
    sourceAddress: 'source-address',
    reference: null,
    tokenAccount: 'token-account',
    settlementMint: 'mint',
    status: 'CONFIRMED' as const,
    createdAt: new Date(createdAt),
    confirmedAt: new Date(createdAt),
    receiveRequestId: null,
  }
}

describe('transaction history pagination', () => {
  it('merges mixed history with a stable cursor and ignores inserts before the next page', async () => {
    const records = [
      outgoing('pay_new', '2026-09-06T00:00:03.000Z'),
      outgoing('pay_middle', '2026-09-06T00:00:02.000Z'),
      incoming('in_old', '2026-09-06T00:00:01.000Z'),
    ]
    const payments = records.filter((record) => 'payerAccountId' in record)
    const incomingPayments = records.filter((record) => 'accountId' in record)
    const page = <T extends { id: string; createdAt: Date }>(
      source: readonly T[],
      limit: number,
      cursor?: { createdAt: Date; id: string },
    ) =>
      source
        .filter(
          (record) =>
            cursor === undefined ||
            record.createdAt < cursor.createdAt ||
            (record.createdAt.getTime() === cursor.createdAt.getTime() &&
              record.id < cursor.id),
        )
        .sort((left, right) =>
          right.createdAt.getTime() === left.createdAt.getTime()
            ? right.id.localeCompare(left.id)
            : right.createdAt.getTime() - left.createdAt.getTime(),
        )
        .slice(0, limit)
    const repository = {
      listPaymentsPage: async (_accountId: string, limit: number, cursor?: never) =>
        page(payments, limit, cursor),
      listIncomingPaymentsPage: async (
        _accountId: string,
        limit: number,
        cursor?: never,
      ) => page(incomingPayments, limit, cursor),
      findRecipientsForOwner: async () => [],
    }
    const service = new TransactionService(repository as never)

    const first = await service.listTransactionsPage('acct_1', { limit: 1 })
    records.unshift(outgoing('pay_inserted', '2026-09-06T00:00:04.000Z'))
    const second = await service.listTransactionsPage('acct_1', {
      limit: 1,
      ...(first.next_cursor === null ? {} : { cursor: first.next_cursor }),
    })
    const third = await service.listTransactionsPage('acct_1', {
      limit: 1,
      ...(second.next_cursor === null ? {} : { cursor: second.next_cursor }),
    })

    expect(first.transactions.map((item) => item.id)).toEqual(['pay_new'])
    expect(second.transactions.map((item) => item.id)).toEqual(['pay_middle'])
    expect(third.transactions.map((item) => item.id)).toEqual(['in_old'])
    expect(third.next_cursor).toBeNull()
  })

  it('orders equal timestamps by the opaque id tie-breaker', async () => {
    const time = '2026-09-06T00:00:00.000Z'
    const repository = {
      listPaymentsPage: async () => [outgoing('pay_b', time)],
      listIncomingPaymentsPage: async () => [incoming('in_a', time)],
      findRecipientsForOwner: async () => [],
    }
    const page = await new TransactionService(repository as never).listTransactionsPage(
      'acct_1',
      { limit: 2 },
    )
    expect(page.transactions.map((item) => item.id)).toEqual(['pay_b', 'in_a'])
  })
})
