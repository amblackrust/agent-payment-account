import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

import type {
  V2AccountRecord,
  V2AdminRepository,
  V2CredentialRecord,
} from '@agent-payment/db'
import { NotFoundError } from '@agent-payment/core'
import { RecoveryEnvelopeCipher } from './custody.js'
import { V2ManagementService } from './v2-management.js'

const account: V2AccountRecord = {
  id: 'acct_1',
  name: 'Test account',
  status: 'ACTIVE',
  solanaPublicKey: 'owner-address',
  workspaceId: null,
  runtimeVersion: 'v2',
  provisioningFailureCode: null,
  disabledAt: null,
  disabledReason: null,
  rowVersion: 1,
  createdAt: new Date('2026-09-18T00:00:00.000Z'),
  updatedAt: new Date('2026-09-18T00:00:00.000Z'),
}

const credential: V2CredentialRecord = {
  id: 'cred_old',
  accountId: account.id,
  keyPrefix: 'apa_old',
  status: 'ACTIVE',
  scopes: ['contacts:manage', 'receive:manage', 'history:read'],
  expiresAt: null,
  rotatedFromId: null,
  rowVersion: 1,
  createdAt: new Date('2026-09-18T00:00:00.000Z'),
  revokedAt: null,
}

describe('V2ManagementService credential rotation', () => {
  it('preserves the existing scope set unless a replacement set is explicit', async () => {
    const rotateCredential = vi.fn(
      async (input: { readonly scopes: readonly string[] }) => ({
        ...credential,
        id: 'cred_new',
        scopes: input.scopes,
        rotatedFromId: credential.id,
      }),
    )
    const repository = {
      findAccount: async () => account,
      listCredentials: async () => [credential],
      consumeRecoveryEnvelope: async () => null,
      rotateCredential,
    } as unknown as V2AdminRepository
    const service = new V2ManagementService({
      repository,
      financialRepository: {} as never,
      recoveryCipher: new RecoveryEnvelopeCipher(
        '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      ),
    })

    const result = await service.rotateCredential(
      account.id,
      credential.id,
      'rotate-key',
    )

    expect(rotateCredential).toHaveBeenCalledWith(
      expect.objectContaining({ scopes: credential.scopes }),
    )
    expect(result.scopes).toEqual(credential.scopes)
  })

  it('recovers a lost rotation response once through the same idempotency key', async () => {
    const recoveryCipher = new RecoveryEnvelopeCipher(
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    )
    const rawKey = 'apa_recovered_rotation_key'
    const encrypted = recoveryCipher.encrypt(new TextEncoder().encode(rawKey))
    const rotatedCredential: V2CredentialRecord = {
      ...credential,
      id: 'cred_new',
      rotatedFromId: credential.id,
    }
    let envelopeAvailable = true
    const consumeRecoveryEnvelope = vi.fn(async () => {
      if (!envelopeAvailable) return null
      envelopeAvailable = false
      return {
        idempotencyKey: 'CREDENTIAL_ROTATION:acct_1:rotate-key',
        accountId: account.id,
        credentialId: rotatedCredential.id,
        ciphertext: encrypted.ciphertext,
        nonce: encrypted.nonce,
        authTag: encrypted.authTag,
        expiresAt: new Date('2026-09-18T00:15:00.000Z'),
      }
    })
    const repository = {
      findAccount: async () => account,
      listCredentials: async () => [credential, rotatedCredential],
      consumeRecoveryEnvelope,
      rotateCredential: vi.fn(),
    } as unknown as V2AdminRepository
    const service = new V2ManagementService({
      repository,
      financialRepository: {} as never,
      recoveryCipher,
      now: () => new Date('2026-09-18T00:00:00.000Z'),
    })

    const result = await service.rotateCredential(
      account.id,
      credential.id,
      'rotate-key',
    )

    expect(result).toMatchObject({
      credential_id: rotatedCredential.id,
      account_id: account.id,
      api_key: rawKey,
      key_prefix: rawKey.slice(0, 12),
    })
    expect(repository.rotateCredential).not.toHaveBeenCalled()
    expect(consumeRecoveryEnvelope).toHaveBeenCalledWith(
      account.id,
      'CREDENTIAL_ROTATION:acct_1:rotate-key',
      new Date('2026-09-18T00:00:00.000Z'),
    )
  })

  it('recovers after a concurrent rotation loses the active-row race', async () => {
    const recoveryCipher = new RecoveryEnvelopeCipher(
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    )
    const rawKey = 'apa_concurrent_rotation_key'
    const encrypted = recoveryCipher.encrypt(new TextEncoder().encode(rawKey))
    const rotatedCredential: V2CredentialRecord = {
      ...credential,
      id: 'cred_concurrent',
      rotatedFromId: credential.id,
    }
    const consumeRecoveryEnvelope = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        idempotencyKey: 'CREDENTIAL_ROTATION:acct_1:rotate-key',
        accountId: account.id,
        credentialId: rotatedCredential.id,
        ciphertext: encrypted.ciphertext,
        nonce: encrypted.nonce,
        authTag: encrypted.authTag,
        expiresAt: new Date('2026-09-18T00:15:00.000Z'),
      })
    const rotateCredential = vi.fn(async () => {
      throw new NotFoundError('Credential was not found or already revoked')
    })
    const repository = {
      findAccount: async () => account,
      listCredentials: async () => [credential, rotatedCredential],
      consumeRecoveryEnvelope,
      rotateCredential,
    } as unknown as V2AdminRepository
    const service = new V2ManagementService({
      repository,
      financialRepository: {} as never,
      recoveryCipher,
      now: () => new Date('2026-09-18T00:00:00.000Z'),
    })

    await expect(
      service.rotateCredential(account.id, credential.id, 'rotate-key'),
    ).resolves.toMatchObject({ api_key: rawKey })
    expect(rotateCredential).toHaveBeenCalledOnce()
  })
})

