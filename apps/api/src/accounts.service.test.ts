import { describe, expect, it } from 'vitest'

import type {
  AccountRepository,
  CreateAgentAccountInput,
  ReceiveRequestRecord,
  ReceiveRepository,
  StoredAgentAccount,
  V2AdminRepository,
  V2AccountRecord,
  V2CredentialRecord,
} from '@agent-payment/db'
import type { SolanaRail } from '@agent-payment/solana-rail'
import { AccountService } from './accounts.js'
import { RecoveryEnvelopeCipher, WalletSecretCipher } from './custody.js'

const masterKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

describe('AccountService', () => {
  it('creates a Kit signer, persists only encrypted secret material and returns one API key', async () => {
    let persisted: CreateAgentAccountInput | undefined
    let separateReceiveRequestCalls = 0
    const repository: AccountRepository & ReceiveRepository = {
      createAgentAccount: async (input) => {
        persisted = input
        return {
          id: input.id,
          name: input.name,
          status: 'ACTIVE',
          solanaPublicKey: input.solanaPublicKey,
          encryptedSolanaSecret: input.encryptedSolanaSecret,
          encryptionNonce: input.encryptionNonce,
          encryptionAuthTag: input.encryptionAuthTag,
          createdAt: new Date(),
          updatedAt: new Date(),
        } satisfies StoredAgentAccount
      },
      findAccountByCredentialHash: async () => null,
      markCredentialUsed: async () => undefined,
      revokeCredential: async () => false,
      createReceiveRequest: async (input) => {
        separateReceiveRequestCalls += 1
        return {
          id: input.id,
          accountId: input.accountId,
          amountAtomic: null,
          currency: input.currency,
          reference: input.reference,
          status: 'OPEN',
          createdAt: new Date(),
          updatedAt: new Date(),
          expiresAt: null,
          paidAt: null,
          matchedIncomingPaymentId: null,
        } satisfies ReceiveRequestRecord
      },
      findReceiveRequestForOwner: async () => null,
      listReceiveRequests: async () => [],
      matchIncomingPayment: async () => null,
      expireOpenReceiveRequests: async () => undefined,
    }
    const rail: SolanaRail = {
      getSettlementBalance: async () => {
        throw new Error('not used')
      },
      getReceiveDestination: async (owner) => ({
        owner,
        tokenAccount: 'token-account',
        settlementMint: 'settlement-mint',
      }),
    }
    const service = new AccountService(
      repository,
      new WalletSecretCipher(masterKey),
      rail,
    )

    const result = await service.createAccount('  research-agent  ')

    expect(persisted).toBeDefined()
    expect(result.name).toBe('research-agent')
    expect(result.apiKey).toMatch(/^apa_[A-Za-z0-9_-]+$/)
    expect(JSON.stringify(result)).not.toContain('encryptedSolanaSecret')
    expect(result.destination.owner).toBe(persisted?.solanaPublicKey)
    expect(persisted?.initialReceiveRequest).toMatchObject({
      id: result.receiveId,
      currency: 'USD',
      reference: `account:${persisted?.id}`,
    })
    expect(separateReceiveRequestCalls).toBe(0)

    const encrypted = persisted as CreateAgentAccountInput
    const secret = new WalletSecretCipher(masterKey).decrypt({
      ciphertext: encrypted.encryptedSolanaSecret,
      nonce: encrypted.encryptionNonce,
      authTag: encrypted.encryptionAuthTag,
    })
    expect(secret).toHaveLength(64)
    secret.fill(0)
  })

  it('returns the persisted credential secret when provisioning replays after a race', async () => {
    const account: V2AccountRecord = {
      id: 'acct_persisted',
      name: 'persisted-agent',
      status: 'ACTIVE',
      solanaPublicKey: 'persisted-owner',
      workspaceId: null,
      runtimeVersion: null,
      provisioningFailureCode: null,
      disabledAt: null,
      disabledReason: null,
      rowVersion: 1,
      createdAt: new Date('2026-09-18T00:00:00.000Z'),
      updatedAt: new Date('2026-09-18T00:00:00.000Z'),
    }
    const credential: V2CredentialRecord = {
      id: 'cred_persisted',
      accountId: account.id,
      keyPrefix: 'apa_persisted',
      status: 'ACTIVE',
      scopes: ['payments:read'],
      expiresAt: null,
      rotatedFromId: null,
      rowVersion: 1,
      createdAt: account.createdAt,
      revokedAt: null,
    }
    const recoveryCipher = new RecoveryEnvelopeCipher(masterKey)
    const encryptedSecret = recoveryCipher.encrypt(
      new TextEncoder().encode('apa_persisted-secret'),
    )
    const envelope = {
      idempotencyKey: 'provision-race-key',
      accountId: account.id,
      credentialId: credential.id,
      ...encryptedSecret,
      expiresAt: new Date('2026-09-19T00:00:00.000Z'),
    }
    const v2Admin = {
      findProvisioningReplay: async () => null,
      provisionAccount: async () => ({
        account,
        credential,
        recoveryEnvelope: envelope,
        created: false,
      }),
      findAccount: async () => account,
      consumeRecoveryEnvelope: async () => envelope,
    } as unknown as V2AdminRepository
    const repository = {
      listReceiveRequests: async () => [
        {
          id: 'recv_persisted',
          accountId: account.id,
          amountAtomic: null,
          currency: 'USD',
          reference: `account:${account.id}`,
          status: 'OPEN',
          createdAt: account.createdAt,
          updatedAt: account.updatedAt,
          expiresAt: null,
          paidAt: null,
          matchedIncomingPaymentId: null,
        } satisfies ReceiveRequestRecord,
      ],
    } as unknown as AccountRepository & ReceiveRepository
    const rail: SolanaRail = {
      getSettlementBalance: async () => {
        throw new Error('not used')
      },
      getReceiveDestination: async (owner) => ({
        owner,
        tokenAccount: 'persisted-token-account',
        settlementMint: 'persisted-settlement-mint',
      }),
    }
    const service = new AccountService(
      repository,
      new WalletSecretCipher(masterKey),
      rail,
      v2Admin,
      recoveryCipher,
    )

    const result = await service.createAccountV2(
      'persisted-agent',
      'provision-race-key',
      new Date('2026-09-18T00:00:00.000Z'),
    )

    expect(result.id).toBe(account.id)
    expect(result.credentialId).toBe(credential.id)
    expect(result.apiKey).toBe('apa_persisted-secret')
    expect(result.apiKey).not.toBe(credential.keyPrefix)
  })
})
