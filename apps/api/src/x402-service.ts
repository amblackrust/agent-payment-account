import { createHash } from 'node:crypto'
import {
  convertFromSettlementAtomicUnits,
  createDenomination,
  createEconomicMapping,
  createSettlementAsset,
  DependencyUnavailableError,
  IdempotencyConflictError,
  ExternalRailError,
} from '@agent-payment/core'
import type {
  AuthenticatedAccount,
  V2DatabaseRepository,
  V2PaymentView,
} from '@agent-payment/db'
import type { V2PaymentService } from './payments-v2.js'
import {
  assertCompatibleX402SolanaAdapterConfig,
  parsePaymentRequiredResponse,
  parseX402Metadata,
  resolveX402SolanaAdapterConfig,
  X402_ABSOLUTE_MAX_PAYMENT_ATOMIC,
  X402_PROTOCOL,
  type X402SolanaAdapterConfig,
} from './x402-protocol.js'

const SOLANA_SPL_RAIL = 'SOLANA_SPL'
const DEFAULT_HTTP_TIMEOUT_MS = 15_000

export interface X402PaymentServiceOptions {
  readonly paymentService: V2PaymentService
  readonly repository: Pick<
    V2DatabaseRepository,
    | 'findV2Idempotency'
    | 'findPaymentView'
    | 'findDenomination'
    | 'listActiveSettlementRoutes'
    | 'findSettlementAsset'
    | 'findEconomicMapping'
  >
  readonly resourceUrl: string
  readonly settlementMint?: string
  readonly network?: string
  readonly routeNetwork?: string
  readonly providerDestination?: string
  readonly maxPaymentAtomic: bigint
  readonly httpTimeoutMs?: number
  readonly fetchImpl?: typeof fetch
}

export interface X402PaymentRequest {
  readonly denominationId: string
}

export class X402PaymentService {
  private readonly httpTimeoutMs: number
  private readonly fetchImpl: typeof fetch
  private readonly adapterConfig: X402SolanaAdapterConfig

