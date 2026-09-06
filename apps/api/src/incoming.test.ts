import { describe, expect, it } from 'vitest'
import { moneyFromAtomicUnits } from '@agent-payment/core'
import type { IncomingTransfer, SolanaIncomingReader } from '@agent-payment/solana-rail'
import { IncomingReconciliationService } from './incoming.js'

const transfer: IncomingTransfer = {
  signature: 'signature-1',
  amount: moneyFromAtomicUnits(100n),
  tokenAtomicUnits: 1_000_000n,
  tokenDecimals: 6,
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
    repository,
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
    const service = new IncomingReconciliationService(
      harness.repository as never,
      reader,
      {
        error: (data) => errors.push(data),
      },
    )
    harness.state.failCreate = true
    await service.runOnce()
    expect(harness.state.cursor).toBeNull()
    expect(harness.state.saveCount).toBe(0)
    expect(errors).toHaveLength(1)

    harness.state.failCreate = false
    const restartedService = new IncomingReconciliationService(
      harness.repository as never,
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
    const service = new IncomingReconciliationService(
      harness.repository as never,
      reader,
      {
        error: () => undefined,
      },
    )
    const first = service.runOnce()
    const second = service.runOnce()
    releaseScan()
    await Promise.all([first, second])
    expect(scans).toBe(1)
  })

  it('processes confirmed transfers before wall-clock expiry cleanup', async () => {
    const harness = createHarness()
    const events: string[] = []
    const repository = {
      ...harness.repository,
      createIncomingPayment: async () => {
        events.push('incoming')
        return { payment: {} as never, created: true }
      },
      expireOpenReceiveRequests: async () => {
        events.push('expire')
      },
    }
    const service = new IncomingReconciliationService(
      repository as never,
      {
        scan: async () => [],
        scanWithCursor: async () => ({
          transfers: [transfer],
          nextCursor: 'signature-1',
        }),
      },
      { error: () => undefined },
    )

    await service.runOnce()

    expect(events).toEqual(['incoming', 'expire'])
  })

  it('advances past a durable issue and imports it exactly once when retry succeeds', async () => {
    const persistedSignatures = new Set<string>()
    const issues = new Map<
      string,
      { id: string; accountId: string; signature: string; reason: string }
    >()
    let cursor: string | null = null
    let transactionAvailable = false
    const transferB = { ...transfer, signature: 'signature-b' }
    const transferA = { ...transfer, signature: 'signature-a' }
    const repository = {
      listActiveAccountSettlements: async () => [
        { accountId: 'acct_1', solanaPublicKey: 'owner' },
      ],
      getIncomingCursor: async () =>
        cursor === null
          ? null
          : {
              accountId: 'acct_1',
              rail: 'SOLANA_SPL',
              address: 'owner',
              cursorSignature: cursor,
            },
      saveIncomingCursor: async (input: { cursorSignature: string }) => {
        cursor = input.cursorSignature
      },
      expireOpenReceiveRequests: async () => undefined,
      createIncomingPayment: async (input: { signature: string }) => {
        const created = !persistedSignatures.has(input.signature)
        persistedSignatures.add(input.signature)
        return { payment: {} as never, created }
      },
      recordIncomingReconciliationIssue: async (input: {
        id: string
        accountId: string
        signature: string
        reason: string
      }) => {
        issues.set(input.signature, input)
      },
      claimIncomingReconciliationIssues: async () =>
        [...issues.values()].map((issue) => ({
          ...issue,
          accountPublicKey: 'owner',
          retryCount: 1,
        })),
      resolveIncomingReconciliationIssue: async (issueId: string) => {
        for (const [signature, issue] of issues) {
          if (issue.id === issueId) issues.delete(signature)
        }
      },
      updateIncomingReconciliationIssueReason: async () => undefined,
    }
    const reader: SolanaIncomingReader = {
      scan: async () => [],
      scanWithCursor: async () =>
        cursor === null
          ? {
              transfers: [transferB],
              unresolved: [
                {
                  signature: transferA.signature,
                  reason: 'TRANSACTION_UNAVAILABLE' as const,
                },
              ],
              nextCursor: transferB.signature,
            }
          : { transfers: [], unresolved: [], nextCursor: cursor },
      inspectSignature: async () =>
        transactionAvailable
          ? { kind: 'INCOMING', transfer: transferA }
          : { kind: 'UNRESOLVED', reason: 'TRANSACTION_UNAVAILABLE' },
    }

    await new IncomingReconciliationService(repository as never, reader, {
      error: () => undefined,
    }).runOnce()
    expect(cursor).toBe('signature-b')
    expect(persistedSignatures).toEqual(new Set(['signature-b']))
    expect(issues.has('signature-a')).toBe(true)

    transactionAvailable = true
    await new IncomingReconciliationService(repository as never, reader, {
      error: () => undefined,
    }).runOnce()
    await new IncomingReconciliationService(repository as never, reader, {
      error: () => undefined,
    }).runOnce()
    expect(persistedSignatures).toEqual(new Set(['signature-b', 'signature-a']))
    expect(issues.size).toBe(0)
  })
})
