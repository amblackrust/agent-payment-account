import { describe, expect, it } from 'vitest'

import type {
  AccountRepository,
  CreateAgentAccountInput,
  StoredAgentAccount,
} from '@agent-payment/db'
import type { SolanaRail } from '@agent-payment/solana-rail'
import { AccountService } from './accounts.js'
import { WalletSecretCipher } from './custody.js'

const masterKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

describe('AccountService', () => {
  it('creates a Kit signer, persists only encrypted secret material and returns one API key', async () => {
    let persisted: CreateAgentAccountInput | undefined
    const repository: AccountRepository = {
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

    const encrypted = persisted as CreateAgentAccountInput
    const secret = new WalletSecretCipher(masterKey).decrypt({
      ciphertext: encrypted.encryptedSolanaSecret,
      nonce: encrypted.encryptionNonce,
      authTag: encrypted.encryptionAuthTag,
    })
    expect(secret).toHaveLength(64)
    secret.fill(0)
  })
})
