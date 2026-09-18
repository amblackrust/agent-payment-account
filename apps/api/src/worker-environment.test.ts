import { describe, expect, it } from 'vitest'

import { buildBackupChildEnvironment } from './worker-environment.js'

describe('backup child process environment', () => {
  it('does not forward runtime signer or application secrets', () => {
    const environment = buildBackupChildEnvironment(
      {
        databaseUrl: 'postgresql://backup.example.test/app',
        recipient: 'age1recipient',
        identity: '/run/secrets/backup-identity',
        verifyDatabaseUrl: 'postgresql://verify.example.test/app',
        runtimeAuthorityId: 'runtime-authority',
        custodyIdentity: 'custody-identity',
      },
      {
        PATH: '/usr/bin',
        HOME: '/tmp/service',
        PGPASSWORD: 'database-password',
        WALLET_MASTER_KEY: 'production-wallet-master-key',
        SOLANA_FEE_PAYER_SECRET: 'production-fee-payer-secret',
        RECOVERY_ENVELOPE_KEY: 'production-recovery-key',
        ADMIN_API_KEY: 'production-admin-key',
        WEBHOOK_SIGNING_KEYS_JSON: '{"key:1":"secret"}',
        NODE_OPTIONS: '--require=/tmp/untrusted.js',
        DATABASE_URL: 'postgresql://wrong.example.test/app',
      },
    )

    expect(environment).toMatchObject({
      PATH: '/usr/bin',
      HOME: '/tmp/service',
      PGPASSWORD: 'database-password',
      DATABASE_URL: 'postgresql://backup.example.test/app',
      BACKUP_AGE_RECIPIENT: 'age1recipient',
      BACKUP_AGE_IDENTITY: '/run/secrets/backup-identity',
      BACKUP_VERIFY_DATABASE_URL: 'postgresql://verify.example.test/app',
      BACKUP_VERIFY_RUNTIME_AUTHORITY_ID: 'runtime-authority',
      BACKUP_VERIFY_CUSTODY_IDENTITY: 'custody-identity',
    })
    expect(environment).not.toHaveProperty('WALLET_MASTER_KEY')
    expect(environment).not.toHaveProperty('SOLANA_FEE_PAYER_SECRET')
    expect(environment).not.toHaveProperty('RECOVERY_ENVELOPE_KEY')
    expect(environment).not.toHaveProperty('ADMIN_API_KEY')
    expect(environment).not.toHaveProperty('WEBHOOK_SIGNING_KEYS_JSON')
    expect(environment).not.toHaveProperty('NODE_OPTIONS')
  })
})
