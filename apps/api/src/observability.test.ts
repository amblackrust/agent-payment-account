import { describe, expect, it } from 'vitest'

import {
  evaluateDomainAlerts,
  MetricsRegistry,
  normalizeCorrelationId,
} from './observability.js'

describe('MetricsRegistry', () => {
  it('renders counters, gauges, and bounded histograms', () => {
    const metrics = new MetricsRegistry()
    metrics.incrementCounter('mux_test_total', { operation: 'payment' })
    metrics.setGauge('mux_test_gauge', 2, { status: 'active' })
    metrics.observeHistogram(
      'mux_test_duration_ms',
      12,
      { outcome: 'confirmed' },
      [10, 25],
    )

    const output = metrics.renderPrometheus()
    expect(output).toContain('mux_test_total{operation="payment"} 1')
    expect(output).toContain('mux_test_gauge{status="active"} 2')
    expect(output).toContain('mux_test_duration_ms{outcome="confirmed",le="25"} 1')
    expect(output).toContain('mux_test_duration_ms_sum{outcome="confirmed"} 12')
  })

  it('rejects resource identifiers and unknown labels', () => {
    const metrics = new MetricsRegistry()
    expect(() =>
      metrics.incrementCounter('mux_test_total', { payment_id: 'pay_1' }),
    ).toThrow('Metric label is not allowed')
    expect(() =>
      metrics.incrementCounter('mux_test_total', { operation: 'payment/1' }),
    ).toThrow('Metric label value is invalid')
  })

  it('normalizes untrusted correlation headers to a request fallback', () => {
    expect(normalizeCorrelationId('trace-123', 'request-1')).toBe('trace-123')
    expect(normalizeCorrelationId('trace value', 'request-1')).toBe('request-1')
    expect(normalizeCorrelationId('x'.repeat(129), 'request-1')).toBe('request-1')
  })

  it('evaluates bounded domain alerts without resource labels', () => {
    const alerts = evaluateDomainAlerts({
      reviewRequiredPayments: 1,
      oldestReviewRequiredAgeSeconds: 600,
      exhaustedIncomingIssues: 1,
      custodyFailures: 1,
      noProgressSeconds: 600,
      databaseSaturationRatio: 0.95,
      dependencyDegraded: true,
      pendingWebhookDeliveries: 1,
      restoreVerificationFailed: true,
      runtimeIdentityMismatch: true,
    })

    expect(alerts.map((alert) => alert.name)).toEqual([
      'REVIEW_REQUIRED_BACKLOG',
      'REVIEW_REQUIRED_AGE',
      'INCOMING_ISSUES_EXHAUSTED',
      'CUSTODY_FAILURES',
      'NO_PROGRESS',
      'DATABASE_SATURATION',
      'DEPENDENCY_DEGRADED',
      'WEBHOOK_BACKLOG',
      'RESTORE_VERIFICATION_FAILED',
      'RUNTIME_IDENTITY_MISMATCH',
    ])
  })
})
