import { describe, expect, it } from 'vitest'
import { ExternalRailError } from './errors.js'
import { classifyWorkFailure, computeRetryAt } from './retry.js'

describe('durable work retry classification', () => {
  it('does not retry deterministic rail failures', () => {
    const decision = classifyWorkFailure(
      new ExternalRailError('invalid destination', undefined, 'DETERMINISTIC'),
      'RAIL',
    )
    expect(decision.classification).toBe('NO_RETRY')
    expect(decision.retryable).toBe(false)
  })

  it('routes ambiguous rail failures to reconciliation', () => {
    const decision = classifyWorkFailure(
      new ExternalRailError('response lost', undefined, 'AMBIGUOUS'),
      'RPC',
    )
    expect(decision.classification).toBe('AMBIGUOUS_RECONCILIATION')
  })

  it('honours Retry-After while keeping exponential jitter bounded', () => {
    const now = new Date('2026-01-01T00:00:00.000Z')
    const retryAt = computeRetryAt({
      now,
      attemptCount: 2,
      retryAfterMs: 5_000,
      jitterRatio: 0,
      random: () => 0.5,
    })
    expect(retryAt.getTime() - now.getTime()).toBe(5_000)
  })
})
