import { describe, expect, it } from 'vitest'

import { DatabaseConfigurationError, requireDatabaseUrl } from './prisma-env.js'

describe('Prisma database configuration', () => {
  it('requires an explicit DATABASE_URL', () => {
    expect(() => requireDatabaseUrl({})).toThrow(DatabaseConfigurationError)
    expect(() => requireDatabaseUrl({ DATABASE_URL: '   ' })).toThrow(
      'DATABASE_URL is required for Prisma tooling',
    )
  })

  it('returns the configured URL without applying a fallback', () => {
    expect(requireDatabaseUrl({ DATABASE_URL: ' postgres://db.example/app ' })).toBe(
      'postgres://db.example/app',
    )
  })
})
