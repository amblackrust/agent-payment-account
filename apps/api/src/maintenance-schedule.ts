export class MaintenanceSchedule {
  private nextRunAt = 0

  public constructor(
    private readonly intervalMs: number,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) {
      throw new RangeError('Maintenance interval must be a positive safe integer')
    }
  }

  public claim(): boolean {
    const currentTime = this.now()
    if (currentTime < this.nextRunAt) return false
    this.nextRunAt = currentTime + this.intervalMs
    return true
  }
}
