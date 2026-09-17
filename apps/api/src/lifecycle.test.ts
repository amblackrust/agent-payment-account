import { afterEach, describe, expect, it, vi } from 'vitest'

import { waitForShutdown } from './lifecycle.js'

afterEach(() => {
  vi.useRealTimers()
})

describe('waitForShutdown', () => {
  it('does not invoke the timeout handler when the operation completes in time', async () => {
    const onTimeout = vi.fn()

    await waitForShutdown(Promise.resolve(), 1_000, onTimeout)

    expect(onTimeout).not.toHaveBeenCalled()
  })

  it('invokes the timeout handler when the operation exceeds the deadline', async () => {
    vi.useFakeTimers()
    const onTimeout = vi.fn()
    let resolveOperation!: () => void
    const operation = new Promise<void>((resolve) => {
      resolveOperation = resolve
    })
    const shutdown = waitForShutdown(operation, 1_000, onTimeout)

    await vi.advanceTimersByTimeAsync(1_000)
    await shutdown

    expect(onTimeout).toHaveBeenCalledOnce()
    resolveOperation()
  })

  it('rejects invalid deadlines', async () => {
    await expect(waitForShutdown(Promise.resolve(), 0, vi.fn())).rejects.toThrow(
      'Shutdown timeout must be a positive integer',
    )
  })
})
