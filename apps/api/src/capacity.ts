import type { RuntimeLimits } from './config.js'

export type CapacityDependency = 'database' | 'rpc' | 'custody' | 'rail' | 'webhook'

export interface DurableCapacityRepository {
  consumeRateLimit(input: {
    readonly subjectType: string
    readonly subjectId: string
    readonly bucket: string
    readonly windowSeconds: number
    readonly limit: number
    readonly now?: Date
  }): Promise<{
    readonly allowed: boolean
    readonly count: number
    readonly retryAt: Date
  }>
}

export interface CapacityResult {
  readonly allowed: boolean
  readonly count: number
  readonly retryAt: Date
}

/**
 * Uses the durable rate-limit table as a shared dependency budget. The stable
 * global subject makes the budget process- and replica-independent; limits
 * therefore cannot multiply when another worker starts.
 */
export class DurableCapacityController {
  public constructor(
    private readonly repository: DurableCapacityRepository,
    private readonly limits: RuntimeLimits,
    private readonly subjectId = 'global',
  ) {}

  public acquire(
    dependency: CapacityDependency,
    now: Date = new Date(),
  ): Promise<CapacityResult> {
    return this.repository.consumeRateLimit({
      subjectType: 'RUNTIME_CAPACITY',
      subjectId: this.subjectId,
      bucket: dependency,
      windowSeconds: this.limits.capacityWindowSeconds,
      limit: this.limitFor(dependency),
      now,
    })
  }

  private limitFor(dependency: CapacityDependency): number {
    switch (dependency) {
      case 'database':
        return this.limits.databaseCapacityPerWindow
      case 'rpc':
        return this.limits.rpcCapacityPerWindow
      case 'custody':
        return this.limits.custodyCapacityPerWindow
      case 'rail':
        return this.limits.railCapacityPerWindow
      case 'webhook':
        return this.limits.webhookCapacityPerWindow
    }
  }
}

export function retryAtAfter(preferredRetryAt: Date, fallbackRetryAt: Date): Date {
  return preferredRetryAt.getTime() >= fallbackRetryAt.getTime()
    ? preferredRetryAt
    : fallbackRetryAt
}
