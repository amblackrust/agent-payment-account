import { describe, expect, it } from 'vitest'

import { createRuntimeOwner } from './runtime-owner.js'

describe('runtime lease owner identity', () => {
  it('creates a unique owner for every worker instance even when the pid is reused', () => {
    const first = createRuntimeOwner('incoming', 42)
    const second = createRuntimeOwner('incoming', 42)

    expect(first).not.toBe(second)
    expect(first).toMatch(/^incoming-42-[0-9a-f-]{36}$/)
    expect(second).toMatch(/^incoming-42-[0-9a-f-]{36}$/)
  })
})
