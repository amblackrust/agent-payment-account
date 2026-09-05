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
  AgentPaymentAccount,
  ConflictError as SdkConflictError,
} from '@agent-payment/sdk'
import {
  createSolanaIncomingReader,
  createSolanaPaymentRailWithRpc,
  createSolanaRailWithRpc,
} from '@agent-payment/solana-rail'
import { hashApiKey } from './auth.js'
import { AccountService } from './accounts.js'
import { buildApp } from './app.js'
import { WalletSecretCipher } from './custody.js'
import { PaymentService } from './payments.js'
import { IncomingReconciliationService } from './incoming.js'
import { ReceiveService } from './receives.js'
import { RecipientService } from './recipients.js'
import { TransactionService } from './transactions.js'
import type { AppConfig } from './config.js'

const databaseUrl = process.env.DATABASE_URL?.trim()
const masterKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

const testConfig: AppConfig = {
  databaseUrl:
    databaseUrl ??
    'postgresql://postgres:postgres@127.0.0.1:5432/agent_payment_account',
  port: 0,
  nodeEnv: 'test',
  adminApiKey: 'test-admin-key',
  solanaRpcUrl: 'http://surfpool.local',
  solanaCluster: 'localnet',
  solanaSettlementMint: 'test-mint',
  solanaFeePayerSecret: 'test-fee-payer-secret',
  walletMasterKey: masterKey,
  allowMainnet: false,
}

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
      let app: ReturnType<typeof buildApp> | undefined

      try {
        await client.surfnet.fundSol(feePayer.address, 2_000_000_000)
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
        const payerAccount = await database.findAccountByCredentialHash(
          hashApiKey(payerKey),
        )
        const recipientAccount = await database.findAccountByCredentialHash(
          hashApiKey(recipientKey),
        )
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
        app = buildApp({
          config: testConfig,
          readinessDependency: database,
          accountRepository: database,
          accountService: new AccountService(database, cipher, readRail),
          solanaRail: readRail,
          recipientService: new RecipientService(database),
          paymentService: service,
          reservationRepository: database,
          receiveService: new ReceiveService(database, readRail),
          transactionService: new TransactionService(database),
        })
        await app.listen({ host: '127.0.0.1', port: 0 })
        const listenerAddress = app.server.address()
        if (listenerAddress === null || typeof listenerAddress === 'string') {
          throw new Error('Fastify did not expose its listener address')
        }
        const baseUrl = `http://127.0.0.1:${listenerAddress.port}`
        const payerSdk = new AgentPaymentAccount({ baseUrl, apiKey: payerKey })
        const recipientSdk = new AgentPaymentAccount({ baseUrl, apiKey: recipientKey })
        expect((await recipientSdk.getBalance()).settled).toBe('0.00')
        expect((await payerSdk.getBalance()).settled).toBe('2.00')
        const receiveRequest = await recipientSdk.receive({
          amount: '1.25',
          reference: receiveReference,
        })
        const original = await payerSdk.pay(
          {
            recipientId: recipientRecord.id,
            amount: '1.25',
            externalReference: receiveRequest.reference,
          },
          id('idem'),
        )
        expect((await payerSdk.getPayment(original.id)).status).toBe('CONFIRMED')
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
        expect(
          observedIncomingTransaction.meta?.postTokenBalances?.length,
        ).toBeGreaterThan(0)
        const reconciler = new IncomingReconciliationService(database, incomingReader, {
          error: () => undefined,
        })
        await reconciler.runOnce()
        const incoming = await database.listIncomingPayments(recipientId)
        expect(original.status).toBe('CONFIRMED')
        expect(incoming).toHaveLength(1)
        expect(incoming[0]?.amountAtomic).toBe(125n)
        const matched = await database.findReceiveRequestForOwner(
          recipientId,
          incoming[0]?.receiveRequestId ?? '',
        )
        expect(matched?.status).toBe('PAID')
        const incomingHistory = await recipientSdk.listTransactions()
        expect(incomingHistory).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: incoming[0]?.id,
              direction: 'INCOMING',
              kind: 'RECEIVE',
              counterparty: {
                recipientId: null,
                displayName: null,
                accountId: null,
                address: payer.address,
              },
            }),
          ]),
        )
        const restartedReconciler = new IncomingReconciliationService(
          database,
          incomingReader,
          {
            error: () => undefined,
          },
        )
        await restartedReconciler.runOnce()
        expect(await database.listIncomingPayments(recipientId)).toHaveLength(1)

        const refund = await recipientSdk.refund(
          { originalPaymentId: original.id, amount: '1.25' },
          id('refund'),
        )
        expect(refund.status).toBe('CONFIRMED')
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
        const payerTokenAfterRefund = await fetchMaybeToken(client.rpc, payerAta)
        const recipientTokenAfterRefund = await fetchMaybeToken(
          client.rpc,
          recipientAta,
        )
        expect(payerTokenAfterRefund.exists && payerTokenAfterRefund.data.amount).toBe(
          2_000_000n,
        )
        expect(
          recipientTokenAfterRefund.exists && recipientTokenAfterRefund.data.amount,
        ).toBe(0n)
        expect(await database.listIncomingPayments(recipientId)).toHaveLength(1)
        const recipientHistory = await recipientSdk.listTransactions()
        const refundHistory = recipientHistory.find(
          (transaction) => transaction.id === refund.id,
        )
        expect(refundHistory).toMatchObject({
          direction: 'OUTGOING',
          kind: 'REFUND',
          counterparty: {
            accountId: payerId,
            address: payer.address,
            recipientId: null,
          },
        })
        expect((await recipientSdk.getPayment(refund.id)).status).toBe('CONFIRMED')
        expect((await payerSdk.getBalance()).settled).toBe('2.00')
        expect((await recipientSdk.getBalance()).settled).toBe('0.00')
        await expect(
          recipientSdk.refund(
            { originalPaymentId: original.id, amount: '0.01' },
            id('over-refund'),
          ),
        ).rejects.toBeInstanceOf(SdkConflictError)
      } finally {
        payerSecret.fill(0)
        recipientSecret.fill(0)
        await app?.close()
        client.surfnet.stop()
        await database.disconnect()
      }
    })
  },
)
