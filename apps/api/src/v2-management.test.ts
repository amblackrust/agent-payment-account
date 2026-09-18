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
