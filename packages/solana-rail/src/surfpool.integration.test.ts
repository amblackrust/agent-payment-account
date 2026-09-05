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
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createPositiveMoney } from '@agent-payment/core'
import { createSolanaPaymentRailWithRpc } from './payment.js'

async function exportSecret(signer: KeyPairSigner): Promise<Uint8Array> {
  const privateKey = await crypto.subtle.exportKey('pkcs8', signer.keyPair.privateKey)
  const publicKey = await crypto.subtle.exportKey('raw', signer.keyPair.publicKey)
  const secret = new Uint8Array(64)
  secret.set(new Uint8Array(privateKey).slice(16))
  secret.set(new Uint8Array(publicKey), 32)
  return secret
}

describe('Solana payment rail on isolated offline Surfpool', () => {
  const _createSurfpoolClient = () =>
    createClient().use(surfpool({ surfnet: { offline: true } }))
  let client: Awaited<ReturnType<typeof _createSurfpoolClient>>

  beforeAll(async () => {
    client = await createClient().use(surfpool({ surfnet: { offline: true } }))
  })

  afterAll(() => {
    client.surfnet.stop()
  })

  it('moves SPL tokens and creates the recipient ATA with separate fee payer', async () => {
    const payer = await generateKeyPairSigner(true)
    const feePayer = await generateKeyPairSigner(true)
    const recipient = await generateKeyPairSigner(true)
    const mint = await generateKeyPairSigner(true)
    const mintData = getMintEncoder().encode({
      mintAuthority: { __option: 'Some', value: client.payer.address },
      supply: 2_000_000_000n,
      decimals: 6,
      isInitialized: true,
      freezeAuthority: null,
    })

    client.surfnet.fundSol(payer.address, 1_000_000_000)
    client.surfnet.fundSol(feePayer.address, 1_000_000_000)
    await client.cheatcodes
      .setAccount(mint.address, {
        data: getBase16Decoder().decode(new Uint8Array(mintData)),
        lamports: 1_000_000,
        owner: TOKEN_PROGRAM_ADDRESS,
      })
      .send()
    await client.cheatcodes
      .setTokenAccount(payer.address, mint.address, { amount: 2_000_000n })
      .send()

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
    const rail = createSolanaPaymentRailWithRpc({
      rpc: client.rpc as never,
      expectedCluster: 'localnet',
      allowMainnet: false,
      settlementMint: mint.address,
      feePayerSecret: JSON.stringify(Array.from(await exportSecret(feePayer))),
    })
    const payerSecret = await exportSecret(payer)
    const prepared = await rail.prepare(
      {
        operation: 'SEND',
        currency: 'USD',
        amount: createPositiveMoney('1.25'),
        payerAccountId: 'acct_surfpool',
        recipientId: 'rcpt_surfpool',
        destination: {
          rail: 'SOLANA_SPL',
          type: 'SOLANA_SPL',
          reference: recipient.address,
        },
      },
      {
        paymentId: 'pay_surfpool',
        payerAccountId: 'acct_surfpool',
        payerPublicKey: payer.address,
        getPayerSecretKey: async () => payerSecret,
      },
    )
    const execution = await rail.execute?.(prepared)
    const payerToken = await fetchMaybeToken(client.rpc, payerAta)
    const recipientToken = await fetchMaybeToken(client.rpc, recipientAta)

    expect(execution?.status).toBe('CONFIRMED')
    expect(execution?.railTransactionId).toBe(
      prepared.durableExecution?.expectedTransactionId,
    )
    expect(payerToken.exists && payerToken.data.amount).toBe(750_000n)
    expect(recipientToken.exists && recipientToken.data.amount).toBe(1_250_000n)
  })
})
