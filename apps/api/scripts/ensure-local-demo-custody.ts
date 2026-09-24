import { createDatabaseClient } from '@agent-payment/db'
import { fingerprintWalletMasterKey } from '../src/custody.js'

class LocalDemoCustodySetupError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = 'LocalDemoCustodySetupError'
  }
}

const databaseUrl = process.env.DATABASE_URL?.trim()
const backendIdentity = process.env.CUSTODY_BACKEND_IDENTITY?.trim()
const walletMasterKey = process.env.WALLET_MASTER_KEY?.trim()
const accountId = process.argv[2]?.trim()

function requireSetting(value: string | undefined, name: string): string {
  if (value === undefined || value.length === 0) {
    throw new LocalDemoCustodySetupError(`${name} is required for local demo custody setup`)
  }
  return value
}

function matchesExpectedVersion(
  record: {
    readonly accountId: string | null
    readonly keyVersion: number
    readonly backendIdentity: string
    readonly keyReference: string
    readonly rootKeyFingerprint: string
  },
  expected: {
    readonly accountId: string
    readonly backendIdentity: string
    readonly keyReference: string
    readonly rootKeyFingerprint: string
  },
): boolean {
  return record.accountId === expected.accountId &&
    record.keyVersion === 1 &&
    record.backendIdentity === expected.backendIdentity &&
    record.keyReference === expected.keyReference &&
    record.rootKeyFingerprint.trimEnd() === expected.rootKeyFingerprint
}

async function main(): Promise<void> {
  const configuredDatabaseUrl = requireSetting(databaseUrl, 'DATABASE_URL')
  const configuredBackendIdentity = requireSetting(
    backendIdentity,
    'CUSTODY_BACKEND_IDENTITY',
  )
  const configuredWalletMasterKey = requireSetting(walletMasterKey, 'WALLET_MASTER_KEY')
  const configuredAccountId = requireSetting(accountId, 'account id')
  if (configuredAccountId.length > 64) {
    throw new LocalDemoCustodySetupError('Local demo account id is too long')
  }

  const expected = {
    accountId: configuredAccountId,
    backendIdentity: configuredBackendIdentity,
    keyReference: `agent:${configuredAccountId}:v1`,
    rootKeyFingerprint: fingerprintWalletMasterKey(configuredWalletMasterKey),
  }
  const database = createDatabaseClient(configuredDatabaseUrl)
  try {
    let active = await database.v2Admin.findActiveCustodyKeyVersion(expected.accountId)
    if (active === null) {
      try {
        active = await database.v2Admin.createCustodyKeyVersion({
          id: `custody_${expected.accountId}_v1`,
          accountId: expected.accountId,
          keyVersion: 1,
          backendIdentity: expected.backendIdentity,
          keyReference: expected.keyReference,
          rootKeyFingerprint: expected.rootKeyFingerprint,
        })
      } catch {
        // Another bootstrap may have created the same version concurrently.
        active = await database.v2Admin.findActiveCustodyKeyVersion(expected.accountId)
        if (active === null) {
          throw new LocalDemoCustodySetupError(
            'Could not create an active custody key version for the local demo account',
          )
        }
      }
    }

    if (!matchesExpectedVersion(active, expected)) {
      throw new LocalDemoCustodySetupError(
        'Active custody key version does not match the isolated demo configuration; refusing to replace it',
      )
    }
    console.log('[custody] isolated demo payer custody ready')
  } finally {
    await database.disconnect()
  }
}

await main().catch((error: unknown) => {
  if (error instanceof LocalDemoCustodySetupError) {
    console.error(`[custody] ${error.message}`)
  } else {
    console.error('[custody] Local demo custody setup failed; no key material was logged')
  }
  process.exitCode = 1
})
