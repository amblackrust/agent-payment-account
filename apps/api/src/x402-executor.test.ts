import { createHash } from 'node:crypto'
import {
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
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
import type { Network, SettleResponse } from '@x402/core/types'
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
  hashRequirement,
  X402_PAYMENT_RESPONSE_HEADER,
  X402_PROTOCOL,
  X402_SOLANA_DEVNET_NETWORK,
  X402_SOLANA_MAINNET_NETWORK,
  X402_SOLANA_USDC_MINT,
} from './x402-protocol.js'

const resourceUrl = 'https://x402engine.app/api/crypto/price?ids=bitcoin'
const mint = X402_SOLANA_USDC_MINT
const testMint = 'So11111111111111111111111111111111111111112'
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
      expect(init?.redirect).toBe('error')
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
    expect(result.evidenceMetadataJson).toContain('100000')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('accepts an explicit devnet network, test mint and provider fee payer', async () => {
    const fixture = await createFixture({
      x402Network: X402_SOLANA_DEVNET_NETWORK,
      routeNetwork: 'devnet',
      mint: testMint,
    })
    const settlement: SettleResponse = {
      success: true,
      transaction: settlementTransaction,
      network: X402_SOLANA_DEVNET_NETWORK,
      payer: fixture.payer.address,
    }
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ bitcoin: { usd: 60_000 } }), {
          status: 200,
          headers: {
            [X402_PAYMENT_RESPONSE_HEADER]: encodePaymentResponseHeader(settlement),
          },
        }),
    )
    const executor = createX402OutgoingExecutor({
      rpc: fixture.rpc,
      rpcUrl: 'https://rpc.example.test',
      network: X402_SOLANA_DEVNET_NETWORK,
      routeNetwork: 'devnet',
      settlementMint: testMint,
      providerDestination: fixture.recipient.address,
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
    const result = await executor.submit({
      prepared: fixture.prepared,
      signed: fixture.signed,
    })
    expect(result.status).toBe('CONFIRMED')
    expect(result.externalId).toBe(settlementTransaction)
  })

  it('does not replay a partially signed payload without a settlement signature', async () => {
    const fixture = await createFixture()
    const fetchImpl = vi.fn()
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
      externalId: null,
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
    expect(first.status).toBe('UNKNOWN')
    expect(second.status).toBe('UNKNOWN')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('uses a persisted settlement signature instead of resending the payment', async () => {
    const fixture = await createFixture()
    const fetchImpl = vi.fn(async () => {
      throw new Error('provider must not be called during settlement recovery')
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
      id: 'att_persisted_settlement',
      paymentId: 'pay_persisted_settlement',
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
      externalId: settlementTransaction,
      validityExpiresAt: fixture.prepared.validityExpiresAt ?? null,
      validitySlot: null,
      rowVersion: 1,
    }
    const result = await executor.reconcile!({
      view: {} as Parameters<NonNullable<typeof executor.reconcile>>[0]['view'],
      attempt,
      signedPayload: fixture.signed.signedPayload,
    })
    expect(result.status).toBe('CONFIRMED')
    expect(result.externalId).toBe(settlementTransaction)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('reconciles a persisted settlement signature without custody payload recovery', async () => {
    const fixture = await createFixture()
    const fetchImpl = vi.fn(async () => {
      throw new Error('provider must not be called during settlement recovery')
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
      id: 'att_persisted_without_payload',
      paymentId: 'pay_persisted_without_payload',
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
      externalId: settlementTransaction,
      validityExpiresAt: fixture.prepared.validityExpiresAt ?? null,
      validitySlot: null,
      rowVersion: 1,
    }
    const result = await executor.reconcile!({
      view: {} as Parameters<NonNullable<typeof executor.reconcile>>[0]['view'],
      attempt,
    })
    expect(result.status).toBe('CONFIRMED')
    expect(result.externalId).toBe(settlementTransaction)
    expect(fetchImpl).not.toHaveBeenCalled()
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

  it('recovers a confirmed devnet effect from the durable fully signed payload', async () => {
    const fixture = await createFixture({
      x402Network: X402_SOLANA_DEVNET_NETWORK,
      routeNetwork: 'devnet',
      mint: testMint,
    })
    const fetchImpl = vi.fn(async () => {
      throw new Error('fake provider is unavailable after settlement')
    })
    const executor = createX402OutgoingExecutor({
      rpc: fixture.rpc,
      rpcUrl: 'https://rpc.example.test',
      network: X402_SOLANA_DEVNET_NETWORK,
      routeNetwork: 'devnet',
      settlementMint: testMint,
      providerDestination: fixture.recipient.address,
      signFeePayer: true,
      platformFeePayerIdentity: fixture.recipient.address,
      resourceUrl,
      maxPaymentAtomic: 100_000n,
      fetchImpl,
      getPayerPublicKey: async () => fixture.payer.address,
      getDenomination: async () => null,
      getSettlementAsset: async () => null,
      getEconomicMapping: async () => null,
      getSettlementRoute: async () => null,
      getActiveKeyVersion: async () => null,
      signPaymentEffect: async () => fixture.fullySigned,
    })
    const attempt: V2PaymentAttemptSnapshot = {
      id: 'att_recovery',
      paymentId: 'pay_recovery',
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
      signedPayloadHash: sha256(fixture.fullySigned.signedPayload),
      signedPayloadEncrypted: null,
      expectedExternalId: fixture.fullySigned.externalId,
      validityExpiresAt: fixture.prepared.validityExpiresAt ?? null,
      validitySlot: null,
      rowVersion: 1,
    }
    const result = await executor.reconcile!({
      view: {} as Parameters<NonNullable<typeof executor.reconcile>>[0]['view'],
      attempt,
      signedPayload: fixture.fullySigned.signedPayload,
    })
    const transaction = getTransactionDecoder().decode(
      fixture.fullySigned.signedPayload,
    )
    expect(result.status).toBe('CONFIRMED')
    expect(result.externalId).toBe(String(getSignatureFromTransaction(transaction)))
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('does not persist an untrusted provider signature after a mismatch', async () => {
    const fixture = await createFixture({
      x402Network: X402_SOLANA_DEVNET_NETWORK,
      routeNetwork: 'devnet',
      mint: testMint,
    })
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ bitcoin: { usd: 60_000 } }), {
          status: 200,
          headers: {
            [X402_PAYMENT_RESPONSE_HEADER]: encodePaymentResponseHeader({
              success: true,
              transaction: settlementTransaction,
              network: X402_SOLANA_DEVNET_NETWORK,
              payer: fixture.payer.address,
            }),
          },
        }),
    )
    const executor = createX402OutgoingExecutor({
      rpc: fixture.rpc,
      rpcUrl: 'https://rpc.example.test',
      network: X402_SOLANA_DEVNET_NETWORK,
      routeNetwork: 'devnet',
      settlementMint: testMint,
      providerDestination: fixture.recipient.address,
      signFeePayer: true,
      platformFeePayerIdentity: fixture.recipient.address,
      resourceUrl,
      maxPaymentAtomic: 100_000n,
      fetchImpl,
      getPayerPublicKey: async () => fixture.payer.address,
      getDenomination: async () => null,
      getSettlementAsset: async () => null,
      getEconomicMapping: async () => null,
      getSettlementRoute: async () => null,
      getActiveKeyVersion: async () => null,
      signPaymentEffect: async () => fixture.fullySigned,
    })

    const result = await executor.submit({
      prepared: fixture.prepared,
      signed: fixture.fullySigned,
    })

    expect(result.status).toBe('UNKNOWN')
    expect(result.externalId).toBeUndefined()
    expect(result.evidenceMetadataJson).toContain('SETTLEMENT_TRANSACTION_MISMATCH')
  })

  it('does not confirm a transaction whose wire message differs from the durable payload', async () => {
    const fixture = await createFixture({
      x402Network: X402_SOLANA_DEVNET_NETWORK,
      routeNetwork: 'devnet',
      mint: testMint,
      useMismatchedWire: true,
    })
    const signedTransaction = getTransactionDecoder().decode(
      fixture.fullySigned.signedPayload,
    )
    const transactionId = String(getSignatureFromTransaction(signedTransaction))
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ bitcoin: { usd: 60_000 } }), {
          status: 200,
          headers: {
            [X402_PAYMENT_RESPONSE_HEADER]: encodePaymentResponseHeader({
              success: true,
              transaction: transactionId,
              network: X402_SOLANA_DEVNET_NETWORK,
              payer: fixture.payer.address,
            }),
          },
        }),
    )
    const executor = createX402OutgoingExecutor({
      rpc: fixture.rpc,
      rpcUrl: 'https://rpc.example.test',
      network: X402_SOLANA_DEVNET_NETWORK,
      routeNetwork: 'devnet',
      settlementMint: testMint,
      providerDestination: fixture.recipient.address,
      signFeePayer: true,
      platformFeePayerIdentity: fixture.recipient.address,
      resourceUrl,
      maxPaymentAtomic: 100_000n,
      fetchImpl,
      getPayerPublicKey: async () => fixture.payer.address,
      getDenomination: async () => null,
      getSettlementAsset: async () => null,
      getEconomicMapping: async () => null,
      getSettlementRoute: async () => null,
      getActiveKeyVersion: async () => null,
      signPaymentEffect: async () => fixture.fullySigned,
    })

    const result = await executor.submit({
      prepared: fixture.prepared,
      signed: fixture.fullySigned,
    })

    expect(result.status).toBe('UNKNOWN')
    expect(result.externalId).toBeUndefined()
    expect(result.evidenceMetadataJson).toContain('TRANSACTION_MESSAGE_MISMATCH')
  })

  it('rejects an additional legacy SPL transfer without an inline mint', async () => {
    const fixture = await createFixture({
      x402Network: X402_SOLANA_DEVNET_NETWORK,
      routeNetwork: 'devnet',
      mint: testMint,
      extraUncheckedSettlementTransfer: true,
    })
    const transaction = getTransactionDecoder().decode(
      fixture.fullySigned.signedPayload,
    )
    const transactionId = String(getSignatureFromTransaction(transaction))
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ bitcoin: { usd: 60_000 } }), {
          status: 200,
          headers: {
            [X402_PAYMENT_RESPONSE_HEADER]: encodePaymentResponseHeader({
              success: true,
              transaction: transactionId,
              network: X402_SOLANA_DEVNET_NETWORK,
              payer: fixture.payer.address,
            }),
          },
        }),
    )
    const executor = createX402OutgoingExecutor({
      rpc: fixture.rpc,
      rpcUrl: 'https://rpc.example.test',
      network: X402_SOLANA_DEVNET_NETWORK,
      routeNetwork: 'devnet',
      settlementMint: testMint,
      providerDestination: fixture.recipient.address,
      signFeePayer: true,
      platformFeePayerIdentity: fixture.recipient.address,
      resourceUrl,
      maxPaymentAtomic: 100_000n,
      fetchImpl,
      getPayerPublicKey: async () => fixture.payer.address,
      getDenomination: async () => null,
      getSettlementAsset: async () => null,
      getEconomicMapping: async () => null,
      getSettlementRoute: async () => null,
      getActiveKeyVersion: async () => null,
      signPaymentEffect: async () => fixture.fullySigned,
    })

    const result = await executor.submit({
      prepared: fixture.prepared,
      signed: fixture.fullySigned,
    })

    expect(result.status).toBe('UNKNOWN')
    expect(result.externalId).toBeUndefined()
    expect(result.evidenceMetadataJson).toContain('SETTLEMENT_TRANSFER_COUNT_MISMATCH')
  })
})

