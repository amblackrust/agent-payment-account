import { randomUUID } from 'node:crypto'

import {
  createClient,
  generateKeyPairSigner,
  getBase16Decoder,
  type KeyPairSigner,
} from '@solana/kit'
import { surfpool } from '@solana/surfpool/kit'
import {
  fetchMaybeToken,
  findAssociatedTokenPda,
  getMintEncoder,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token'
import { describe, expect, it } from 'vitest'

import { createMoney } from '@agent-payment/core'
import { createDatabaseClient, type AuthenticatedAccount } from '@agent-payment/db'
import {
  createSolanaIncomingReader,
  createSolanaPaymentRailWithRpc,
  createSolanaRailWithRpc,
} from '@agent-payment/solana-rail'
import { hashApiKey } from './auth.js'
import { WalletSecretCipher } from './custody.js'
import { PaymentService } from './payments.js'
import { IncomingReconciliationService } from './incoming.js'

const databaseUrl = process.env.DATABASE_URL?.trim()
const masterKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

function id(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`
}

async function exportSecret(signer: KeyPairSigner): Promise<Uint8Array> {
  const privateKey = await crypto.subtle.exportKey('pkcs8', signer.keyPair.privateKey)
  const publicKey = await crypto.subtle.exportKey('raw', signer.keyPair.publicKey)
  const secret = new Uint8Array(64)
  secret.set(new Uint8Array(privateKey).slice(16))
  secret.set(new Uint8Array(publicKey), 32)
  return secret
}

describe.skipIf(databaseUrl === undefined || databaseUrl.length === 0)(
  'PaymentService with the real Solana SPL rail',
  () => {
    it('persists, sends and confirms a real SPL transfer on isolated Surfpool', async () => {
      const client = await createClient().use(surfpool({ surfnet: { offline: true } }))
      const database = createDatabaseClient(databaseUrl as string)
      const payer = await generateKeyPairSigner(true)
      const feePayer = await generateKeyPairSigner(true)
      const recipient = await generateKeyPairSigner(true)
      const mint = await generateKeyPairSigner(true)
      const payerSecret = await exportSecret(payer)
      const encrypted = new WalletSecretCipher(masterKey).encrypt(payerSecret)
      const rawKey = id('api-key')
      const accountId = id('acct')

      try {
        await client.surfnet.fundSol(feePayer.address, 1_000_000_000)
        await client.cheatcodes
          .setAccount(mint.address, {
            data: getBase16Decoder().decode(
              new Uint8Array(
                getMintEncoder().encode({
                  mintAuthority: { __option: 'Some', value: client.payer.address },
                  supply: 2_000_000_000n,
                  decimals: 6,
                  isInitialized: true,
                  freezeAuthority: null,
                }),
              ),
            ),
            lamports: 1_000_000,
            owner: TOKEN_PROGRAM_ADDRESS,
          })
          .send()
        await client.cheatcodes
          .setTokenAccount(payer.address, mint.address, { amount: 2_000_000n })
          .send()

        await database.createAgentAccount({
          id: accountId,
          name: 'surfpool-agent',
          solanaPublicKey: payer.address,
          encryptedSolanaSecret: encrypted.ciphertext,
          encryptionNonce: encrypted.nonce,
          encryptionAuthTag: encrypted.authTag,
          credentialId: id('cred'),
          keyHash: hashApiKey(rawKey),
          keyPrefix: 'apa_integration',
        })
        const account = await database.findAccountByCredentialHash(hashApiKey(rawKey))
        if (account === null) {
          throw new Error('Surfpool account was not created')
        }
        const recipientRecord = await database.createRecipient({
          id: id('rcpt'),
          ownerAccountId: account.account.id,
          displayName: 'surfpool recipient',
          type: 'BUSINESS',
          destination: {
            id: id('dest'),
            rail: 'SOLANA_SPL',
            type: 'SOLANA_SPL',
            walletAddress: recipient.address,
          },
        })
        const readRail = createSolanaRailWithRpc({
          rpc: client.rpc as never,
          expectedCluster: 'localnet',
          allowMainnet: false,
          settlementMint: mint.address,
        })
        const paymentRail = createSolanaPaymentRailWithRpc({
          rpc: client.rpc as never,
          expectedCluster: 'localnet',
          allowMainnet: false,
          settlementMint: mint.address,
          feePayerSecret: JSON.stringify(Array.from(await exportSecret(feePayer))),
        })
        const cipher = new WalletSecretCipher(masterKey)
        const service = new PaymentService(
          database,
          readRail,
          [paymentRail],
          async (ownerAccountId) => {
            const custody = await database.findAccountCustody(ownerAccountId)
            if (custody === null) {
              throw new Error('Surfpool custody was not found')
            }
            return cipher.decrypt({
              ciphertext: custody.encryptedSolanaSecret,
              nonce: custody.encryptionNonce,
              authTag: custody.encryptionAuthTag,
            })
          },
        )

        const result = await service.createPayment(
          account as AuthenticatedAccount,
          'SEND',
          {
            recipientId: recipientRecord.id,
            amount: '1.25',
            currency: 'USD',
          },
          id('idem'),
        )
        const attempts = await database.listPaymentAttempts(result.payment.id)
        const [payerAta] = await findAssociatedTokenPda({
          owner: payer.address,
          tokenProgram: TOKEN_PROGRAM_ADDRESS,
          mint: mint.address,
        })
        const [recipientAta] = await findAssociatedTokenPda({
          owner: recipient.address,
          tokenProgram: TOKEN_PROGRAM_ADDRESS,
          mint: mint.address,
        })
        const payerToken = await fetchMaybeToken(client.rpc, payerAta)
        const recipientToken = await fetchMaybeToken(client.rpc, recipientAta)

        expect(result.payment.status).toBe('CONFIRMED')
        expect(attempts).toHaveLength(1)
        expect(attempts[0]?.status).toBe('CONFIRMED')
        expect(attempts[0]?.railTransactionId).toBeTruthy()
        expect(attempts[0]?.durablePayload).toBeTruthy()
        expect(attempts[0]?.confirmationMetadata).toBeTruthy()
        expect(payerToken.exists && payerToken.data.amount).toBe(750_000n)
        expect(recipientToken.exists && recipientToken.data.amount).toBe(1_250_000n)
        expect(
          await database.getActiveOutgoingReservationAtomic(account.account.id, 'USD'),
        ).toBe(0n)
        expect(createMoney('1.25').atomicUnits).toBe(125n)
      } finally {
        payerSecret.fill(0)
        client.surfnet.stop()
        await database.disconnect()
      }
    })

    it('reconciles a managed recipient and performs a real reverse refund', async () => {
      const client = await createClient().use(surfpool({ surfnet: { offline: true } }))
      const database = createDatabaseClient(databaseUrl as string)
      const payer = await generateKeyPairSigner(true)
      const recipient = await generateKeyPairSigner(true)
      const feePayer = await generateKeyPairSigner(true)
      const mint = await generateKeyPairSigner(true)
      const payerSecret = await exportSecret(payer)
      const recipientSecret = await exportSecret(recipient)
      const cipher = new WalletSecretCipher(masterKey)
      const payerEncrypted = cipher.encrypt(payerSecret)
      const recipientEncrypted = cipher.encrypt(recipientSecret)
      const payerKey = id('payer-key')
      const recipientKey = id('recipient-key')
      const payerId = id('acct')
      const recipientId = id('acct')
      const receiveReference = id('receive-reference')

      try {
        await client.surfnet.fundSol(feePayer.address, 2_000_000_000)
        await client.cheatcodes
          .setAccount(mint.address, {
            data: getBase16Decoder().decode(
              new Uint8Array(getMintEncoder().encode({
                mintAuthority: { __option: 'Some', value: client.payer.address },
                supply: 2_000_000_000n,
                decimals: 6,
                isInitialized: true,
                freezeAuthority: null,
              })),
            ),
            lamports: 1_000_000,
            owner: TOKEN_PROGRAM_ADDRESS,
          })
          .send()
        await client.cheatcodes.setTokenAccount(payer.address, mint.address, { amount: 2_000_000n }).send()

        await database.createAgentAccount({
          id: payerId,
          name: 'surfpool-payer',
          solanaPublicKey: payer.address,
          encryptedSolanaSecret: payerEncrypted.ciphertext,
          encryptionNonce: payerEncrypted.nonce,
          encryptionAuthTag: payerEncrypted.authTag,
          credentialId: id('cred'),
          keyHash: hashApiKey(payerKey),
          keyPrefix: 'apa_integration',
        })
        await database.createAgentAccount({
          id: recipientId,
          name: 'surfpool-recipient',
          solanaPublicKey: recipient.address,
          encryptedSolanaSecret: recipientEncrypted.ciphertext,
          encryptionNonce: recipientEncrypted.nonce,
          encryptionAuthTag: recipientEncrypted.authTag,
          credentialId: id('cred'),
          keyHash: hashApiKey(recipientKey),
          keyPrefix: 'apa_integration',
        })
        const payerAccount = await database.findAccountByCredentialHash(hashApiKey(payerKey))
        const recipientAccount = await database.findAccountByCredentialHash(hashApiKey(recipientKey))
        if (payerAccount === null || recipientAccount === null) {
          throw new Error('Surfpool accounts were not created')
        }
        const recipientRecord = await database.createRecipient({
          id: id('rcpt'),
          ownerAccountId: payerId,
          managedAccountId: recipientId,
          displayName: 'managed surfpool recipient',
          type: 'AGENT',
          destination: {
            id: id('dest'),
            rail: 'SOLANA_SPL',
            type: 'SOLANA_SPL',
            walletAddress: recipient.address,
          },
        })
        const readRail = createSolanaRailWithRpc({
          rpc: client.rpc as never,
          expectedCluster: 'localnet',
          allowMainnet: false,
          settlementMint: mint.address,
        })
        const paymentRail = createSolanaPaymentRailWithRpc({
          rpc: client.rpc as never,
          expectedCluster: 'localnet',
          allowMainnet: false,
          settlementMint: mint.address,
          feePayerSecret: JSON.stringify(Array.from(await exportSecret(feePayer))),
        })
        const service = new PaymentService(
          database,
          readRail,
          [paymentRail],
          async (accountId) => {
            const custody = await database.findAccountCustody(accountId)
            if (custody === null) throw new Error('Surfpool custody was not found')
            return cipher.decrypt({
              ciphertext: custody.encryptedSolanaSecret,
              nonce: custody.encryptionNonce,
              authTag: custody.encryptionAuthTag,
            })
          },
        )
        await database.createReceiveRequest({
          id: id('recv'),
          accountId: recipientId,
          amountAtomic: 125n,
          currency: 'USD',
          reference: receiveReference,
        })
        const original = await service.createPayment(
          payerAccount as AuthenticatedAccount,
          'PAY',
          {
            recipientId: recipientRecord.id,
            amount: '1.25',
            currency: 'USD',
            externalReference: receiveReference,
          },
          id('idem'),
        )
        const incomingReader = createSolanaIncomingReader({
          rpc: client.rpc as never,
          readRail,
          rpcUrl: 'http://surfpool.local',
          expectedCluster: 'localnet',
          allowMainnet: false,
          settlementMint: mint.address,
        })
        const [recipientAtaBeforeScan] = await findAssociatedTokenPda({
          owner: recipient.address,
          tokenProgram: TOKEN_PROGRAM_ADDRESS,
          mint: mint.address,
        })
        const signaturesForRecipient = await client.rpc
          .getSignaturesForAddress(recipientAtaBeforeScan, { limit: 1000 })
          .send()
        expect(signaturesForRecipient.length).toBeGreaterThan(0)
        const observedIncomingTransaction = await client.rpc
          .getTransaction(signaturesForRecipient[0]!.signature, {
            encoding: 'jsonParsed',
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 0,
          })
          .send()
        if (observedIncomingTransaction === null) {
          throw new Error('Surfpool did not return the recipient transaction')
        }
        expect(observedIncomingTransaction.meta?.postTokenBalances?.length).toBeGreaterThan(0)
        const reconciler = new IncomingReconciliationService(database, incomingReader, {
          error: () => undefined,
        })
        await reconciler.runOnce()
        const incoming = await database.listIncomingPayments(recipientId)
        expect(original.payment.status).toBe('CONFIRMED')
        expect(incoming).toHaveLength(1)
        expect(incoming[0]?.amountAtomic).toBe(125n)
        const matched = await database.findReceiveRequestForOwner(recipientId, incoming[0]?.receiveRequestId ?? '')
        expect(matched?.status).toBe('PAID')
        await reconciler.runOnce()
        expect(await database.listIncomingPayments(recipientId)).toHaveLength(1)

        const refund = await service.createRefund(
          recipientAccount as AuthenticatedAccount,
          { originalPaymentId: original.payment.id, amount: '1.25', currency: 'USD' },
          id('refund'),
        )
        expect(refund.payment.status).toBe('CONFIRMED')
        const [payerAta] = await findAssociatedTokenPda({ owner: payer.address, tokenProgram: TOKEN_PROGRAM_ADDRESS, mint: mint.address })
        const [recipientAta] = await findAssociatedTokenPda({ owner: recipient.address, tokenProgram: TOKEN_PROGRAM_ADDRESS, mint: mint.address })
        const payerTokenAfterRefund = await fetchMaybeToken(client.rpc, payerAta)
        const recipientTokenAfterRefund = await fetchMaybeToken(client.rpc, recipientAta)
        expect(payerTokenAfterRefund.exists && payerTokenAfterRefund.data.amount).toBe(2_000_000n)
        expect(recipientTokenAfterRefund.exists && recipientTokenAfterRefund.data.amount).toBe(0n)
        expect(await database.listIncomingPayments(recipientId)).toHaveLength(1)
      } finally {
        payerSecret.fill(0)
        recipientSecret.fill(0)
        client.surfnet.stop()
        await database.disconnect()
      }
    })
  },
)
