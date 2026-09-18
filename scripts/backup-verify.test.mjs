import { describe, expect, it } from 'vitest'

import {
  buildExternalCommandEnvironment,
  prepareDatabaseConnection,
} from './backup-verify.mjs'

describe('backup command security boundaries', () => {
  it('keeps database passwords out of child-process arguments', () => {
    const connection = prepareDatabaseConnection(
      'postgresql://backup-user:p%40ssword@db.example.test/mux?sslmode=require',
    )

    expect(connection.connectionString).toBe(
      'postgresql://backup-user@db.example.test/mux?sslmode=require',
    )
    expect(connection.environment).toEqual({ PGPASSWORD: 'p@ssword' })
    expect(connection.connectionString).not.toContain('p%40ssword')
  })

  it('does not inherit application secrets into external backup tools', () => {
    const environment = buildExternalCommandEnvironment(
      { PGPASSWORD: 'database-password' },
      {
        PATH: '/bin',
        HOME: '/tmp',
        DATABASE_URL: 'postgresql://db-user:database-password@db.example.test/mux',
        ADMIN_API_KEY: 'admin-secret',
        WALLET_MASTER_KEY: 'wallet-secret',
      },
    )

    expect(environment).toMatchObject({
      PATH: '/bin',
      HOME: '/tmp',
      PGPASSWORD: 'database-password',
    })
    expect(environment).not.toHaveProperty('DATABASE_URL')
    expect(environment).not.toHaveProperty('ADMIN_API_KEY')
    expect(environment).not.toHaveProperty('WALLET_MASTER_KEY')
  })
})
