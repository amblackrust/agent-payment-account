import { randomUUID } from 'node:crypto'

export function createRuntimeOwner(role: string, processId = process.pid): string {
  return `${role}-${processId}-${randomUUID()}`
}
