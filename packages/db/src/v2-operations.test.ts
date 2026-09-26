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
      durableWorkItem: {
        findFirst: vi.fn(async () => null),
      },
      incomingReconciliationIssue: {
        count: vi.fn(async () => 0),
      },
      operationalException: {
        count: vi.fn(async () => 0),
      },
      webhookDelivery: {
        count: vi.fn(async () => 0),
      },
      backupRestoreVerification: {
        findFirst: vi.fn(async () => null),
      },
    }

    const health = await createV2OperationsRepository(
      prisma as never,
    ).getDomainHealth?.()

    expect(health).toMatchObject({
      reviewRequiredPayments: 2,
      oldestReviewRequiredAgeSeconds: 600,
      oldestWorkItemAgeSeconds: null,
      exhaustedIncomingIssues: 0,
      pendingWebhookDeliveries: 0,
      restoreVerificationFailed: false,
    })
    expect(payment.findFirst).toHaveBeenCalledWith({
      where: { status: 'REVIEW_REQUIRED' },
      orderBy: { updatedAt: 'asc' },
      select: { updatedAt: true },
    })
  })

  it('requires evidence for the current payment attempt when resolving an exception', async () => {
    const exception = {
      id: 'exception-1',
      accountId: 'account-1',
      resourceType: 'PAYMENT',
      resourceId: 'payment-1',
      dedupeKey: 'payment:payment-1',
      status: 'OPEN',
      severity: 'ERROR',
      reasonCode: 'OUTCOME_UNKNOWN',
      detailsJson: '{}',
      assignedTo: null,
      rowVersion: 1,
      createdAt: new Date('2026-09-18T00:00:00.000Z'),
      updatedAt: new Date('2026-09-18T00:00:00.000Z'),
      acknowledgedAt: null,
      resolvedAt: null,
    }
    const payment = {
      id: 'payment-1',
      payerAccountId: 'account-1',
      status: 'REVIEW_REQUIRED',
      correlationId: null,
    }
    const evidenceRecord = {
      id: 'evidence-old',
      paymentId: 'payment-1',
      attemptId: 'attempt-old',
      authority: 'RAIL',
      outcome: 'CONFIRMED',
      observedAt: new Date('2026-09-18T00:01:00.000Z'),
    }
    const transaction = {
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([{ id: exception.id }])
        .mockResolvedValueOnce([{ id: payment.id }]),
      operationalException: {
        findUnique: vi.fn(async () => exception),
        update: vi.fn(async () => ({ ...exception, status: 'RESOLVED' })),
      },
      payment: {
        findUnique: vi.fn(async () => payment),
        update: vi.fn(async () => payment),
      },
      paymentAttempt: {
        findMany: vi.fn(async () => [
          { id: 'attempt-old', attemptNumber: 1, outcome: 'CONFIRMED' },
          { id: 'attempt-new', attemptNumber: 2, outcome: 'UNKNOWN' },
        ]),
        update: vi.fn(),
      },
      evidenceRecord: {
        findFirst: vi.fn(async ({ where }: { where: { attemptId?: string } }) =>
          where.attemptId === 'attempt-new' ? null : evidenceRecord,
        ),
      },
      outgoingReservation: { updateMany: vi.fn() },
      operationTimelineEvent: { create: vi.fn() },
    }
    const prisma = {
      $transaction: vi.fn(async (callback: (value: typeof transaction) => unknown) =>
        callback(transaction),
      ),
    }

    await expect(
      createV2OperationsRepository(prisma as never).resolveConfirmedException({
        id: exception.id,
        operatorId: 'operator-1',
        rowVersion: exception.rowVersion,
        evidenceId: evidenceRecord.id,
      }),
    ).rejects.toThrow('Authoritative CONFIRMED evidence is required')
    expect(transaction.evidenceRecord.findFirst).toHaveBeenCalledWith({
      where: {
        paymentId: payment.id,
        attemptId: 'attempt-new',
        id: evidenceRecord.id,
        outcome: 'CONFIRMED',
      },
      orderBy: { observedAt: 'desc' },
    })
  })

  it('exhausts expired final webhook deliveries during claim cleanup', async () => {
    const now = new Date('2026-09-18T00:10:00.000Z')
    const delivery = {
      id: 'delivery-final',
      eventId: 'event-1',
      subscriptionId: 'subscription-1',
      status: 'CLAIMED',
      leaseOwner: 'dead-worker',
      leaseExpiresAt: new Date('2026-09-18T00:09:00.000Z'),
      attemptCount: 3,
      availableAt: new Date('2026-09-18T00:00:00.000Z'),
      errorSafe: 'last delivery failure',
    }
    const transaction = {
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([{ id: delivery.id }])
        .mockResolvedValueOnce([]),
      webhookDelivery: {
        findUnique: vi.fn(async () => delivery),
        update: vi.fn(async () => ({ ...delivery, status: 'EXHAUSTED' })),
      },
      webhookSubscription: {
        findUnique: vi.fn(async () => ({ accountId: 'account-1' })),
      },
      operationalException: { upsert: vi.fn() },
      operationTimelineEvent: { create: vi.fn() },
    }
    const prisma = {
      $transaction: vi.fn(async (callback: (value: typeof transaction) => unknown) =>
        callback(transaction),
      ),
    }

    await expect(
      createV2OperationsRepository(prisma as never).claimWebhookDeliveries({
        limit: 1,
        owner: 'new-worker',
        leaseSeconds: 60,
        maxAttempts: 3,
        now,
      }),
    ).resolves.toEqual([])

    expect(transaction.webhookDelivery.update).toHaveBeenCalledWith({
      where: { id: delivery.id },
      data: {
        status: 'EXHAUSTED',
        nextRetryAt: null,
        availableAt: delivery.availableAt,
        errorSafe: delivery.errorSafe,
        leaseOwner: null,
        leaseExpiresAt: null,
      },
    })
    expect(transaction.operationalException.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { activeDedupeKey: `active:webhook:${delivery.id}` },
        create: expect.objectContaining({
          resourceType: 'WEBHOOK_DELIVERY',
          resourceId: delivery.id,
          reasonCode: 'WEBHOOK_DELIVERY_EXHAUSTED',
        }),
      }),
    )
    expect(transaction.operationTimelineEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          resourceType: 'WEBHOOK_DELIVERY',
          resourceId: delivery.id,
          eventType: 'WEBHOOK_DELIVERY_EXHAUSTED',
        }),
      }),
    )
  })

  it('reports no review age when the review queue is empty', async () => {
    const payment = {
      count: vi.fn(async () => 0),
      findFirst: vi.fn(async () => null),
    }
    const prisma = {
      payment,
      durableWorkItem: { findFirst: vi.fn(async () => null) },
      incomingReconciliationIssue: { count: vi.fn(async () => 0) },
      operationalException: { count: vi.fn(async () => 0) },
      webhookDelivery: { count: vi.fn(async () => 0) },
      backupRestoreVerification: { findFirst: vi.fn(async () => null) },
    }

    const health = await createV2OperationsRepository(
      prisma as never,
    ).getDomainHealth?.()

    expect(health?.oldestReviewRequiredAgeSeconds).toBeNull()
    expect(health?.oldestWorkItemAgeSeconds).toBeNull()
    expect(health?.restoreVerificationFailed).toBe(false)
  })
})
