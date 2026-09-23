import { createKeyPairFromBytes } from '@solana/keys'
import {
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  partiallySignTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit'
import {
  findAssociatedTokenPda,
  getTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token'
import {
  decodePaymentRequiredHeader,
  encodePaymentSignatureHeader,
} from '@x402/core/http'
import type { PaymentPayload } from '@x402/core/types'
import { describe, expect, it } from 'vitest'
import { createFakeX402App } from './app.js'
import { DEVNET_GENESIS_HASH, DEVNET_NETWORK, type FakeX402Config } from './config.js'
import type { FakeX402Rpc, FakeX402RpcTransaction } from './rpc.js'

const resourceUrl = 'http://fake-x402.test/api/crypto/price?ids=bitcoin'
const settlementMint = 'So11111111111111111111111111111111111111112'
const blockhash = '11111111111111111111111111111111'

describe('local fake x402 service', () => {
  it('advertises a 402 challenge and verifies one fully signed SPL transfer', async () => {
    const fixture = await createFixture()
    const app = createFakeX402App({
      config: fixture.config,
      rpc: fixture.rpc,
    })
    try {
      const discovery = await app.inject({
        method: 'GET',
        url: '/api/crypto/price?ids=bitcoin',
      })
      expect(discovery.statusCode).toBe(402)
      const encodedRequirement = discovery.headers['payment-required']
      expect(encodedRequirement).toBeTypeOf('string')
      const requirement = decodePaymentRequiredHeader(encodedRequirement as string)
      expect(requirement.accepts).toHaveLength(1)
      expect(requirement.accepts[0]?.network).toBe(DEVNET_NETWORK)
      expect(requirement.accepts[0]?.asset).toBe(settlementMint)
      expect(requirement.accepts[0]?.amount).toBe('1000')

      const paid = await app.inject({
        method: 'GET',
        url: '/api/crypto/price?ids=bitcoin',
        headers: { 'payment-signature': fixture.paymentSignature },
      })
      expect(paid.statusCode).toBe(200)
      expect(paid.json()).toEqual({ bitcoin: { usd: 60_000 } })
      expect(paid.headers['payment-response']).toBeTypeOf('string')

      const replay = await app.inject({
        method: 'GET',
        url: '/api/crypto/price?ids=bitcoin',
        headers: { 'payment-signature': fixture.paymentSignature },
      })
      expect(replay.statusCode).toBe(200)
      expect(replay.json()).toEqual({ bitcoin: { usd: 60_000 } })
    } finally {
      await app.close()
    }
  })

  it('rejects a payment whose confirmed token delta is not the advertised amount', async () => {
    const fixture = await createFixture({ destinationDelta: 999n })
    const app = createFakeX402App({
      config: fixture.config,
      rpc: fixture.rpc,
    })
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/crypto/price?ids=bitcoin',
        headers: { 'payment-signature': fixture.paymentSignature },
      })
      expect(response.statusCode).toBe(402)
      expect(response.json()).toEqual({ error: 'TRANSFER_MISMATCH' })
    } finally {
      await app.close()
    }
  })

  it('rejects a confirmed transaction with an additional TEST_USDC transfer', async () => {
    const fixture = await createFixture({ extraSettlementTransfer: true })
    const app = createFakeX402App({
      config: fixture.config,
      rpc: fixture.rpc,
    })
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/crypto/price?ids=bitcoin',
        headers: { 'payment-signature': fixture.paymentSignature },
      })
      expect(response.statusCode).toBe(402)
      expect(response.json()).toEqual({ error: 'TRANSFER_MISMATCH' })
    } finally {
      await app.close()
    }
  })
})

