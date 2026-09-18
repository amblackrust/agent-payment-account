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
import { encodePaymentResponseHeader } from '@x402/core/http'
import type { SettleResponse } from '@x402/core/types'
import { describe, expect, it, vi } from 'vitest'
import type { SolanaRpc } from '@agent-payment/solana-rail'
import {
  signSolanaX402PreparedEffect,
  type SolanaX402PreparedPayload,
} from '@agent-payment/solana-rail'
import type { V2PaymentAttemptSnapshot } from '@agent-payment/db'
import type { V2PreparedEffect } from './outgoing-v2.js'
import { createX402OutgoingExecutor } from './x402-executor.js'
import {
  X402_PAYMENT_RESPONSE_HEADER,
  X402_PROTOCOL,
  X402_SOLANA_MAINNET_NETWORK,
} from './x402-protocol.js'

const resourceUrl = 'https://x402engine.app/api/crypto/price?ids=bitcoin'
const mint = 'So11111111111111111111111111111111111111112'
const blockhash = '11111111111111111111111111111111'
const settlementTransaction = '1'.repeat(64)

describe('x402 outgoing executor', () => {
  it('sends the exact durable signed payload and records the provider settlement', async () => {
    const fixture = await createFixture()
    const settlement: SettleResponse = {
      success: true,
      transaction: settlementTransaction,
      network: X402_SOLANA_MAINNET_NETWORK,
      payer: fixture.payer.address,
    }
    const fetchImpl = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      const header = new Headers(init?.headers).get('PAYMENT-SIGNATURE')
      expect(header).toBeTruthy()
      return new Response(JSON.stringify({ bitcoin: { usd: 100_000 } }), {
        status: 200,
        headers: {
          [X402_PAYMENT_RESPONSE_HEADER]: encodePaymentResponseHeader(settlement),
          'x-request-id': 'provider-request-1',
        },
      })
    })
    const executor = createX402OutgoingExecutor({
      rpc: fixture.rpc,
      rpcUrl: 'https://rpc.example.test',
      settlementMint: mint,
      resourceUrl,
      maxPaymentAtomic: 100_000n,
      fetchImpl,
      getPayerPublicKey: async () => fixture.payer.address,
      getDenomination: async () => null,
      getSettlementAsset: async () => null,
      getEconomicMapping: async () => null,
      getSettlementRoute: async () => null,
      getActiveKeyVersion: async () => null,
      signPaymentEffect: async () => {
        throw new Error('submit test must use the pre-signed durable payload')
      },
    })
    const result = await executor.submit({
      prepared: fixture.prepared,
      signed: fixture.signed,
    })
    expect(result.status).toBe('CONFIRMED')
    expect(result.externalId).toBe(settlement.transaction)
    expect(result.evidenceMetadataJson).toContain('provider-request-1')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('replays the same signed payload during reconciliation and never rebuilds a transaction', async () => {
    const fixture = await createFixture()
    const headers: string[] = []
    const settlement: SettleResponse = {
      success: true,
      transaction: settlementTransaction,
      network: X402_SOLANA_MAINNET_NETWORK,
      payer: fixture.payer.address,
    }
    const fetchImpl = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      headers.push(new Headers(init?.headers).get('PAYMENT-SIGNATURE') ?? '')
      return new Response(JSON.stringify({ bitcoin: { usd: 100_000 } }), {
        status: 200,
        headers: {
          [X402_PAYMENT_RESPONSE_HEADER]: encodePaymentResponseHeader(settlement),
        },
      })
    })
    const executor = createX402OutgoingExecutor({
      rpc: fixture.rpc,
      rpcUrl: 'https://rpc.example.test',
      settlementMint: mint,
      resourceUrl,
      maxPaymentAtomic: 100_000n,
      fetchImpl,
      getPayerPublicKey: async () => fixture.payer.address,
      getDenomination: async () => null,
      getSettlementAsset: async () => null,
      getEconomicMapping: async () => null,
      getSettlementRoute: async () => null,
      getActiveKeyVersion: async () => null,
      signPaymentEffect: async () => fixture.signed,
    })
    const attempt: V2PaymentAttemptSnapshot = {
      id: 'att_1',
      paymentId: 'pay_1',
      attemptNumber: 1,
      routeId: 'route_1',
      status: 'RECONCILING',
      outcome: 'UNKNOWN',
      preparedEffectHash: fixture.prepared.effectHash,
      preparedEffectJson: JSON.stringify({
        ...fixture.prepared,
        amountAtomic: fixture.prepared.amountAtomic.toString(),
        validityExpiresAt: fixture.prepared.validityExpiresAt?.toISOString(),
      }),
      signedPayloadHash: sha256(fixture.signed.signedPayload),
      signedPayloadEncrypted: null,
      expectedExternalId: fixture.signed.externalId,
      validityExpiresAt: fixture.prepared.validityExpiresAt ?? null,
      validitySlot: null,
      rowVersion: 1,
    }
    const view = {} as Parameters<NonNullable<typeof executor.reconcile>>[0]['view']
    const first = await executor.reconcile!({
      view,
      attempt,
      signedPayload: fixture.signed.signedPayload,
    })
    const second = await executor.reconcile!({
      view,
      attempt,
      signedPayload: fixture.signed.signedPayload,
    })
    expect(first.status).toBe('CONFIRMED')
    expect(second.status).toBe('CONFIRMED')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(headers[0]).toBe(headers[1])
  })

  it('keeps a paid HTTP transport failure unknown', async () => {
    const fixture = await createFixture()
    const executor = createX402OutgoingExecutor({
      rpc: fixture.rpc,
      rpcUrl: 'https://rpc.example.test',
      settlementMint: mint,
      resourceUrl,
      maxPaymentAtomic: 100_000n,
      fetchImpl: vi.fn(async () => {
        throw new Error('connection reset')
      }),
      getPayerPublicKey: async () => fixture.payer.address,
      getDenomination: async () => null,
      getSettlementAsset: async () => null,
      getEconomicMapping: async () => null,
      getSettlementRoute: async () => null,
      getActiveKeyVersion: async () => null,
      signPaymentEffect: async () => fixture.signed,
    })
    const result = await executor.submit({
      prepared: fixture.prepared,
      signed: fixture.signed,
    })
    expect(result.status).toBe('UNKNOWN')
    expect(result.externalId).toBeUndefined()
  })
})