describe('V2ManagementService credential issuance', () => {
  const recoveryKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
  const recoveryIdempotencyKey = `CREDENTIAL_CREATE:acct_1:${createHash('sha256')
    .update('issue-key', 'utf8')
    .digest('hex')}`
  const issuedCredential: V2CredentialRecord = {
    ...credential,
    id: 'cred_issued',
    keyPrefix: 'apa_issued',
    scopes: ['history:read', 'payments:read'],
    expiresAt: new Date('2026-09-19T00:00:00.000Z'),
  }

  it('creates an independent credential and keeps the recovery secret encrypted', async () => {
    const recoveryCipher = new RecoveryEnvelopeCipher(recoveryKey)
    type IssuanceInput = {
      readonly accountId: string
      readonly idempotencyKey: string
      readonly scopes: readonly string[]
      readonly recoveryCiphertext: string
      readonly recoveryNonce: string
      readonly recoveryAuthTag: string
      readonly recoveryExpiresAt: Date
      readonly actorId: string
    }
    let issuanceInput: IssuanceInput | undefined
    const createCredential = vi.fn(async (input: IssuanceInput) => {
      issuanceInput = input
      return { credential: issuedCredential, created: true }
    })
    const repository = {
      findAccount: async () => account,
      findCredentialIdempotency: async () => null,
      createCredential,
    } as unknown as V2AdminRepository
    const service = new V2ManagementService({
      repository,
      financialRepository: {} as never,
      recoveryCipher,
      credentialRecoveryTtlSeconds: 900,
      now: () => new Date('2026-09-18T00:00:00.000Z'),
    })

    const result = await service.createCredential({
      accountId: account.id,
      scopes: ['payments:read', 'history:read'],
      expiresAt: '2026-09-19T00:00:00.000Z',
      idempotencyKey: 'issue-key',
      actorId: 'operator-1',
    })

    expect(result).toMatchObject({
      created: true,
      credential_id: issuedCredential.id,
      account_id: account.id,
      key_prefix: issuedCredential.keyPrefix,
      scopes: issuedCredential.scopes,
      expires_at: '2026-09-19T00:00:00.000Z',
    })
    expect(result.api_key).toMatch(/^apa_/u)
    expect(issuanceInput).toEqual(
      expect.objectContaining({
        accountId: account.id,
        idempotencyKey: 'issue-key',
        scopes: issuedCredential.scopes,
        recoveryExpiresAt: new Date('2026-09-18T00:15:00.000Z'),
        actorId: 'operator-1',
      }),
    )
    expect(JSON.stringify(issuanceInput)).not.toContain(result.api_key as string)
    if (issuanceInput === undefined)
      throw new Error('Credential input was not captured')
    const decrypted = recoveryCipher.decrypt({
      ciphertext: issuanceInput.recoveryCiphertext,
      nonce: issuanceInput.recoveryNonce,
      authTag: issuanceInput.recoveryAuthTag,
    })
    expect(new TextDecoder().decode(decrypted)).toBe(result.api_key)
    decrypted.fill(0)
  })

  it('replays the same credential and recovers the secret while the envelope is alive', async () => {
    const recoveryCipher = new RecoveryEnvelopeCipher(recoveryKey)
    const rawKey = 'apa_recovered_issue_key'
    const encrypted = recoveryCipher.encrypt(new TextEncoder().encode(rawKey))
    const createCredential = vi.fn(async () => ({
      credential: issuedCredential,
      created: false,
    }))
    const consumeRecoveryEnvelope = vi.fn(async () => ({
      idempotencyKey: recoveryIdempotencyKey,
      accountId: account.id,
      credentialId: issuedCredential.id,
      ciphertext: encrypted.ciphertext,
      nonce: encrypted.nonce,
      authTag: encrypted.authTag,
      expiresAt: new Date('2026-09-18T00:15:00.000Z'),
    }))
    const repository = {
      findAccount: async () => account,
      findCredentialIdempotency: async () => null,
      createCredential,
      consumeRecoveryEnvelope,
    } as unknown as V2AdminRepository
    const service = new V2ManagementService({
      repository,
      financialRepository: {} as never,
      recoveryCipher,
      now: () => new Date('2026-09-18T00:00:00.000Z'),
    })

    const result = await service.createCredential({
      accountId: account.id,
      scopes: ['history:read', 'payments:read'],
      idempotencyKey: 'issue-key',
      actorId: 'operator-1',
    })

    expect(result).toMatchObject({
      created: false,
      credential_id: issuedCredential.id,
      api_key: rawKey,
    })
    expect(consumeRecoveryEnvelope).toHaveBeenCalledWith(
      account.id,
      recoveryIdempotencyKey,
      new Date('2026-09-18T00:00:00.000Z'),
    )
  })

  it('returns the existing resource without a secret after recovery expires', async () => {
    const createCredential = vi.fn(async () => ({
      credential: issuedCredential,
      created: false,
    }))
    const repository = {
      findAccount: async () => account,
      findCredentialIdempotency: async () => null,
      createCredential,
      consumeRecoveryEnvelope: async () => null,
    } as unknown as V2AdminRepository
    const service = new V2ManagementService({
      repository,
      financialRepository: {} as never,
      recoveryCipher: new RecoveryEnvelopeCipher(recoveryKey),
    })

    await expect(
      service.createCredential({
        accountId: account.id,
        scopes: ['payments:read'],
        idempotencyKey: 'issue-key',
        actorId: 'operator-1',
      }),
    ).resolves.toMatchObject({
      created: false,
      credential_id: issuedCredential.id,
      api_key: null,
    })
  })

  it('acknowledges recovery more than once without changing the result', async () => {
    const acknowledgeRecoveryEnvelope = vi.fn(async () => undefined)
    const repository = {
      findAccount: async () => account,
      acknowledgeRecoveryEnvelope,
    } as unknown as V2AdminRepository
    const service = new V2ManagementService({
      repository,
      financialRepository: {} as never,
    })

    await service.acknowledgeCredentialRecovery(account.id, 'issue-key')
    await service.acknowledgeCredentialRecovery(account.id, 'issue-key')

    expect(acknowledgeRecoveryEnvelope).toHaveBeenCalledTimes(2)
    expect(acknowledgeRecoveryEnvelope).toHaveBeenNthCalledWith(
      1,
      account.id,
      recoveryIdempotencyKey,
    )
  })
})

describe('V2ManagementService funding readiness', () => {
  it('returns explicit unavailable readiness when provisioning has no destination', async () => {
    const repository = {
      findAccount: async () => account,
      findFundingDestination: async () => null,
    } as unknown as V2AdminRepository
    const service = new V2ManagementService({
      repository,
      financialRepository: {} as never,
    })

    await expect(
      service.getFundingDestination(account.id, 'route_solana'),
    ).resolves.toEqual({
      id: null,
      account_id: account.id,
      route_id: 'route_solana',
      network: null,
      asset_id: null,
      destination: null,
      readiness: 'UNAVAILABLE',
      sender_constraints: {},
      last_validated_at: null,
      last_failure_code: 'FUNDING_DESTINATION_UNAVAILABLE',
    })
  })
})