async function createFixture(
  input: {
    readonly destinationDelta?: bigint
    readonly extraSettlementTransfer?: boolean
  } = {},
) {
  const payer = await generateKeyPairSigner(true)
  const destination = await generateKeyPairSigner(true)
  const extraDestination = await generateKeyPairSigner(true)
  const facilitator = await generateKeyPairSigner(true)
  const [payerAta, destinationAta, extraDestinationAta] = await Promise.all([
    findAssociatedTokenPda({
      owner: payer.address,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      mint: settlementMint as never,
    }),
    findAssociatedTokenPda({
      owner: destination.address,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      mint: settlementMint as never,
    }),
    findAssociatedTokenPda({
      owner: extraDestination.address,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      mint: settlementMint as never,
    }),
  ])
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (value) =>
      setTransactionMessageFeePayerSigner(createNoopSigner(facilitator.address), value),
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
            mint: settlementMint as never,
            destination: destinationAta[0],
            authority: createNoopSigner(payer.address),
            amount: 1000n,
            decimals: 6,
          }),
          ...(input.extraSettlementTransfer
            ? [
                getTransferCheckedInstruction({
                  source: payerAta[0],
                  mint: settlementMint as never,
                  destination: extraDestinationAta[0],
                  authority: createNoopSigner(payer.address),
                  amount: 1n,
                  decimals: 6,
                }),
              ]
            : []),
        ],
        value,
      ),
  )
  const unsigned = compileTransaction(message)
  const [payerKeyPair, facilitatorKeyPair] = await Promise.all([
    createKeyPairFromBytes(await exportSecret(payer), false),
    createKeyPairFromBytes(await exportSecret(facilitator), false),
  ])
  const signed = await partiallySignTransaction(
    [payerKeyPair, facilitatorKeyPair],
    unsigned,
  )
  const transactionBase64 = getBase64EncodedWireTransaction(signed)
  const paymentPayload: PaymentPayload = {
    x402Version: 2,
    resource: { url: resourceUrl },
    accepted: {
      scheme: 'exact',
      network: DEVNET_NETWORK,
      amount: '1000',
      asset: settlementMint,
      payTo: destination.address,
      maxTimeoutSeconds: 300,
      extra: { feePayer: facilitator.address, decimals: 6 },
    },
    payload: { transaction: transactionBase64 },
  }
  const config: FakeX402Config = {
    host: '127.0.0.1',
    port: 4542,
    rpcUrl: 'https://api.devnet.solana.com',
    network: DEVNET_NETWORK,
    settlementMint,
    destination: destination.address,
    facilitatorFeePayer: facilitator.address,
    amountAtomic: 1000n,
    tokenDecimals: 6,
    maxTimeoutSeconds: 300,
    dropResponseAfterSettlement: false,
    resourceUrl,
  }
  const transaction: FakeX402RpcTransaction = {
    meta: {
      err: null,
      preTokenBalances: [
        {
          accountIndex: 2,
          mint: settlementMint,
          owner: payer.address,
          uiTokenAmount: { amount: '1000000' },
        },
        {
          accountIndex: 3,
          mint: settlementMint,
          owner: destination.address,
          uiTokenAmount: { amount: '0' },
        },
      ],
      postTokenBalances: [
        {
          accountIndex: 2,
          mint: settlementMint,
          owner: payer.address,
          uiTokenAmount: {
            amount: input.extraSettlementTransfer ? '998999' : '999000',
          },
        },
        {
          accountIndex: 3,
          mint: settlementMint,
          owner: destination.address,
          uiTokenAmount: {
            amount: (input.destinationDelta ?? 1000n).toString(),
          },
        },
        ...(input.extraSettlementTransfer
          ? [
              {
                accountIndex: 4,
                mint: settlementMint,
                owner: extraDestination.address,
                uiTokenAmount: { amount: '1' },
              },
            ]
          : []),
      ],
      innerInstructions: [],
    },
    transaction: {
      message: {
        accountKeys: [
          { pubkey: facilitator.address, signer: true },
          { pubkey: payer.address, signer: true },
          { pubkey: payerAta[0] },
          { pubkey: destinationAta[0] },
          ...(input.extraSettlementTransfer
            ? [{ pubkey: extraDestinationAta[0] }]
            : []),
        ],
        instructions: [
          {
            program: 'spl-token',
            parsed: {
              type: 'transferChecked',
              info: {
                source: payerAta[0],
                destination: destinationAta[0],
                authority: payer.address,
                mint: settlementMint,
                tokenAmount: { amount: '1000' },
              },
            },
          },
          ...(input.extraSettlementTransfer
            ? [
                {
                  program: 'spl-token',
                  parsed: {
                    type: 'transferChecked',
                    info: {
                      source: payerAta[0],
                      destination: extraDestinationAta[0],
                      authority: payer.address,
                      mint: settlementMint,
                      tokenAmount: { amount: '1' },
                    },
                  },
                },
              ]
            : []),
        ],
      },
    },
  }
  const rpc: FakeX402Rpc = {
    getGenesisHash: () => ({ send: async () => DEVNET_GENESIS_HASH }),
    getSignatureStatuses: () => ({
      send: async () => ({
        value: [{ err: null, confirmationStatus: 'confirmed' }],
      }),
    }),
    getTransaction: () => ({ send: async () => transaction }),
  }
  return {
    config,
    rpc,
    paymentSignature: encodePaymentSignatureHeader(paymentPayload),
  }
}

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
