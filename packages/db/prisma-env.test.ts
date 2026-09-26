import { describe, expect, it } from 'vitest'

import {
  assertDotenvIsNotProduction,
  DatabaseConfigurationError,
  requireDatabaseUrl,
  shouldLoadLocalDotenv,
} from './prisma-env.js'

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

  it('does not load local dotenv configuration for production', () => {
    expect(shouldLoadLocalDotenv({ NODE_ENV: 'production' })).toBe(false)
    expect(shouldLoadLocalDotenv({ NODE_ENV: 'test' })).toBe(true)
    expect(shouldLoadLocalDotenv({})).toBe(true)
  })

  it('rejects a dotenv file that declares production', () => {
    expect(() => assertDotenvIsNotProduction({ NODE_ENV: 'production' })).toThrow(
      'production must use its secret backend',
    )
    expect(() => assertDotenvIsNotProduction({ NODE_ENV: 'development' })).not.toThrow()
  })
})
