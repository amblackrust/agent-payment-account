import { describe, expect, it, vi } from 'vitest'

import type {
  ReceiveRepository,
  ReceiveRequestRecord,
  V2AdminRepository,
  V2DatabaseRepository,
} from '@agent-payment/db'
import type { SolanaRail } from '@agent-payment/solana-rail'
import { V2ReceiveService } from './receives.js'

const denomination = {
  id: 'usd',
  symbol: 'USD',
  maxScale: 2,
  status: 'ACTIVE' as const,
  version: 1,
}

const now = new Date('2026-09-18T00:00:00.000Z')

function createReceiveRecord(input: {
  readonly id: string
  readonly amountAtomic: bigint | null
  readonly amountScale: number | null
  readonly reference: string
  readonly createdAt: Date
}): ReceiveRequestRecord {
  return {
    id: input.id,
    accountId: 'acct_1',
    amountAtomic: input.amountAtomic,
    denominationId: denomination.id,
    amountScale: input.amountScale,
    currency: denomination.symbol,
    reference: input.reference,
    status: 'OPEN',
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    expiresAt: null,
    paidAt: null,
    matchedIncomingPaymentId: null,
  }
}

function createService() {
  const idempotentRequests: Parameters<
    V2AdminRepository['createReceiveRequestIdempotent']
  >[0][] = []
  const records = new Map<string, ReceiveRequestRecord>()
  const createReceiveRequestIdempotent = vi.fn(
    async (
      input: Parameters<V2AdminRepository['createReceiveRequestIdempotent']>[0],
    ) => {
      idempotentRequests.push(input)
      const existing = records.get(input.idempotencyKey)
      if (existing !== undefined) return existing
      const record = createReceiveRecord({
        id: input.id,
        amountAtomic: input.amountAtomic ?? null,
        amountScale: input.amountScale ?? null,
        reference: input.reference,
        createdAt: input.createdAt,
      })
      records.set(input.idempotencyKey, record)
      return record
    },
  )
  const repository = {
    createReceiveRequest: vi.fn(),
  } as unknown as ReceiveRepository
  const v2Repository = {
    findDenomination: vi.fn(async () => denomination),
  } as unknown as V2DatabaseRepository
  const adminRepository = {
    createReceiveRequestIdempotent,
  } as unknown as V2AdminRepository
  const rail = {
    getReceiveDestination: vi.fn(async () => ({
      owner: 'owner-address',
      tokenAccount: 'token-account',
      settlementMint: 'mint-address',
    })),
  } as unknown as SolanaRail
  const service = new V2ReceiveService(
    repository,
    v2Repository,
    adminRepository,
    rail,
    () => now,
  )
  return { service, createReceiveRequestIdempotent, idempotentRequests }
}

describe('V2ReceiveService', () => {
  it('hashes caller intent so generated references and equivalent amounts remain idempotent', async () => {
    const { service, idempotentRequests } = createService()

    const first = await service.createReceiveRequest(
      'acct_1',
      'owner-address',
      { denominationId: 'usd', amount: '1.20' },
      'receive-key',
    )
    const replay = await service.createReceiveRequest(
      'acct_1',
      'owner-address',
      { denominationId: 'usd', amount: '1.2' },
      'receive-key',
    )

    expect(replay.id).toBe(first.id)
    expect(idempotentRequests[0]?.requestHash).toBe(idempotentRequests[1]?.requestHash)
    expect(idempotentRequests[0]?.reference).not.toBe(idempotentRequests[1]?.reference)
  })

  it('rejects an explicitly blank reference instead of silently generating one', async () => {
    const { service } = createService()

    await expect(
      service.createReceiveRequest(
        'acct_1',
        'owner-address',
        { denominationId: 'usd', reference: '   ' },
        'receive-key',
      ),
    ).rejects.toThrow('Receive reference must not be blank')
  })

  it('requires receive expiration to be a future RFC3339 instant', async () => {
    const { service } = createService()

    await expect(
      service.createReceiveRequest(
        'acct_1',
        'owner-address',
        { denominationId: 'usd', expiresAt: '2026-09-19' },
        'receive-key',
      ),
    ).rejects.toThrow('Receive expiration must be a valid date')
  })
})
