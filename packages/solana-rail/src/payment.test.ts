import { address, generateKeyPairSigner } from '@solana/kit'
import {
  findAssociatedTokenPda,
  getMintEncoder,
  getTokenEncoder,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token'
import { describe, expect, it } from 'vitest'

import { createPositiveMoney } from '@agent-payment/core'
import {
  createSolanaPaymentPreparationRail,
  createSolanaPaymentRailWithRpc,
  SOLANA_SPL_RAIL,
} from './payment.js'

const mint = address('So11111111111111111111111111111111111111112')
const blockhash = '11111111111111111111111111111111'
const localnetGenesisHash = 'localnet-genesis'

type RpcAccount = {
  readonly owner: string
  readonly data: readonly [string, 'base64']
  readonly executable: boolean
  readonly lamports: bigint
  readonly space: bigint
}

function encodeAccount(owner: string, data: Uint8Array): RpcAccount {
  return {
    owner,
    data: [Buffer.from(data).toString('base64'), 'base64'],
    executable: false,
    lamports: 1_000_000n,
    space: BigInt(data.length),
  }
}

function createMockRpc(
  accounts: Map<string, RpcAccount>,
  feePayerBalance = 1_000_000_000n,
  onSend?: (transaction: string) => string,
  onSignatureStatus?: () => unknown,
) {
  return {
    getGenesisHash: () => ({ send: async () => localnetGenesisHash }),
    getAccountInfo: (accountAddress: string) => ({
      send: async () => ({ value: accounts.get(accountAddress) ?? null }),
    }),
    getBalance: () => ({ send: async () => ({ value: feePayerBalance }) }),
    getLatestBlockhash: () => ({
      send: async () => ({
        value: { blockhash, lastValidBlockHeight: 100n },
      }),
    }),
    getSignatureStatuses: () => ({
      send: async () => onSignatureStatus?.() ?? { value: [null] },
    }),
    getBlockHeight: () => ({ send: async () => 1n }),
    sendTransaction: (transaction: string) => ({
      send: async () => onSend?.(transaction) ?? '',
    }),
  } as never
}

function mintData(decimals: number): Uint8Array {
  return new Uint8Array(
    getMintEncoder().encode({
      mintAuthority: null,
      supply: 1_000_000_000n,
      decimals,
      isInitialized: true,
      freezeAuthority: null,
    }),
  )
}

function tokenData(owner: ReturnType<typeof address>, amount: bigint): Uint8Array {
  return new Uint8Array(
    getTokenEncoder().encode({
      mint,
      owner,
      amount,
      delegate: null,
      state: 1,
      isNative: null,
      delegatedAmount: 0n,
      closeAuthority: null,
    }),
  )
}

async function exportSecret(signer: Awaited<ReturnType<typeof generateKeyPairSigner>>) {
  const privateKey = await crypto.subtle.exportKey('pkcs8', signer.keyPair.privateKey)
  const publicKey = await crypto.subtle.exportKey('raw', signer.keyPair.publicKey)
  const secret = new Uint8Array(64)
  secret.set(new Uint8Array(privateKey).slice(16))
  secret.set(new Uint8Array(publicKey), 32)
  return secret
}

async function createPreparedRail() {
  const payer = await generateKeyPairSigner(true)
  const feePayer = await generateKeyPairSigner(true)
  const recipient = await generateKeyPairSigner(true)
  const [payerAta] = await findAssociatedTokenPda({
    owner: payer.address,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
    mint,
  })
  const accounts = new Map<string, RpcAccount>([
    [mint, encodeAccount(TOKEN_PROGRAM_ADDRESS, mintData(6))],
    [
      payerAta,
      encodeAccount(TOKEN_PROGRAM_ADDRESS, tokenData(payer.address, 12_500_000n)),
    ],
  ])
  let sentTransaction = ''
  let signatureValue = ''
  let statusCalls = 0
  const rail = createSolanaPaymentRailWithRpc({
    rpc: createMockRpc(
      accounts,
      1_000_000_000n,
      (transaction) => {
        sentTransaction = transaction
        return signatureValue
      },
      () => {
        statusCalls += 1
        return statusCalls === 1
          ? { value: [null] }
          : { value: [{ err: null, confirmationStatus: 'confirmed', slot: 42n }] }
      },
    ),
    expectedCluster: 'localnet',
    allowMainnet: false,
    settlementMint: mint,
    feePayerSecret: JSON.stringify(Array.from(await exportSecret(feePayer))),
  })
  const payerSecret = await exportSecret(payer)
  const prepared = await rail.prepare(
    {
      operation: 'SEND',
      currency: 'USD',
      amount: createPositiveMoney('12.50'),
      payerAccountId: 'acct_payer',
      recipientId: 'rcpt_recipient',
      destination: {
        rail: SOLANA_SPL_RAIL,
        type: SOLANA_SPL_RAIL,
        reference: recipient.address,
      },
    },
    {
      paymentId: 'pay_transfer',
      payerAccountId: 'acct_payer',
      payerPublicKey: payer.address,
      getPayerSecretKey: async () => payerSecret,
    },
  )
  signatureValue = prepared.durableExecution?.expectedTransactionId ?? ''
  return { rail, prepared, payerSecret, getSent: () => sentTransaction }
}

describe('Solana payment rail', () => {
  it('keeps the Task 03 preparation-only route free of execution', async () => {
    const rail = createSolanaPaymentPreparationRail()
    expect(rail.execute).toBeUndefined()
  })

  it('builds checked SPL transfer bytes with separate token authority and fee payer', async () => {
    const fixture = await createPreparedRail()
    const durable = fixture.prepared.durableExecution

    expect(durable).toBeDefined()
    expect(durable?.serializedTransactionBase64).toMatch(/^[A-Za-z0-9+/=]+$/)
    expect(durable?.expectedTransactionId).toBeTruthy()
    expect(fixture.payerSecret.every((byte) => byte === 0)).toBe(true)
  })

  it('sends the durable signed bytes and confirms before returning success', async () => {
    const fixture = await createPreparedRail()
    const execution = await fixture.rail.execute?.(fixture.prepared)

    expect(execution?.status).toBe('CONFIRMED')
    expect(execution?.confirmedSlot).toBe(42n)
    expect(fixture.getSent()).toBe(
      fixture.prepared.durableExecution?.serializedTransactionBase64,
    )
  })

  it('classifies confirmation timeout after send as ambiguous', async () => {
    const fixture = await createPreparedRail()
    let statusCalls = 0
    const ambiguousRail = createSolanaPaymentRailWithRpc({
      rpc: createMockRpc(
        new Map([[mint, encodeAccount(TOKEN_PROGRAM_ADDRESS, mintData(6))]]),
        1_000_000_000n,
        () => fixture.prepared.durableExecution?.expectedTransactionId ?? '',
        () => {
          statusCalls += 1
          return statusCalls === 1 ? { value: [null] } : new Promise(() => undefined)
        },
      ),
      expectedCluster: 'localnet',
      allowMainnet: false,
      settlementMint: mint,
      feePayerSecret: JSON.stringify(Array.from(new Uint8Array(64).fill(1))),
      rpcTimeoutMs: 5,
      confirmationTimeoutMs: 25,
      pollIntervalMs: 0,
    })

    await expect(ambiguousRail.execute?.(fixture.prepared)).rejects.toMatchObject({
      code: 'EXTERNAL_RAIL_FAILURE',
      kind: 'AMBIGUOUS',
    })
  })
})
