const ALLOWED_LABELS = new Set([
  'operation',
  'rail',
  'status',
  'outcome',
  'dependency',
  'result',
  'error_code',
])

const DEFAULT_HISTOGRAM_BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000]

export interface DomainHealthSnapshot {
  readonly status: 'ok' | 'degraded'
  readonly checks: Readonly<Record<string, 'ok' | 'degraded'>>
}

export interface DomainHealthDependency {
  checkDomainHealth(): Promise<DomainHealthSnapshot>
}

interface HistogramState {
  readonly buckets: readonly number[]
  readonly counts: number[]
  sum: number
  count: number
}

/**
 * A deliberately small in-process registry is enough for the current runtime.
 * The database remains the source of truth for workflow state; these values
 * are disposable process telemetry and are never used for financial decisions.
 */
export class MetricsRegistry {
  private readonly counters = new Map<string, number>()
  private readonly gauges = new Map<string, number>()
  private readonly histograms = new Map<string, HistogramState>()

  public incrementCounter(
    name: string,
    labels: Readonly<Record<string, string>> = {},
    value = 1,
  ): void {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error('Metric counter increment must be finite and non-negative')
    }
    const key = metricKey(name, labels)
    this.counters.set(key, (this.counters.get(key) ?? 0) + value)
  }

  public setGauge(
    name: string,
    value: number,
    labels: Readonly<Record<string, string>> = {},
  ): void {
    if (!Number.isFinite(value)) throw new Error('Metric gauge must be finite')
    this.gauges.set(metricKey(name, labels), value)
  }

  public observeHistogram(
    name: string,
    value: number,
    labels: Readonly<Record<string, string>> = {},
    buckets = DEFAULT_HISTOGRAM_BUCKETS,
  ): void {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error('Metric histogram observation must be finite and non-negative')
    }
    const normalizedBuckets = [...buckets]
    if (
      normalizedBuckets.length === 0 ||
      normalizedBuckets.some((bucket, index) => {
        const previous = index === 0 ? undefined : normalizedBuckets[index - 1]
        return (
          !Number.isFinite(bucket) ||
          bucket <= 0 ||
          (previous !== undefined && bucket <= previous)
        )
      })
    ) {
      throw new Error('Metric histogram buckets must be strictly increasing')
    }
    const key = metricKey(name, labels)
    let state = this.histograms.get(key)
    if (state === undefined) {
      state = {
        buckets: normalizedBuckets,
        counts: normalizedBuckets.map(() => 0),
        sum: 0,
        count: 0,
      }
      this.histograms.set(key, state)
    }
    if (state.buckets.join(',') !== normalizedBuckets.join(',')) {
      throw new Error('Metric histogram buckets cannot change for a metric')
    }
    state.sum += value
    state.count += 1
    state.buckets.forEach((bucket, index) => {
      const currentCount = state?.counts[index]
      if (value <= bucket && currentCount !== undefined) {
        state.counts[index] = currentCount + 1
      }
    })
  }

  public renderPrometheus(): string {
    const lines: string[] = []
    for (const [key, value] of this.counters) lines.push(`${key} ${value}`)
    for (const [key, value] of this.gauges) lines.push(`${key} ${value}`)
    for (const [key, state] of this.histograms) {
      const separator = key.indexOf('{') === -1 ? '' : ','
      state.buckets.forEach((bucket, index) => {
        const labels = key.includes('{')
          ? key.replace(/}$/, `${separator}le="${bucket}"}`)
          : `${key}{le="${bucket}"}`
        lines.push(`${labels} ${state.counts[index]}`)
      })
      const totalLabels = key.includes('{')
        ? key.replace(/}$/, `${separator}le="+Inf"}`)
        : `${key}{le="+Inf"}`
      lines.push(`${totalLabels} ${state.count}`)
      lines.push(
        `${key.replace(/\{.*$/u, '')}_sum${key.includes('{') ? key.slice(key.indexOf('{')) : ''} ${state.sum}`,
      )
      lines.push(
        `${key.replace(/\{.*$/u, '')}_count${key.includes('{') ? key.slice(key.indexOf('{')) : ''} ${state.count}`,
      )
    }
    return lines.length === 0 ? '' : `${lines.join('\n')}\n`
  }
}

function metricKey(name: string, labels: Readonly<Record<string, string>>): string {
  if (!/^[a-zA-Z_:][a-zA-Z0-9_:]*$/u.test(name)) {
    throw new Error(`Metric name is invalid: ${name}`)
  }
  const entries = Object.entries(labels).sort(([left], [right]) =>
    left.localeCompare(right),
  )
  for (const [label, value] of entries) {
    if (!ALLOWED_LABELS.has(label))
      throw new Error(`Metric label is not allowed: ${label}`)
    if (!/^[a-zA-Z0-9_.:-]{1,64}$/u.test(value)) {
      throw new Error(`Metric label value is invalid: ${label}`)
    }
  }
  if (entries.length === 0) return name
  return `${name}{${entries.map(([label, value]) => `${label}="${escapeLabel(value)}"`).join(',')}}`
}

function escapeLabel(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n')
}
