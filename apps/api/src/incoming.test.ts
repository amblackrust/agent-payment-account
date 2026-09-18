import { afterEach, describe, expect, it, vi } from 'vitest'
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

afterEach(() => {
  vi.useRealTimers()
})

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

  it('does not let another worker scan an owned account partition', async () => {
    let partitionHeld = false
    let claimCount = 0
    let scans = 0
    let releaseScan!: () => void
    let scanStarted!: () => void
    const scanStartedPromise = new Promise<void>((resolve) => {
      scanStarted = resolve
    })
    const scanRelease = new Promise<void>((resolve) => {
      releaseScan = resolve
    })
    const repository = {
      listActiveAccountSettlements: async () => [
        { accountId: 'acct_1', solanaPublicKey: 'owner' },
      ],
      claimIncomingPartition: async (input: { owner: string }) => {
        claimCount += 1
        if (partitionHeld) return null
        partitionHeld = true
        return {
          accountId: 'acct_1',
          rail: 'SOLANA_SPL',
          address: 'owner',
          cursorSignature: null,
          owner: input.owner,
        }
      },
      releaseIncomingPartition: async () => {
        partitionHeld = false
      },
      renewIncomingPartition: async () => undefined,
      saveIncomingCursor: async () => undefined,
      expireOpenReceiveRequests: async () => undefined,
      createIncomingPayment: async () => ({ payment: {} as never, created: true }),
      getIncomingCursor: async () => null,
    }
    const reader: SolanaIncomingReader = {
      scan: async () => [],
      scanWithCursor: async () => {
        scans += 1
        scanStarted()
        await scanRelease
        return { transfers: [], nextCursor: 'signature-1' }
      },
    }
    const serviceA = new IncomingReconciliationService(
      repository as never,
      reader,
      { error: () => undefined },
      { owner: 'worker-a' },
    )
    const serviceB = new IncomingReconciliationService(
      repository as never,
      reader,
      { error: () => undefined },
      { owner: 'worker-b' },
    )

    const firstRun = serviceA.runOnce()
    await scanStartedPromise
    await serviceB.runOnce()
    expect(scans).toBe(1)
    expect(claimCount).toBe(2)

    releaseScan()
    await firstRun
  })

  it('assigns unique default lease owners to separate service instances', async () => {
    const owners: string[] = []
    const repository = {
      listActiveAccountSettlements: async () => [
        { accountId: 'acct_1', solanaPublicKey: 'owner' },
      ],
      claimIncomingPartition: async (input: { owner: string }) => {
        owners.push(input.owner)
        return null
      },
    }
    const reader = { scan: async () => [] }
    const logger = { error: () => undefined }

    await Promise.all([
      new IncomingReconciliationService(
        repository as never,
        reader as never,
        logger,
      ).runOnce(),
      new IncomingReconciliationService(
        repository as never,
        reader as never,
        logger,
      ).runOnce(),
    ])

    expect(owners).toHaveLength(2)
    expect(new Set(owners)).toHaveLength(2)
  })

  it('keeps the lease token unchanged when a heartbeat renewal fails', async () => {
    vi.useFakeTimers()
    const startedAt = new Date('2026-09-18T00:00:00.000Z')
    vi.setSystemTime(startedAt)
    const initialLeaseExpiresAt = new Date('2026-09-18T00:00:03.000Z')
    const renewals: Array<{ leaseExpiresAt?: Date }> = []
    const saved: Array<{ leaseExpiresAt?: Date }> = []
    const released: Array<{ leaseExpiresAt?: Date }> = []
    let scanStarted!: () => void
    let releaseScan!: () => void
    const scanStartedPromise = new Promise<void>((resolve) => {
      scanStarted = resolve
    })
    const scanRelease = new Promise<void>((resolve) => {
      releaseScan = resolve
    })
    const repository = {
      listActiveAccountSettlements: async () => [
        { accountId: 'acct_1', solanaPublicKey: 'owner' },
      ],
      claimIncomingPartition: async () => ({
        accountId: 'acct_1',
        rail: 'SOLANA_SPL',
        address: 'owner',
        cursorSignature: null,
        leaseExpiresAt: initialLeaseExpiresAt,
      }),
      renewIncomingPartition: async (input: { leaseExpiresAt?: Date }) => {
        renewals.push(input)
        throw new Error('simulated lease renewal failure')
      },
      saveIncomingCursor: async (input: { leaseExpiresAt?: Date }) => {
        saved.push(input)
      },
      releaseIncomingPartition: async (input: { leaseExpiresAt?: Date }) => {
        released.push(input)
      },
      expireOpenReceiveRequests: async () => undefined,
      createIncomingPayment: async () => ({ payment: {} as never, created: true }),
    }
    const service = new IncomingReconciliationService(
      repository as never,
      {
        scan: async () => [],
        scanWithCursor: async () => {
          scanStarted()
          await scanRelease
          return { transfers: [], nextCursor: 'signature-1' }
        },
      },
      { error: () => undefined },
      { owner: 'worker-1', leaseSeconds: 3 },
    )

    const run = service.runOnce()
    await scanStartedPromise
    await vi.advanceTimersByTimeAsync(1_000)
    expect(renewals).toHaveLength(1)
    expect(renewals[0]).toMatchObject({ leaseExpiresAt: initialLeaseExpiresAt })

    releaseScan()
    await run

    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({ leaseExpiresAt: initialLeaseExpiresAt })
    expect(released).toHaveLength(1)
    expect(released[0]).toMatchObject({ leaseExpiresAt: initialLeaseExpiresAt })
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

  it('exhausts an issue after the bounded final inspection instead of leaving it pending', async () => {
    let exhausted: { id: string; reason: string } | undefined
    let reasonUpdates = 0
    const repository = {
      listActiveAccountSettlements: async () => [
        { accountId: 'acct_1', solanaPublicKey: 'owner' },
      ],
      getIncomingCursor: async () => null,
      saveIncomingCursor: async () => undefined,
      expireOpenReceiveRequests: async () => undefined,
      createIncomingPayment: async () => ({ payment: {} as never, created: true }),
      claimIncomingReconciliationIssues: async () => [
        {
          id: 'issue_1',
          accountId: 'acct_1',
          accountPublicKey: 'owner',
          signature: 'signature-ambiguous',
          reason: 'TRANSACTION_UNAVAILABLE',
          retryCount: 8,
        },
      ],
      resolveIncomingReconciliationIssue: async () => undefined,
      updateIncomingReconciliationIssueReason: async () => {
        reasonUpdates += 1
      },
      exhaustIncomingReconciliationIssue: async (id: string, reason: string) => {
        exhausted = { id, reason }
      },
    }
    const service = new IncomingReconciliationService(
      repository as never,
      {
        scan: async () => [],
        scanWithCursor: async () => ({ transfers: [], nextCursor: null }),
        inspectSignature: async () => ({
          kind: 'UNRESOLVED' as const,
          reason: 'TRANSACTION_UNAVAILABLE' as const,
        }),
      },
      { error: () => undefined },
    )

    await service.runOnce()

    expect(exhausted).toEqual({
      id: 'issue_1',
      reason: 'INCOMING_ISSUE_RETRY_EXHAUSTED',
    })
    expect(reasonUpdates).toBe(0)
  })

  it('leaves the account cursor untouched when shared RPC capacity is exhausted', async () => {
    const harness = createHarness()
    let scans = 0
    const errors: object[] = []
    const service = new IncomingReconciliationService(
      harness.repository as never,
      {
        scan: async () => {
          scans += 1
          return [transfer]
        },
      },
      { error: (data) => errors.push(data) },
      {
        capacity: {
          acquire: async () => ({
            allowed: false,
            count: 50,
            retryAt: new Date('2026-09-18T00:00:01.000Z'),
          }),
        },
      },
    )

    await service.runOnce()

    expect(scans).toBe(0)
    expect(harness.state.cursor).toBeNull()
    expect(errors).toEqual([
      { accountId: 'acct_1', errorCode: 'CAPACITY_BACKPRESSURE' },
    ])
  })
})
