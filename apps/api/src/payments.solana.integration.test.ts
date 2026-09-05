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
  createSolanaPaymentRailWithRpc,
  createSolanaRailWithRpc,
} from '@agent-payment/solana-rail'
import { hashApiKey } from './auth.js'
import { WalletSecretCipher } from './custody.js'
import { PaymentService } from './payments.js'

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
        await client.surfnet.fundSol(payer.address, 1_000_000_000)
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
        expect(attempts[0]?.signedTransactionBase64).toBeTruthy()
        expect(attempts[0]?.confirmedSlot).toBeTypeOf('bigint')
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
  },
)
