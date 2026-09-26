import { createHash } from 'node:crypto'
import {
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getTransactionDecoder,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit'
import {
  findAssociatedTokenPda,
  getTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token'
import { getAddMemoInstruction } from '@solana-program/memo'
import { describe, expect, it } from 'vitest'
import {
  signSolanaX402PreparedEffect,
  type SolanaX402PreparedPayload,
} from './x402-signing.js'

const mint = 'So11111111111111111111111111111111111111112'
const blockhash = '11111111111111111111111111111111'

describe('Solana x402 signing boundary', () => {
  it('adds only the Agent Account signature to the durable partial transaction', async () => {
    const payer = await generateKeyPairSigner(true)
    const feePayer = await generateKeyPairSigner(true)
    const payerSecret = await exportSecret(payer)
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
              amount: 1000n,
              decimals: 6,
            }),
            getAddMemoInstruction({ memo: 'x402-test' }),
          ],
          value,
        ),
    )
    const transactionBase64 = getBase64EncodedWireTransaction(
      compileTransaction(message),
    )
    const payloadHash = hashMessage(transactionBase64)
    const prepared: SolanaX402PreparedPayload = {
      version: 1,
      protocol: 'x402-v2',
      payerOwner: payer.address,
      recipientOwner: feePayer.address,
      payerAta: payerAta[0],
      recipientAta: recipientAta[0],
      settlementMint: mint,
      tokenAmount: '1000',
      feePayerIdentity: feePayer.address,
      transactionBase64,
      payloadHash,
      requirementHash: 'd'.repeat(64),
      paymentPayloadJson: JSON.stringify({
        x402Version: 2,
        resource: { url: 'https://example.test/resource' },
        accepted: {
          scheme: 'exact',
          network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
          amount: '1000',
          asset: mint,
          payTo: feePayer.address,
          maxTimeoutSeconds: 300,
          extra: { feePayer: feePayer.address },
        },
        payload: { transaction: transactionBase64 },
      }),
    }
    const signed = await signSolanaX402PreparedEffect({
      request: {
        effectHash: 'a'.repeat(64),
        keyVersion: 1,
        network: 'mainnet-beta',
        assetReference: mint,
        destination: feePayer.address,
        amountAtomic: 1000n,
        feePayerIdentity: feePayer.address,
        preparedPayload: JSON.stringify(prepared),
      },
      payerSecret,
    })
    const decoded = getTransactionDecoder().decode(signed.signedPayload)
    const signatures = decoded.signatures as unknown as Record<string, unknown>
    expect(signatures[payer.address]).not.toBeNull()
    expect(signatures[feePayer.address]).toBeNull()
    expect(signed.externalId).toBe(`x402-effect:${payloadHash}`)

    const feePayerSecret = await exportSecret(feePayer)
    const fullySigned = await signSolanaX402PreparedEffect({
      request: {
        effectHash: 'a'.repeat(64),
        keyVersion: 1,
        network: 'mainnet-beta',
        assetReference: mint,
        destination: feePayer.address,
        amountAtomic: 1000n,
        feePayerIdentity: feePayer.address,
        preparedPayload: JSON.stringify(prepared),
      },
      payerSecret,
      feePayerSecret,
    })
    const fullySignedSignatures = getTransactionDecoder().decode(
      fullySigned.signedPayload,
    ).signatures as unknown as Record<string, unknown>
    expect(fullySignedSignatures[payer.address]).not.toBeNull()
    expect(fullySignedSignatures[feePayer.address]).not.toBeNull()
    feePayerSecret.fill(0)
    payerSecret.fill(0)
  })

  it('rejects a signing request that tries to redirect the durable payment', async () => {
    await expect(
      signSolanaX402PreparedEffect({
        request: {
          effectHash: 'b'.repeat(64),
          keyVersion: 1,
          network: 'mainnet-beta',
          assetReference: mint,
          destination: '11111111111111111111111111111111',
          amountAtomic: 1n,
          feePayerIdentity: '11111111111111111111111111111111',
          preparedPayload: JSON.stringify({
            version: 1,
            protocol: 'x402-v2',
            payerOwner: '11111111111111111111111111111111',
            recipientOwner: '11111111111111111111111111111112',
            payerAta: '11111111111111111111111111111113',
            recipientAta: '11111111111111111111111111111114',
            settlementMint: mint,
            tokenAmount: '1',
            feePayerIdentity: '11111111111111111111111111111115',
            transactionBase64: 'AQ==',
            payloadHash: 'c'.repeat(64),
            requirementHash: 'd'.repeat(64),
            paymentPayloadJson: '{}',
          }),
        },
        payerSecret: new Uint8Array(64),
      }),
    ).rejects.toThrow(/does not match/i)
  })

  it('rejects using the Agent Account signer as the x402 fee payer', async () => {
    const payer = await generateKeyPairSigner(true)
    const payerSecret = await exportSecret(payer)
    const prepared: SolanaX402PreparedPayload = {
      version: 1,
      protocol: 'x402-v2',
      payerOwner: payer.address,
      recipientOwner: '11111111111111111111111111111112',
      payerAta: '11111111111111111111111111111113',
      recipientAta: '11111111111111111111111111111114',
      settlementMint: mint,
      tokenAmount: '1',
      feePayerIdentity: payer.address,
      transactionBase64: 'AQ==',
      payloadHash: 'c'.repeat(64),
      requirementHash: 'd'.repeat(64),
      paymentPayloadJson: '{}',
    }

    await expect(
      signSolanaX402PreparedEffect({
        request: {
          effectHash: 'e'.repeat(64),
          keyVersion: 1,
          network: 'mainnet-beta',
          assetReference: mint,
          destination: prepared.recipientOwner,
          amountAtomic: 1n,
          feePayerIdentity: payer.address,
          preparedPayload: JSON.stringify(prepared),
        },
        payerSecret,
      }),
    ).rejects.toThrow(/fee payer must be different/i)
    payerSecret.fill(0)
  })
})

async function exportSecret(signer: {
  readonly keyPair: CryptoKeyPair
}): Promise<Uint8Array> {
  const privateKey = await crypto.subtle.exportKey('pkcs8', signer.keyPair.privateKey)
  const publicKey = await crypto.subtle.exportKey('raw', signer.keyPair.publicKey)
  const secret = new Uint8Array(64)
  secret.set(new Uint8Array(privateKey).slice(16))
  secret.set(new Uint8Array(publicKey), 32)
  return secret
}

function hashMessage(transactionBase64: string): string {
  const decoded = getTransactionDecoder().decode(
    Uint8Array.from(Buffer.from(transactionBase64, 'base64')),
  )
  return createHash('sha256')
    .update(Uint8Array.from(decoded.messageBytes))
    .digest('hex')
}
