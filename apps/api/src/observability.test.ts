import { describe, expect, it } from 'vitest'

import { MetricsRegistry } from './observability.js'

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
})