async function createFixture(
  input: {
    readonly x402Network: Network
    readonly routeNetwork: string
    readonly mint: string
    readonly useMismatchedWire?: boolean
    readonly extraUncheckedSettlementTransfer?: boolean
  } = {
    x402Network: X402_SOLANA_MAINNET_NETWORK,
    routeNetwork: 'mainnet-beta',
    mint,
  },
): Promise<{
  readonly payer: Awaited<ReturnType<typeof generateKeyPairSigner>>
  readonly recipient: Awaited<ReturnType<typeof generateKeyPairSigner>>
  readonly rpc: SolanaRpc
  readonly prepared: V2PreparedEffect
  readonly signed: Awaited<ReturnType<typeof signSolanaX402PreparedEffect>>
  readonly fullySigned: Awaited<ReturnType<typeof signSolanaX402PreparedEffect>>
}> {
  const payer = await generateKeyPairSigner(true)
  const feePayer = await generateKeyPairSigner(true)
  const extraDestination = await generateKeyPairSigner(true)
  const [payerAta, recipientAta, extraDestinationAta] = await Promise.all([
    findAssociatedTokenPda({
      owner: payer.address,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      mint: input.mint as never,
    }),
    findAssociatedTokenPda({
      owner: feePayer.address,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      mint: input.mint as never,
    }),
    findAssociatedTokenPda({
      owner: extraDestination.address,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      mint: input.mint as never,
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
            mint: input.mint as never,
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
  const mismatchedMessage = pipe(
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
            mint: input.mint as never,
            destination: recipientAta[0],
            authority: createNoopSigner(payer.address),
            amount: 999n,
            decimals: 6,
          }),
        ],
        value,
      ),
  )
  const mismatchedTransactionBase64 = getBase64EncodedWireTransaction(
    compileTransaction(mismatchedMessage),
  )
  const payloadHash = hashMessage(transactionBase64)
  const requirementHash = hashRequirement({
    scheme: 'exact',
    network: input.x402Network,
    amount: '1000',
    asset: input.mint,
    payTo: feePayer.address,
    maxTimeoutSeconds: 300,
    extra: { feePayer: feePayer.address },
  })
  const preparedPayload: SolanaX402PreparedPayload = {
    version: 1,
    protocol: X402_PROTOCOL,
    payerOwner: payer.address,
    recipientOwner: feePayer.address,
    payerAta: payerAta[0],
    recipientAta: recipientAta[0],
    settlementMint: input.mint,
    tokenAmount: '1000',
    feePayerIdentity: feePayer.address,
    transactionBase64,
    payloadHash,
    requirementHash,
    paymentPayloadJson: JSON.stringify({
      x402Version: 2,
      resource: { url: resourceUrl },
      accepted: {
        scheme: 'exact',
        network: input.x402Network,
        amount: '1000',
        asset: input.mint,
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
      network: input.routeNetwork,
      assetReference: input.mint,
      destination: feePayer.address,
      amountAtomic: 1000n,
      feePayerIdentity: feePayer.address,
      preparedPayload: JSON.stringify(preparedPayload),
    },
    payerSecret: secret,
  })
  const feePayerSecret = await exportSecret(feePayer)
  const fullySigned = await signSolanaX402PreparedEffect({
    request: {
      effectHash: 'a'.repeat(64),
      keyVersion: 1,
      network: input.routeNetwork,
      assetReference: input.mint,
      destination: feePayer.address,
      amountAtomic: 1000n,
      feePayerIdentity: feePayer.address,
      preparedPayload: JSON.stringify(preparedPayload),
    },
    payerSecret: secret,
    feePayerSecret,
  })
  feePayerSecret.fill(0)
  secret.fill(0)
  const prepared: V2PreparedEffect = {
    accountId: 'acct_1',
    paymentId: 'pay_1',
    attemptId: 'att_1',
    effectHash: signed.effectHash,
    network: input.routeNetwork,
    assetReference: input.mint,
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
    recipient: feePayer,
    rpc: {
      getSignatureStatuses: () => ({
        send: async () => ({
          value: [{ err: null, confirmationStatus: 'confirmed' }],
        }),
      }),
      getTransaction: (
        _transactionId: string,
        config: Readonly<Record<string, unknown>>,
      ) => ({
        send: async () =>
          config.encoding === 'base64'
            ? {
                transaction: [
                  input.useMismatchedWire
                    ? mismatchedTransactionBase64
                    : Buffer.from(fullySigned.signedPayload).toString('base64'),
                  'base64',
                ] as const,
              }
            : {
                meta: {
                  err: null,
                  preTokenBalances: [
                    {
                      accountIndex: 2,
                      mint: input.mint,
                      owner: payer.address,
                      uiTokenAmount: { amount: '1000000' },
                    },
                    {
                      accountIndex: 3,
                      mint: input.mint,
                      owner: feePayer.address,
                      uiTokenAmount: { amount: '0' },
                    },
                  ],
                  postTokenBalances: [
                    {
                      accountIndex: 2,
                      mint: input.mint,
                      owner: payer.address,
                      uiTokenAmount: { amount: '999000' },
                    },
                    {
                      accountIndex: 3,
                      mint: input.mint,
                      owner: feePayer.address,
                      uiTokenAmount: { amount: '1000' },
                    },
                  ],
                  innerInstructions: [],
                },
                transaction: {
                  message: {
                    accountKeys: [
                      { pubkey: feePayer.address, signer: true },
                      { pubkey: payer.address, signer: true },
                      payerAta[0],
                      recipientAta[0],
                      ...(input.extraUncheckedSettlementTransfer
                        ? [extraDestinationAta[0]]
                        : []),
                    ],
                    instructions: [
                      {
                        program: 'spl-token',
                        programId: TOKEN_PROGRAM_ADDRESS,
                        parsed: {
                          type: 'transferChecked',
                          info: {
                            source: payerAta[0],
                            destination: recipientAta[0],
                            authority: payer.address,
                            mint: input.mint,
                            tokenAmount: { amount: '1000' },
                          },
                        },
                      },
                      ...(input.extraUncheckedSettlementTransfer
                        ? [
                            {
                              program: 'spl-token',
                              programId: TOKEN_PROGRAM_ADDRESS,
                              parsed: {
                                type: 'transfer',
                                info: {
                                  source: payerAta[0],
                                  destination: extraDestinationAta[0],
                                  authority: payer.address,
                                  amount: '1',
                                },
                              },
                            },
                          ]
                        : []),
                    ],
                  },
                },
              },
      }),
    } as unknown as SolanaRpc,
    prepared,
    signed,
    fullySigned,
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
