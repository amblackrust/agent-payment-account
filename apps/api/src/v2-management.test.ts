import { describe, expect, it, vi } from 'vitest'

import type {
  V2AccountRecord,
  V2AdminRepository,
  V2CredentialRecord,
} from '@agent-payment/db'
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
})
