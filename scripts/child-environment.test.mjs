import { describe, expect, it } from 'vitest'

import { buildChildProcessEnvironment } from './child-environment.mjs'

describe('child process environment', () => {
  it('preserves runtime settings but excludes inherited application secrets', () => {
    const environment = buildChildProcessEnvironment(
      { DATABASE_URL: 'postgresql://local.example.test/app' },
      {
        PATH: '/usr/bin',
        HOME: '/tmp/developer',
        PGPASSWORD: 'database-password',
        DOCKER_HOST: 'unix:///run/docker.sock',
        DATABASE_URL: 'postgresql://production.example.test/app',
        WALLET_MASTER_KEY: 'production-wallet-key',
        SOLANA_FEE_PAYER_SECRET: 'production-fee-payer-secret',
        ADMIN_API_KEY: 'production-admin-key',
        NODE_OPTIONS: '--require=/tmp/untrusted.js',
      },
    )

    expect(environment).toMatchObject({
      PATH: '/usr/bin',
      HOME: '/tmp/developer',
      DOCKER_HOST: 'unix:///run/docker.sock',
      DATABASE_URL: 'postgresql://local.example.test/app',
    })
    expect(environment).not.toHaveProperty('PGPASSWORD')
    expect(environment).not.toHaveProperty('WALLET_MASTER_KEY')
    expect(environment).not.toHaveProperty('SOLANA_FEE_PAYER_SECRET')
    expect(environment).not.toHaveProperty('ADMIN_API_KEY')
    expect(environment).not.toHaveProperty('NODE_OPTIONS')
  })
})
