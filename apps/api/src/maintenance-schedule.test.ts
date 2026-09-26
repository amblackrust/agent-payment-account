import { describe, expect, it } from 'vitest'

import { MaintenanceSchedule } from './maintenance-schedule.js'

describe('maintenance schedule', () => {
  it('does not reuse the worker loop as the backup cadence', () => {
    let now = 1_000
    const schedule = new MaintenanceSchedule(60_000, () => now)

    expect(schedule.claim()).toBe(true)
    expect(schedule.claim()).toBe(false)

    now += 60_000
    expect(schedule.claim()).toBe(true)
  })

  it('rejects an invalid interval', () => {
    expect(() => new MaintenanceSchedule(0)).toThrow(RangeError)
  })
})
