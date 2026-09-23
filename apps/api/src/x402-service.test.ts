import { describe, expect, it, vi } from 'vitest'
import { encodePaymentRequiredHeader } from '@x402/core/http'
import type { Network, PaymentRequired } from '@x402/core/types'
import type {
  AuthenticatedAccount,
  V2DatabaseRepository,
  V2PaymentView,
} from '@agent-payment/db'
import type { V2PaymentService } from './payments-v2.js'
import { X402PaymentService } from './x402-service.js'
import {
  X402_PROTOCOL,
  X402_RESOURCE_URL,
  X402_SOLANA_DEVNET_NETWORK,
  X402_SOLANA_MAINNET_NETWORK,
} from './x402-protocol.js'

const asset = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const testMint = 'So11111111111111111111111111111111111111112'
const payTo = 'Gzehfseq1k9AcHFSoV7qHmDGQx92nLMw78XXdqVWQQWa'
const feePayer = 'Hc3sdEAsCGQcpgfivywog9uwtk8gUBUZgsxdME1EJy88'

function paymentRequired(
  input: {
    readonly network?: Network
    readonly asset?: string
    readonly payTo?: string
    readonly feePayer?: string
  } = {},
): PaymentRequired {
  return {
    x402Version: 2,
    resource: { url: X402_RESOURCE_URL },
    accepts: [
      {
        scheme: 'exact',
        network: input.network ?? X402_SOLANA_MAINNET_NETWORK,
        amount: '1000',
        asset: input.asset ?? asset,
        payTo: input.payTo ?? payTo,
        maxTimeoutSeconds: 300,
        extra: { feePayer: input.feePayer ?? feePayer },
      },
    ],
  }
}

function account(): AuthenticatedAccount {
  return {
    account: {
      id: 'acct_1',
      name: 'test',
      status: 'ACTIVE',
      solanaPublicKey: '11111111111111111111111111111111',
    },
    credential: {
      id: 'cred_1',
      accountId: 'acct_1',
      keyHash: 'hash',
      keyPrefix: 'prefix',
      revokedAt: null,
      lastUsedAt: null,
    },
  }
}

