import {
  ValidationError,
  createAccountId,
  createCredentialId,
  createReceiveId,
} from '@agent-payment/core'
import type { AccountRepository } from '@agent-payment/db'
import type { ReceiveDestination, SolanaRail } from '@agent-payment/solana-rail'
import { generateApiCredential } from './auth.js'
import type { WalletSecretCipher } from './custody.js'
import { generateManagedWallet } from '@agent-payment/solana-rail'

export interface CreatedAccountResponse {
  readonly id: string
  readonly name: string
  readonly status: 'ACTIVE'
  readonly apiKey: string
  readonly credentialId: string
  readonly receiveId: string
  readonly destination: ReceiveDestination
}

export class AccountService {
  public constructor(
    private readonly repository: AccountRepository,
    private readonly cipher: WalletSecretCipher,
    private readonly rail: SolanaRail,
  ) {}

  public async createAccount(name: string): Promise<CreatedAccountResponse> {
    const normalizedName = name.trim()
    if (normalizedName.length === 0 || normalizedName.length > 120) {
      throw new ValidationError('Account name must contain 1 to 120 characters')
    }

    const wallet = await generateManagedWallet()
    try {
      const encryptedSecret = this.cipher.encrypt(wallet.secretKey)
      const destination = await this.rail.getReceiveDestination(wallet.publicKey)
      const credential = generateApiCredential()
      const credentialId = createCredentialId()
      const account = await this.repository.createAgentAccount({
        id: createAccountId(),
        name: normalizedName,
        solanaPublicKey: wallet.publicKey,
        encryptedSolanaSecret: encryptedSecret.ciphertext,
        encryptionNonce: encryptedSecret.nonce,
        encryptionAuthTag: encryptedSecret.authTag,
        credentialId,
        keyHash: credential.keyHash,
        keyPrefix: credential.keyPrefix,
      })

      return {
        id: account.id,
        name: account.name,
        status: 'ACTIVE',
        apiKey: credential.rawKey,
        credentialId,
        receiveId: createReceiveId(),
        destination,
      }
    } finally {
      wallet.secretKey.fill(0)
    }
  }
}

export function serializeAccountCreation(response: CreatedAccountResponse) {
  return {
    id: response.id,
    name: response.name,
    status: response.status,
    api_key: response.apiKey,
    credential_id: response.credentialId,
    receive: {
      id: response.receiveId,
      currency: 'USD' as const,
      status: 'OPEN' as const,
      destination: {
        type: 'external_transfer_target' as const,
        reference: response.destination.tokenAccount,
      },
      settlement: {
        owner: response.destination.owner,
        token_account: response.destination.tokenAccount,
        mint: response.destination.settlementMint,
      },
    },
  }
}

export function serializeReceiveDestination(
  destination: ReceiveDestination,
  accountId: string,
) {
  return {
    id: createReceiveId(),
    account_id: accountId,
    currency: 'USD' as const,
    status: 'OPEN' as const,
    destination: {
      type: 'external_transfer_target' as const,
      reference: destination.tokenAccount,
    },
    settlement: {
      owner: destination.owner,
      token_account: destination.tokenAccount,
      mint: destination.settlementMint,
    },
  }
}
