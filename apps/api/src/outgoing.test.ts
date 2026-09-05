import { describe, expect, it } from 'vitest'
import { OutgoingPaymentReconciliationService } from './outgoing.js'

function payment(id: string) {
  return {
    id,
    payerAccountId: 'acct_worker',
    kind: 'PAY' as const,
    route: 'SOLANA_SPL',
  }
}

describe('outgoing payment reconciliation worker', () => {
  it('is single-flight, drains an active run, and refuses runs after stop', async () => {
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    let recoveries = 0
    const repository = {
      listRecoverablePayments: async () => [payment('pay_1')],
    }
    const paymentService = {
      recoverPersistedPayment: async () => {
        recoveries += 1
        await blocked
      },
    }
    const worker = new OutgoingPaymentReconciliationService(
      repository as never,
      paymentService as never,
      { info: () => undefined },
    )

    const first = worker.runOnce()
    const second = worker.runOnce()
    worker.stop()
    let drained = false
    const drain = worker.drain().then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(recoveries).toBe(1)
    expect(drained).toBe(false)

    release()
    await Promise.all([first, second, drain])
    expect(drained).toBe(true)
    await worker.runOnce()
    expect(recoveries).toBe(1)
  })

  it('continues with the next payment after one recovery fails', async () => {
    const recovered: string[] = []
    const worker = new OutgoingPaymentReconciliationService(
      {
        listRecoverablePayments: async () => [payment('pay_1'), payment('pay_2')],
      } as never,
      {
        recoverPersistedPayment: async (current: { id: string }) => {
          recovered.push(current.id)
          if (current.id === 'pay_1') throw new Error('temporary failure')
          return current as never
        },
      } as never,
      { info: () => undefined },
    )

    await worker.runOnce()
    expect(recovered).toEqual(['pay_1', 'pay_2'])
  })

  it('returns the tracked rejection and allows a later run after a database failure', async () => {
    const databaseFailure = new Error('database temporarily unavailable')
    let listCalls = 0
    const worker = new OutgoingPaymentReconciliationService(
      {
        listRecoverablePayments: async () => {
          listCalls += 1
          if (listCalls === 1) throw databaseFailure
          return []
        },
      } as never,
      { recoverPersistedPayment: async () => undefined } as never,
      { info: () => undefined },
    )

    const rejectedRun = worker.runOnce()
    await expect(rejectedRun).rejects.toBe(databaseFailure)

    const followingRun = worker.runOnce()
    expect(followingRun).not.toBe(rejectedRun)
    await expect(followingRun).resolves.toBeUndefined()
    expect(listCalls).toBe(2)
  })
})
