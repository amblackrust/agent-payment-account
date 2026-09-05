import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { createDatabaseClient } from './index.js'

const databaseUrl = process.env.DATABASE_URL?.trim()

describe.skipIf(databaseUrl === undefined || databaseUrl.length === 0)(
  'database account repository',
  () => {
    it('persists accounts, authenticates credentials, tracks use and revokes credentials', async () => {
      const database = createDatabaseClient(databaseUrl as string)
      const accountId = `acct_${randomUUID().replaceAll('-', '')}`
      const credentialId = `cred_${randomUUID().replaceAll('-', '')}`

      try {
        const created = await database.createAgentAccount({
          id: accountId,
          name: 'integration-agent',
          solanaPublicKey: `${accountId}_public`,
          encryptedSolanaSecret: 'ciphertext',
          encryptionNonce: 'bm9uY2U=',
          encryptionAuthTag: 'dGFn',
          credentialId,
          keyHash: `${accountId}_hash`,
          keyPrefix: 'apa_integration',
        })
        const authenticated = await database.findAccountByCredentialHash(
          `${accountId}_hash`,
        )

        expect(created.id).toBe(accountId)
        expect(authenticated?.account.id).toBe(accountId)
        expect(authenticated?.credential.id).toBe(credentialId)
        await database.markCredentialUsed(credentialId)
        expect(await database.revokeCredential(accountId, credentialId)).toBe(true)
        expect(await database.revokeCredential(accountId, credentialId)).toBe(false)
      } finally {
        await database.disconnect()
      }
    })
  },
)
