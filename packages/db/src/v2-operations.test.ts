import { afterEach, describe, expect, it, vi } from 'vitest'

import { createV2OperationsRepository } from './v2-operations.js'

afterEach(() => {
  vi.useRealTimers()
})

describe('V2 operations domain health', () => {
  it('reports the age of the oldest currently review-required payment', async () => {
    const now = new Date('2026-09-18T00:10:00.000Z')
    vi.useFakeTimers()
    vi.setSystemTime(now)

    const payment = {
      count: vi.fn(async () => 2),
      findFirst: vi.fn(async () => ({
        updatedAt: new Date('2026-09-18T00:00:00.000Z'),
      })),
    }
    const prisma = {
      payment,
      incomingReconciliationIssue: {
        count: vi.fn(async () => 0),
      },
      webhookDelivery: {
        count: vi.fn(async () => 0),
      },
    }

    const health = await createV2OperationsRepository(
      prisma as never,
    ).getDomainHealth?.()

    expect(health).toMatchObject({
      reviewRequiredPayments: 2,
      oldestReviewRequiredAgeSeconds: 600,
      exhaustedIncomingIssues: 0,
      pendingWebhookDeliveries: 0,
    })
    expect(payment.findFirst).toHaveBeenCalledWith({
      where: { status: 'REVIEW_REQUIRED' },
      orderBy: { updatedAt: 'asc' },
      select: { updatedAt: true },
    })
  })

  it('reports no review age when the review queue is empty', async () => {
    const payment = {
      count: vi.fn(async () => 0),
      findFirst: vi.fn(async () => null),
    }
    const prisma = {
      payment,
      incomingReconciliationIssue: { count: vi.fn(async () => 0) },
      webhookDelivery: { count: vi.fn(async () => 0) },
    }

    const health = await createV2OperationsRepository(
      prisma as never,
    ).getDomainHealth?.()

    expect(health?.oldestReviewRequiredAgeSeconds).toBeNull()
  })
})
