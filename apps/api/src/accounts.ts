import { createHash } from 'node:crypto'
import {
  DependencyUnavailableError,
  ValidationError,
  DEFAULT_AGENT_CREDENTIAL_SCOPES,
  createAccountId,
  createCredentialId,
  createReceiveId,
} from '@agent-payment/core'
import type { AccountRepository, ReceiveRepository } from '@agent-payment/db'
import type { V2AdminRepository } from '@agent-payment/db'
import type { ReceiveDestination, SolanaRail } from '@agent-payment/solana-rail'
import { generateApiCredential } from './auth.js'
import type { RecoveryEnvelopeCipher, WalletSecretCipher } from './custody.js'
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

export interface V2FundingProvisioner {
  provision(input: {
    readonly accountId: string
    readonly owner: string
  }): Promise<void>
}

export class AccountService {
  public constructor(
    private readonly repository: AccountRepository & ReceiveRepository,
    private readonly cipher: WalletSecretCipher,
    private readonly rail: SolanaRail,
    private readonly v2Admin?: V2AdminRepository,
    private readonly recoveryCipher?: RecoveryEnvelopeCipher,
    private readonly v2FundingProvisioner?: V2FundingProvisioner,
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
      const receiveRequest = await this.repository.createReceiveRequest({
        id: createReceiveId(),
        accountId: account.id,
        currency: 'USD',
        reference: `account:${account.id}`,
      })

      return {
        id: account.id,
        name: account.name,
        status: 'ACTIVE',
        apiKey: credential.rawKey,
        credentialId,
        receiveId: receiveRequest.id,
        destination,
      }
    } finally {
      wallet.secretKey.fill(0)
    }
  }

  public async createCredential(accountId: string) {
    if (this.repository.createApiCredential === undefined) {
      throw new Error('Credential persistence is unavailable')
    }
    const credential = generateApiCredential()
    const stored = await this.repository.createApiCredential({
      id: createCredentialId(),
      accountId,
      keyHash: credential.keyHash,
      keyPrefix: credential.keyPrefix,
      scopes: DEFAULT_AGENT_CREDENTIAL_SCOPES,
    })
    return { ...stored, apiKey: credential.rawKey }
  }

  public async createAccountV2(
    name: string,
    idempotencyKey: string,
    now = new Date(),
  ): Promise<CreatedAccountResponse> {
    if (this.v2Admin === undefined || this.recoveryCipher === undefined) {
      throw new Error('V2 account provisioning is unavailable')
    }
    const normalizedName = name.trim()
    if (normalizedName.length === 0 || normalizedName.length > 120) {
      throw new ValidationError('Account name must contain 1 to 120 characters')
    }
    const requestHash = hashProvisioningRequest(normalizedName)
    const replay = await this.v2Admin.findProvisioningReplay({ idempotencyKey, requestHash })
    if (replay !== null) {
      const existingAccount = await this.v2Admin.findAccount(replay.accountId)
      if (existingAccount === null) throw new Error('Provisioned account is unavailable')
      await this.finishV2Provisioning(existingAccount.id, existingAccount.solanaPublicKey)
      const envelope = await this.v2Admin.consumeRecoveryEnvelope(
        replay.accountId,
        idempotencyKey,
        now,
      )
      if (envelope === null) {
        throw new ValidationError('Credential recovery window has expired')
      }
      const apiKey = decodeOneTimeSecret(
        this.recoveryCipher.decrypt(envelope),
      )
      const account = await this.v2Admin.findAccount(replay.accountId)
      if (account === null) throw new Error('Provisioned account is unavailable')
      const requests = await this.repository.listReceiveRequests(account.id)
      const receiveRequest = requests.find(
        (request) => request.reference === `account:${account.id}`,
      )
      if (receiveRequest === undefined) {
        throw new Error('Provisioned receive request is unavailable')
      }
      return {
        id: account.id,
        name: account.name,
        status: 'ACTIVE',
        apiKey,
        credentialId: replay.credentialId,
        receiveId: receiveRequest.id,
        destination: await this.rail.getReceiveDestination(account.solanaPublicKey),
      }
    }

    const wallet = await generateManagedWallet()
    try {
      const encryptedSecret = this.cipher.encrypt(wallet.secretKey)
      const destination = await this.rail.getReceiveDestination(wallet.publicKey)
      const credential = generateApiCredential()
      const credentialId = createCredentialId()
      const recovery = this.recoveryCipher.encrypt(
        new TextEncoder().encode(credential.rawKey),
      )
      const accountId = createAccountId()
      const receiveId = createReceiveId()
      await this.v2Admin.provisionAccount({
        idempotencyKey,
        requestHash,
        accountId,
        name: normalizedName,
        solanaPublicKey: wallet.publicKey,
        encryptedSolanaSecret: encryptedSecret.ciphertext,
        encryptionNonce: encryptedSecret.nonce,
        encryptionAuthTag: encryptedSecret.authTag,
        credentialId,
        keyHash: credential.keyHash,
        keyPrefix: credential.keyPrefix,
        scopes: DEFAULT_AGENT_CREDENTIAL_SCOPES,
        recoveryCiphertext: recovery.ciphertext,
        recoveryNonce: recovery.nonce,
        recoveryAuthTag: recovery.authTag,
        recoveryExpiresAt: new Date(now.getTime() + 15 * 60 * 1000),
        receiveRequestId: receiveId,
        receiveReference: `account:${accountId}`,
      })
      await this.finishV2Provisioning(accountId, wallet.publicKey)
      return {
        id: accountId,
        name: normalizedName,
        status: 'ACTIVE',
        apiKey: credential.rawKey,
        credentialId,
        receiveId,
        destination,
      }
    } finally {
      wallet.secretKey.fill(0)
    }
  }

  private async finishV2Provisioning(accountId: string, owner: string): Promise<void> {
    if (this.v2Admin === undefined) {
      throw new DependencyUnavailableError('V2 account provisioning is unavailable')
    }
    let account = await this.v2Admin.findAccount(accountId)
    if (account === null) throw new Error('Provisioned account is unavailable')
    if (account.status === 'ACTIVE') return
    if (account.status === 'PROVISIONING_FAILED') {
      await this.v2Admin.transitionAccount({
        accountId,
        currentStatus: account.status,
        nextStatus: 'PROVISIONING',
        rowVersion: account.rowVersion,
        reason: 'PROVISIONING_RETRY',
      })
      account = await this.v2Admin.findAccount(accountId)
      if (account === null) throw new Error('Provisioned account is unavailable')
    }
    if (account.status !== 'PROVISIONING') {
      throw new ValidationError('Account is not in a resumable provisioning state')
    }
    try {
      if (this.v2FundingProvisioner === undefined) {
        throw new DependencyUnavailableError('Funding destination provisioning is unavailable')
      }
      await this.v2FundingProvisioner.provision({ accountId, owner })
      const current = await this.v2Admin.findAccount(accountId)
      if (current === null) throw new Error('Provisioned account is unavailable')
      await this.v2Admin.transitionAccount({
        accountId,
        currentStatus: 'PROVISIONING',
        nextStatus: 'ACTIVE',
        rowVersion: current.rowVersion,
      })
    } catch (error) {
      const current = await this.v2Admin.findAccount(accountId)
      if (current !== null && current.status === 'PROVISIONING') {
        await this.v2Admin.transitionAccount({
          accountId,
          currentStatus: 'PROVISIONING',
          nextStatus: 'PROVISIONING_FAILED',
          rowVersion: current.rowVersion,
          reason: error instanceof Error ? error.name : 'PROVISIONING_FAILED',
        })
      }
      throw error
    }
  }
}

function hashProvisioningRequest(name: string): string {
  return createHash('sha256')
    .update(JSON.stringify({ name }), 'utf8')
    .digest('hex')
}

function decodeOneTimeSecret(secret: Uint8Array): string {
  try {
    const value = new TextDecoder().decode(secret)
    if (value.length === 0) throw new Error('empty secret')
    return value
  } finally {
    secret.fill(0)
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