function view(metadataJson: string): V2PaymentView {
  return {
    payment: {
      id: 'pay_1',
      payerAccountId: 'acct_1',
      correlationId: null,
      recipientId: null,
      recipientManagedAccountId: null,
      kind: 'PAY',
      description: null,
      externalReference: null,
      metadataJson,
      amountAtomic: 1000n,
      amountScale: 6,
      denominationId: 'denom_usdc',
      currency: 'USD',
      status: 'ROUTING',
      routeId: 'route_mainnet',
      routeSelectionReason: 'EXPLICIT_PREFERENCE',
      settlementAssetId: 'asset_usdc',
      economicMappingId: 'mapping_usdc',
      destinationSnapshotJson: JSON.stringify({
        rail: 'SOLANA_SPL',
        network: 'mainnet-beta',
        asset_reference: asset,
        wallet_address: payTo,
      }),
      policyDecisionId: 'pdec_1',
      approvalId: null,
      executionState: 'QUEUED',
      settlementState: 'NOT_SUBMITTED',
      outcomeState: 'NONE',
      rowVersion: 1,
      originalPaymentId: null,
      confirmedAt: null,
      failedAt: null,
      failureCode: null,
      failureMessageSafe: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    policyDecision: 'ALLOW',
    reasonCodes: [],
    approvalState: 'NOT_REQUIRED',
    reservationStatus: 'HELD',
    attempts: [],
  }
}

function harness(
  input: {
    readonly network?: Network
    readonly routeNetwork?: string
    readonly settlementMint?: string
    readonly providerDestination?: string
  } = {},
) {
  const network = input.network ?? X402_SOLANA_MAINNET_NETWORK
  const routeNetwork = input.routeNetwork ?? 'mainnet-beta'
  const settlementMint = input.settlementMint ?? asset
  const providerDestination = input.providerDestination ?? payTo
  const fetchImpl = vi.fn(
    async () =>
      new Response(null, {
        status: 402,
        headers: {
          'PAYMENT-REQUIRED': encodePaymentRequiredHeader(
            paymentRequired({
              network,
              asset: settlementMint,
              payTo: providerDestination,
            }),
          ),
        },
      }),
  )
  const created = view(
    JSON.stringify({
      protocol: X402_PROTOCOL,
      resource_url: X402_RESOURCE_URL,
      method: 'GET',
    }),
  )
  const paymentService = {
    createPayment: vi.fn(async () => ({ view: created, created: true })),
  } as unknown as V2PaymentService
  const findV2Idempotency = vi.fn(
    async (): Promise<Awaited<ReturnType<V2DatabaseRepository['findV2Idempotency']>>> =>
      null,
  )
  const repository = {
    findV2Idempotency,
    findPaymentView: vi.fn(async () => created),
    findDenomination: vi.fn(async () => ({
      id: 'denom_usdc',
      symbol: 'USD',
      maxScale: 6,
      status: 'ACTIVE' as const,
      version: 1,
    })),
    listActiveSettlementRoutes: vi.fn(async () => [
      {
        id: 'route_mainnet',
        rail: 'SOLANA_SPL',
        railVersion: 'v2',
        network: routeNetwork,
        settlementAssetId: 'asset_usdc',
        economicMappingId: 'mapping_usdc',
        status: 'ACTIVE' as const,
        priority: 1,
        configVersion: '1',
      },
    ]),
    findSettlementAsset: vi.fn(async () => ({
      id: 'asset_usdc',
      rail: 'SOLANA_SPL',
      network: routeNetwork,
      assetReference: settlementMint,
      decimals: 6,
      status: 'ACTIVE' as const,
      version: 1,
    })),
    findEconomicMapping: vi.fn(async () => ({
      id: 'mapping_usdc',
      denominationId: 'denom_usdc',
      settlementAssetId: 'asset_usdc',
      numerator: 1n,
      denominator: 1n,
      status: 'ACTIVE' as const,
      version: 1,
    })),
  }
  return {
    fetchImpl,
    paymentService,
    repository,
    service: new X402PaymentService({
      paymentService,
      repository,
      resourceUrl: X402_RESOURCE_URL,
      settlementMint,
      network,
      routeNetwork,
      providerDestination,
      maxPaymentAtomic: 100_000n,
      fetchImpl,
    }),
    created,
  }
}

describe('x402 payment service', () => {
  it('turns the live atomic requirement into an ordinary V2 payment intent', async () => {
    const harnessValue = harness()
    await harnessValue.service.createPayment(
      account(),
      { denominationId: 'denom_usdc' },
      'x402-key-1',
      'req_1',
    )
    expect(harnessValue.paymentService.createPayment).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        amount: '0.001',
        routePreference: 'route_mainnet',
        metadata: {
          protocol: X402_PROTOCOL,
          resource_url: X402_RESOURCE_URL,
          method: 'GET',
        },
      }),
      'x402-key-1',
      'req_1',
      undefined,
    )
    expect(harnessValue.fetchImpl).toHaveBeenCalledWith(
      X402_RESOURCE_URL,
      expect.objectContaining({ redirect: 'error' }),
    )
  })

  it('replays an existing x402 idempotency resource without rediscovery or a second payment', async () => {
    const harnessValue = harness()
    harnessValue.repository.findV2Idempotency
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        requestHash: 'hash',
        fingerprint: 'hash',
        resourceId: 'pay_1',
      })
    await harnessValue.service.createPayment(
      account(),
      { denominationId: 'denom_usdc' },
      'x402-key-1',
      'req_1',
    )
    const replay = await harnessValue.service.createPayment(
      account(),
      { denominationId: 'denom_usdc' },
      'x402-key-1',
      'req_2',
    )
    expect(replay.created).toBe(false)
    expect(harnessValue.fetchImpl).toHaveBeenCalledTimes(1)
    expect(harnessValue.paymentService.createPayment).toHaveBeenCalledTimes(1)
  })

  it('uses an explicit devnet network, test mint, route and provider destination', async () => {
    const harnessValue = harness({
      network: X402_SOLANA_DEVNET_NETWORK,
      routeNetwork: 'devnet',
      settlementMint: testMint,
      providerDestination: payTo,
    })
    await harnessValue.service.createPayment(
      account(),
      { denominationId: 'denom_usdc' },
      'x402-devnet-key-1',
      'req-devnet-1',
    )
    expect(harnessValue.paymentService.createPayment).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        amount: '0.001',
        target: expect.objectContaining({
          destination: expect.objectContaining({ walletAddress: payTo }),
        }),
      }),
      'x402-devnet-key-1',
      'req-devnet-1',
      undefined,
    )
  })
})
