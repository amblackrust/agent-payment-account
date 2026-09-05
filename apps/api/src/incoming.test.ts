import { describe, expect, it } from 'vitest'
import { moneyFromAtomicUnits } from '@agent-payment/core'
import type { IncomingTransfer, SolanaIncomingReader } from '@agent-payment/solana-rail'
import { IncomingReconciliationService } from './incoming.js'

const transfer: IncomingTransfer = {
  signature: 'signature-1',
  amount: moneyFromAtomicUnits(100n),
  sourceAddress: 'source',
  reference: 'reference',
  tokenAccount: 'token-account',
  settlementMint: 'mint',
  confirmedAt: new Date('2026-01-01T00:00:00.000Z'),
}

function createHarness() {
  let cursor: string | null = null
  let saveCount = 0
  let createCount = 0
  let failCreate = false
  const repository = {
    listActiveAccountSettlements: async () => [
      { accountId: 'acct_1', solanaPublicKey: 'owner' },
    ],
    expireOpenReceiveRequests: async () => undefined,
    getIncomingCursor: async () =>
      cursor === null
        ? null
        : {
            accountId: 'acct_1',
            rail: 'SOLANA_SPL',
            address: 'owner',
            cursorSignature: cursor,
          },
    createIncomingPayment: async () => {
      createCount += 1
      if (failCreate) throw new Error('simulated persistence failure')
      return { payment: {} as never, created: true }
    },
    saveIncomingCursor: async (input: { cursorSignature: string }) => {
      saveCount += 1
      cursor = input.cursorSignature
    },
  }
  return {
    repository: repository as never,
    state: {
      get cursor() {
        return cursor
      },
      get saveCount() {
        return saveCount
      },
      get createCount() {
        return createCount
      },
      set failCreate(value: boolean) {
        failCreate = value
      },
    },
  }
}

describe('incoming reconciliation worker', () => {
  it('does not advance the checkpoint when persistence fails, then resumes after restart', async () => {
    const harness = createHarness()
    const reader: SolanaIncomingReader = {
      scan: async () => [transfer],
      scanWithCursor: async () => ({
        transfers: [transfer],
        nextCursor: 'signature-1',
      }),
    }
    const errors: object[] = []
    const service = new IncomingReconciliationService(harness.repository, reader, {
      error: (data) => errors.push(data),
    })
    harness.state.failCreate = true
    await service.runOnce()
    expect(harness.state.cursor).toBeNull()
    expect(harness.state.saveCount).toBe(0)
    expect(errors).toHaveLength(1)

    harness.state.failCreate = false
    const restartedService = new IncomingReconciliationService(
      harness.repository,
      reader,
      { error: () => undefined },
    )
    await restartedService.runOnce()
    expect(harness.state.cursor).toBe('signature-1')
    expect(harness.state.createCount).toBe(2)
  })

  it('does not overlap reconciliation runs', async () => {
    const harness = createHarness()
    let scans = 0
    let releaseScan!: () => void
    const scanFinished = new Promise<void>((resolve) => {
      releaseScan = resolve
    })
    const reader: SolanaIncomingReader = {
      scan: async () => [],
      scanWithCursor: async () => {
        scans += 1
        await scanFinished
        return { transfers: [], nextCursor: 'signature-1' }
      },
    }
    const service = new IncomingReconciliationService(harness.repository, reader, {
      error: () => undefined,
    })
    const first = service.runOnce()
    const second = service.runOnce()
    releaseScan()
    await Promise.all([first, second])
    expect(scans).toBe(1)
  })
})
