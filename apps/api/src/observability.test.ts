import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import {
  createDomainHealthSnapshot,
  evaluateDomainAlerts,
  MetricsRegistry,
  normalizeCorrelationId,
  recordDomainHealthMetrics,
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

  it('uses explicitly supplied thresholds for domain health evaluation', () => {
    const snapshot = createDomainHealthSnapshot({
      health: {
        reviewRequiredPayments: 2,
        oldestReviewRequiredAgeSeconds: 120,
        exhaustedIncomingIssues: 0,
        pendingWebhookDeliveries: 2,
      },
      dependencyDegraded: false,
      thresholds: {
        reviewRequiredBacklog: 3,
        reviewRequiredAgeSeconds: 300,
        noProgressSeconds: 300,
        databaseSaturationRatio: 0.9,
        webhookBacklog: 3,
      },
    })

    expect(snapshot.alerts).toEqual([])
  })

  it('projects durable health data into checks without dropping alert categories', () => {
    const snapshot = createDomainHealthSnapshot({
      health: {
        reviewRequiredPayments: 0,
        oldestReviewRequiredAgeSeconds: null,
        oldestWorkItemAgeSeconds: 600,
        exhaustedIncomingIssues: 0,
        custodyFailures: 1,
        databaseSaturationRatio: 0.95,
        pendingWebhookDeliveries: 0,
        restoreVerificationFailed: false,
        runtimeIdentityMismatch: true,
      },
      dependencyDegraded: false,
    })

    expect(snapshot.status).toBe('degraded')
    expect(snapshot.checks).toMatchObject({
      custody: 'degraded',
      database_saturation: 'degraded',
      no_progress: 'degraded',
      runtime_identity: 'degraded',
    })
    expect(snapshot.alerts?.map((alert) => alert.name)).toEqual([
      'CUSTODY_FAILURES',
      'NO_PROGRESS',
      'DATABASE_SATURATION',
      'RUNTIME_IDENTITY_MISMATCH',
    ])
  })

  it('exports fixed-cardinality domain alert gauges for deployment rules', () => {
    const metrics = new MetricsRegistry()
    const snapshot = createDomainHealthSnapshot({
      health: {
        reviewRequiredPayments: 1,
        oldestReviewRequiredAgeSeconds: null,
        exhaustedIncomingIssues: 0,
        pendingWebhookDeliveries: 0,
      },
      dependencyDegraded: false,
    })

    recordDomainHealthMetrics(metrics, snapshot)

    const output = metrics.renderPrometheus()
    expect(output).toContain('mux_domain_health_status 0')
    expect(output).toContain(
      'mux_domain_alert_active{alert="REVIEW_REQUIRED_BACKLOG"} 1',
    )
    expect(output).toContain(
      'mux_domain_alert_active{alert="RUNTIME_IDENTITY_MISMATCH"} 0',
    )
  })

  it('keeps the deployable alert rules aligned with fixed-cardinality domain alerts', () => {
    const rules = readFileSync(
      new URL('../../../ops/prometheus/mux-v2-alerts.yml', import.meta.url),
      'utf8',
    )
    const alertNames = [
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
    ] as const

    for (const name of alertNames) {
      expect(rules).toContain(`alert="${name}"`)
    }
    expect(rules).not.toMatch(/(?:payment|account|resource)_id/u)
  })
})
