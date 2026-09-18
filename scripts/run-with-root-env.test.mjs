import { describe, expect, it } from 'vitest'

import { buildChildEnvironment } from './run-with-root-env.mjs'

describe('root environment launcher', () => {
  it('keeps project values while dropping unrelated shell secrets', () => {
    const environment = buildChildEnvironment(
      {
        DATABASE_URL: 'postgresql://local.example.test/app',
        NODE_ENV: 'development',
        WALLET_MASTER_KEY: 'local-wallet-key',
      },
      {
        PATH: '/usr/bin',
        HOME: '/tmp/developer',
        COREPACK_HOME: '/tmp/corepack',
        DATABASE_URL: 'postgresql://shell.example.test/app',
        WALLET_MASTER_KEY: 'production-wallet-key',
        ADMIN_API_KEY: 'production-admin-key',
        NODE_OPTIONS: '--require=/tmp/untrusted.js',
        UNRELATED_SECRET: 'must-not-leak',
      },
      true,
    )

    expect(environment).toMatchObject({
      PATH: '/usr/bin',
      HOME: '/tmp/developer',
      COREPACK_HOME: '/tmp/corepack',
      DATABASE_URL: 'postgresql://local.example.test/app',
      NODE_ENV: 'development',
      WALLET_MASTER_KEY: 'local-wallet-key',
    })
    expect(environment).not.toHaveProperty('ADMIN_API_KEY')
    expect(environment).not.toHaveProperty('NODE_OPTIONS')
    expect(environment).not.toHaveProperty('UNRELATED_SECRET')
  })

  it('allows the explicitly required database variable when optional .env is absent', () => {
    const environment = buildChildEnvironment(
      {},
      {
        DATABASE_URL: 'postgresql://shell.example.test/app',
        WALLET_MASTER_KEY: 'production-wallet-key',
        ADMIN_API_KEY: 'production-admin-key',
      },
      false,
      'DATABASE_URL',
    )

    expect(environment.DATABASE_URL).toBe('postgresql://shell.example.test/app')
    expect(environment).not.toHaveProperty('WALLET_MASTER_KEY')
    expect(environment).not.toHaveProperty('ADMIN_API_KEY')
  })
})