  public constructor(private readonly options: X402PaymentServiceOptions) {
    this.adapterConfig = resolveX402SolanaAdapterConfig(options)
    this.httpTimeoutMs = options.httpTimeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS
    if (!Number.isInteger(this.httpTimeoutMs) || this.httpTimeoutMs <= 0) {
      throw new Error('x402 HTTP timeout must be a positive integer')
    }
    if (options.maxPaymentAtomic <= 0n) {
      throw new Error('x402 maximum payment must be positive')
    }
    if (options.maxPaymentAtomic > X402_ABSOLUTE_MAX_PAYMENT_ATOMIC) {
      throw new Error('x402 maximum payment exceeds the absolute safety cap')
    }
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  public async createPayment(
    account: AuthenticatedAccount,
    input: X402PaymentRequest,
    idempotencyKey: string,
    requestId: string,
    correlationId?: string,
  ): Promise<{ readonly view: V2PaymentView; readonly created: boolean }> {
    assertCompatibleX402SolanaAdapterConfig(this.adapterConfig)
    const existing = await this.options.repository.findV2Idempotency(
      account.account.id,
      idempotencyKey,
    )
    if (existing !== null) {
      const existingView = await this.options.repository.findPaymentView(
        account.account.id,
        existing.resourceId,
      )
      if (existingView === null) {
        throw new DependencyUnavailableError(
          'x402 idempotency record points to an unreadable payment',
        )
      }
      if (
        existingView.payment.denominationId !== input.denominationId ||
        !isMatchingX402Metadata(
          existingView.payment.metadataJson,
          this.options.resourceUrl,
        )
      ) {
        throw new IdempotencyConflictError()
      }
      return { view: existingView, created: false }
    }

    const discoveryResponse = await this.fetchResource()
    const snapshot = parsePaymentRequiredResponse(
      discoveryResponse,
      this.options.resourceUrl,
      this.adapterConfig.settlementMint,
      this.adapterConfig.network,
      this.adapterConfig.providerDestination,
    )
    const tokenAmount = BigInt(snapshot.requirement.amount)
    if (tokenAmount > this.options.maxPaymentAtomic) {
      throw new ExternalRailError(
        'x402 payment exceeds the configured absolute spend cap',
        undefined,
        'DETERMINISTIC',
      )
    }
    const denominationRecord = await this.options.repository.findDenomination(
      input.denominationId,
    )
    if (denominationRecord === null || denominationRecord.status !== 'ACTIVE') {
      throw new DependencyUnavailableError('x402 denomination is unavailable')
    }
    const denomination = createDenomination({
      id: denominationRecord.id,
      symbol: denominationRecord.symbol,
      maxScale: denominationRecord.maxScale,
      status: 'ACTIVE',
      version: denominationRecord.version,
    })
    const route = await this.findCompatibleRoute(denomination.id)
    const asset = createSettlementAsset({
      id: route.asset.id,
      rail: route.asset.rail,
      network: route.asset.network,
      assetReference: route.asset.assetReference,
      decimals: route.asset.decimals,
      status: 'ACTIVE',
      version: route.asset.version,
    })
    const mapping = createEconomicMapping({
      id: route.mapping.id,
      denominationId: route.mapping.denominationId,
      settlementAssetId: route.mapping.settlementAssetId,
      numerator: route.mapping.numerator,
      denominator: route.mapping.denominator,
      status: 'ACTIVE',
      version: route.mapping.version,
    })
    const logicalAmount = convertFromSettlementAtomicUnits(
      tokenAmount,
      mapping,
      denomination,
      asset,
    )
    const metadata = {
      protocol: X402_PROTOCOL,
      resource_url: this.options.resourceUrl,
      method: 'GET',
    } as const
    return this.options.paymentService.createPayment(
      account,
      {
        kind: 'PAY',
        recipientId: null,
        amount: logicalAmount.amount,
        denominationId: denomination.id,
        routePreference: route.id,
        metadata,
        target: {
          recipientId: null,
          displayName: 'x402 paid resource',
          managedAccountId: null,
          destination: {
            id: `x402_destination_${sha256(snapshot.requirement.payTo).slice(0, 32)}`,
            rail: SOLANA_SPL_RAIL,
            type: SOLANA_SPL_RAIL,
            walletAddress: snapshot.requirement.payTo,
          },
        },
      },
      idempotencyKey,
      requestId,
      correlationId,
    )
  }

  private async findCompatibleRoute(denominationId: string): Promise<{
    readonly id: string
    readonly asset: NonNullable<
      Awaited<ReturnType<V2DatabaseRepository['findSettlementAsset']>>
    >
    readonly mapping: NonNullable<
      Awaited<ReturnType<V2DatabaseRepository['findEconomicMapping']>>
    >
    readonly priority: number
  }> {
    const routes = await this.options.repository.listActiveSettlementRoutes()
    const candidates = await Promise.all(
      routes
        .filter(
          (route) =>
            route.status === 'ACTIVE' &&
            route.rail === SOLANA_SPL_RAIL &&
            route.network === this.adapterConfig.routeNetwork,
        )
        .map(async (route) => {
          const [asset, mapping] = await Promise.all([
            this.options.repository.findSettlementAsset(route.settlementAssetId),
            this.options.repository.findEconomicMapping(route.economicMappingId),
          ])
          if (
            asset === null ||
            mapping === null ||
            asset.status !== 'ACTIVE' ||
            asset.rail !== SOLANA_SPL_RAIL ||
            asset.network !== this.adapterConfig.routeNetwork ||
            asset.assetReference !== this.adapterConfig.settlementMint ||
            mapping.status !== 'ACTIVE' ||
            mapping.denominationId !== denominationId ||
            mapping.settlementAssetId !== asset.id
          ) {
            return undefined
          }
          return { id: route.id, asset, mapping, priority: route.priority }
        }),
    )
    const route = candidates
      .filter(
        (candidate): candidate is NonNullable<typeof candidate> =>
          candidate !== undefined,
      )
      .sort(
        (left, right) =>
          left.priority - right.priority || left.id.localeCompare(right.id),
      )[0]
    if (route === undefined) {
      throw new DependencyUnavailableError(
        'No active x402 Solana route matches the configured network and settlement asset',
      )
    }
    return route
  }

  private async fetchResource(): Promise<Response> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.httpTimeoutMs)
    try {
      return await this.fetchImpl(this.options.resourceUrl, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: controller.signal,
        redirect: 'error',
      })
    } catch (error) {
      throw new ExternalRailError('x402 discovery request failed', error, 'RETRYABLE')
    } finally {
      clearTimeout(timeout)
    }
  }
}

function isMatchingX402Metadata(
  value: string | undefined,
  resourceUrl: string,
): boolean {
  try {
    return parseX402Metadata(value).resourceUrl === resourceUrl
  } catch {
    return false
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}