async function createFixture(): Promise<{
  readonly payer: Awaited<ReturnType<typeof generateKeyPairSigner>>
  readonly rpc: SolanaRpc
  readonly prepared: V2PreparedEffect
  readonly signed: Awaited<ReturnType<typeof signSolanaX402PreparedEffect>>
}> {
  const payer = await generateKeyPairSigner(true)
  const feePayer = await generateKeyPairSigner(true)
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
        ],
        value,
      ),
  )
  const transactionBase64 = getBase64EncodedWireTransaction(compileTransaction(message))
  const payloadHash = hashMessage(transactionBase64)
  const preparedPayload: SolanaX402PreparedPayload = {
    version: 1,
    protocol: X402_PROTOCOL,
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
      resource: { url: resourceUrl },
      accepted: {
        scheme: 'exact',
        network: X402_SOLANA_MAINNET_NETWORK,
        amount: '1000',
        asset: mint,
        payTo: feePayer.address,
        maxTimeoutSeconds: 300,
        extra: { feePayer: feePayer.address },
      },
      payload: { transaction: transactionBase64 },
    }),
  }
  const secret = await exportSecret(payer)
  const signed = await signSolanaX402PreparedEffect({
    request: {
      effectHash: 'a'.repeat(64),
      keyVersion: 1,
      network: 'mainnet-beta',
      assetReference: mint,
      destination: feePayer.address,
      amountAtomic: 1000n,
      feePayerIdentity: feePayer.address,
      preparedPayload: JSON.stringify(preparedPayload),
    },
    payerSecret: secret,
  })
  secret.fill(0)
  const prepared: V2PreparedEffect = {
    accountId: 'acct_1',
    paymentId: 'pay_1',
    attemptId: 'att_1',
    effectHash: signed.effectHash,
    network: 'mainnet-beta',
    assetReference: mint,
    destination: feePayer.address,
    amountAtomic: 1000n,
    feePayerIdentity: feePayer.address,
    keyVersion: 1,
    preparedPayload: JSON.stringify(preparedPayload),
    routeId: 'route_1',
    payloadHash,
    validityExpiresAt: new Date(Date.now() + 300_000),
  }
  return {
    payer,
    rpc: {
      getSignatureStatuses: () => ({
        send: async () => ({
          value: [{ err: null, confirmationStatus: 'confirmed' }],
        }),
      }),
    } as unknown as SolanaRpc,
    prepared,
    signed,
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

function hashMessage(transactionBase64: string): string {
  const bytes = Uint8Array.from(Buffer.from(transactionBase64, 'base64'))
  const decoded = getTransactionDecoder().decode(bytes)
  return sha256(Uint8Array.from(decoded.messageBytes))
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}
