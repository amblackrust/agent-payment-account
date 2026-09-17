export async function waitForShutdown(
  operation: Promise<void>,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<void> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('Shutdown timeout must be a positive integer')
  }
  let timer: NodeJS.Timeout | undefined
  let timedOut = false
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true
      resolve()
    }, timeoutMs)
  })

  try {
    await Promise.race([operation, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
  if (timedOut) onTimeout()
}
