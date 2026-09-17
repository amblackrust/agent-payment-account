import { createHash } from 'node:crypto'
import {
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  generateKeyPairSigner,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type KeyPairSigner,
} from '@solana/kit'
import {
  findAssociatedTokenPda,
  getTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token'
import { getAddMemoInstruction } from '@solana-program/memo'
import { describe, expect, it } from 'vitest'
import { signSolanaV2PreparedEffect } from './v2-outgoing.js'

const mint = 'So11111111111111111111111111111111111111112'
const blockhash = '11111111111111111111111111111111'

describe('Solana V2 outgoing signing boundary', () => {
  it('signs the exact persisted prepared message with separate fee-payer and account keys', async () => {
    const payer = await generateKeyPairSigner(true)
    const feePayer = await generateKeyPairSigner(true)
    const payerSecret = await exportSecret(payer)
    const feePayerSecret = await exportSecret(feePayer)
    const [payerAta, recipientAta] = await Promise.all([
      findAssociatedTokenPda({
        owner: payer.address,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
        mint: mint as never,
      }),
      findAssociatedTokenPda({
        owner: feePayer.address,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
        mint: mint as never,
      }),
    ])
    const memo = 'pay_v2_test'
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (value) =>
        setTransactionMessageFeePayerSigner(createNoopSigner(feePayer.address), value),
      (value) =>
        setTransactionMessageLifetimeUsingBlockhash(
          { blockhash: blockhash as never, lastValidBlockHeight: 100n },
          value,
        ),
      (value) =>
        appendTransactionMessageInstructions(
          [
            getTransferCheckedInstruction({
              source: payerAta[0],
              mint: mint as never,
              destination: recipientAta[0],
              authority: createNoopSigner(payer.address),
              amount: 100n,
              decimals: 6,
            }),
            getAddMemoInstruction({ memo }),
          ],
          value,
        ),
    )
    const messageBase64 = Buffer.from(
      compileTransaction(message).messageBytes,
    ).toString('base64')
    const request = {
      accountId: 'acct_1',
      paymentId: 'pay_1',
      attemptId: 'attempt_1',
      effectHash: 'a'.repeat(64),
      network: 'localnet',
      assetReference: mint,
      destination: feePayer.address,
      amountAtomic: 100n,
      feePayerIdentity: feePayer.address,
      keyVersion: 1,
      payloadHash: hashBase64(messageBase64),
      preparedPayload: JSON.stringify({
        version: 1,
        payerOwner: payer.address,
        recipientOwner: feePayer.address,
        payerAta: payerAta[0],
        recipientAta: recipientAta[0],
        settlementMint: mint,
        tokenDecimals: 6,
        tokenAmount: '100',
        createsRecipientAta: false,
        blockhash,
        lastValidBlockHeight: '100',
        feePayerIdentity: feePayer.address,
        memo,
        messageBase64,
      }),
    }

    const signed = await signSolanaV2PreparedEffect({
      request,
      payerSecret,
      feePayerSecret,
    })

    expect(signed.effectHash).toBe(request.effectHash)
    expect(signed.keyVersion).toBe(1)
    expect(signed.externalId).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/u)
    expect(signed.signedPayload.byteLength).toBeGreaterThan(0)
    payerSecret.fill(0)
    feePayerSecret.fill(0)
  })

  it('rejects a prepared message that changes before signing', async () => {
    const payer = await generateKeyPairSigner(true)
    const feePayer = await generateKeyPairSigner(true)
    const payerSecret = await exportSecret(payer)
    const feePayerSecret = await exportSecret(feePayer)
    const [payerAta, recipientAta] = await Promise.all([
      findAssociatedTokenPda({
        owner: payer.address,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
        mint: mint as never,
      }),
      findAssociatedTokenPda({
        owner: feePayer.address,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
        mint: mint as never,
      }),
    ])
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (value) =>
        setTransactionMessageFeePayerSigner(createNoopSigner(feePayer.address), value),
      (value) =>
        setTransactionMessageLifetimeUsingBlockhash(
          { blockhash: blockhash as never, lastValidBlockHeight: 100n },
          value,
        ),
      (value) =>
        appendTransactionMessageInstructions(
          [
            getTransferCheckedInstruction({
              source: payerAta[0],
              mint: mint as never,
              destination: recipientAta[0],
              authority: createNoopSigner(payer.address),
              amount: 100n,
              decimals: 6,
            }),
          ],
          value,
        ),
    )
    const messageBase64 = Buffer.from(
      compileTransaction(message).messageBytes,
    ).toString('base64')
    const request = {
      accountId: 'acct_1',
      paymentId: 'pay_1',
      attemptId: 'attempt_1',
      effectHash: 'b'.repeat(64),
      network: 'localnet',
      assetReference: mint,
      destination: feePayer.address,
      amountAtomic: 100n,
      feePayerIdentity: feePayer.address,
      keyVersion: 1,
      preparedPayload: JSON.stringify({
        version: 1,
        payerOwner: payer.address,
        recipientOwner: feePayer.address,
        payerAta: payerAta[0],
        recipientAta: recipientAta[0],
        settlementMint: mint,
        tokenDecimals: 6,
        tokenAmount: '100',
        createsRecipientAta: false,
        blockhash,
        lastValidBlockHeight: '100',
        feePayerIdentity: feePayer.address,
        memo: 'different_memo',
        messageBase64,
      }),
    }

    await expect(
      signSolanaV2PreparedEffect({ request, payerSecret, feePayerSecret }),
    ).rejects.toThrow('Prepared Solana message changed')
    payerSecret.fill(0)
    feePayerSecret.fill(0)
  })
})

async function exportSecret(signer: KeyPairSigner): Promise<Uint8Array> {
  const privateKey = await crypto.subtle.exportKey('pkcs8', signer.keyPair.privateKey)
  const publicKey = await crypto.subtle.exportKey('raw', signer.keyPair.publicKey)
  const secret = new Uint8Array(64)
  secret.set(new Uint8Array(privateKey).slice(16))
  secret.set(new Uint8Array(publicKey), 32)
  return secret
}

function hashBase64(value: string): string {
  return createHash('sha256').update(Buffer.from(value, 'base64')).digest('hex')
}
