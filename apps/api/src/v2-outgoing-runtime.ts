import { randomUUID } from 'node:crypto'
import { DependencyUnavailableError } from '@agent-payment/core'
import type {
  V2PaymentAttemptSnapshot,
  V2PaymentView,
  createDatabaseClient,
} from '@agent-payment/db'
import {
  createSolanaV2OutgoingExecutor,
  parseSolanaX402PreparedPayload,
  signSolanaV2PreparedEffect,
  signSolanaX402PreparedEffect,
} from '@agent-payment/solana-rail'
import { createSolanaRpc, type ClusterUrl } from '@solana/kit'
import {
  ConfigurationError,
  DEFAULT_X402_HTTP_TIMEOUT_MS,
  DEFAULT_X402_MAX_PAYMENT_ATOMIC,
  DEFAULT_X402_RESOURCE_URL,
  getRuntimeLimits,
  type AppConfig,
} from './config.js'
import { DurableCapacityController } from './capacity.js'
import { ConstrainedCustodyBoundary } from './custody.js'
import type { ConstrainedCustodyBackend, WalletSecretCipher } from './custody.js'
import { V2OutgoingWorker } from './outgoing-v2.js'
import type { MetricsRegistry } from './observability.js'
import type { V2OutgoingExecutor } from './outgoing-v2.js'
import { createX402OutgoingExecutor } from './x402-executor.js'
import { isX402PaymentMetadata, x402NetworkForSolanaCluster } from './x402-protocol.js'

const SPONSORSHIP_MAX_LAMPORTS_PER_DAY = 10_000_000n
const SPONSORSHIP_MAX_TRANSACTIONS_PER_HOUR = 60

export function createV2OutgoingWorker(input: {
  readonly config: AppConfig
  readonly database: ReturnType<typeof createDatabaseClient>
  readonly walletCipher?: WalletSecretCipher
  readonly metrics?: MetricsRegistry
}): {
  readonly worker: V2OutgoingWorker
  readonly checkReadiness: () => Promise<void>
} {
  const feePayerSecret = input.config.solanaFeePayerSecret
  const reconcileOnly = input.config.runtimeRole === 'reconcile'
  if (feePayerSecret === undefined && !reconcileOnly) {
    throw new ConfigurationError(
      'SOLANA_FEE_PAYER_SECRET is required for the V2 outgoing worker',
    )
  }
  if (!reconcileOnly && input.walletCipher === undefined) {
    throw new ConfigurationError(
      'Outgoing runtime requires wallet custody encryption material',
    )
  }
  const custodyMode = input.config.custodyBackendMode ?? 'LOCAL_TEST'
  if (custodyMode !== 'LOCAL_TEST' && !reconcileOnly) {
    throw new DependencyUnavailableError(
      'The selected external custody backend has no provider adapter configured for Solana V2',
    )
  }
  const custodyIdentity =
    input.config.custodyBackendIdentity ??
    (reconcileOnly ? 'reconcile-read-only' : 'local-test-custody')
  const custodyBoundary = reconcileOnly
    ? undefined
    : new ConstrainedCustodyBoundary(
        {
          identity: custodyIdentity,
          mode: custodyMode,
          signPaymentEffect: async (request) => {
            const custody = await input.database.findAccountCustody(request.accountId)
            if (custody === null) {
              throw new DependencyUnavailableError(
                'Payer account custody is unavailable',
              )
            }
            const payerSecret = input.walletCipher!.decrypt({
              ciphertext: custody.encryptedSolanaSecret,
              nonce: custody.encryptionNonce,
              authTag: custody.encryptionAuthTag,
            })
            try {
              const preparedPayload = request.preparedPayload
              if (
                preparedPayload !== undefined &&
                isX402PreparedPayload(preparedPayload)
              ) {
                if (
                  input.config.x402SignFeePayer === true &&
                  feePayerSecret === undefined
                ) {
                  throw new DependencyUnavailableError(
                    'Platform fee-payer custody is unavailable for devnet x402 execution',
                  )
                }
                return await signSolanaX402PreparedEffect({
                  request: {
                    effectHash: request.effectHash,
                    keyVersion: request.keyVersion,
                    network: request.network,
                    assetReference: request.assetReference,
                    destination: request.destination,
                    amountAtomic: request.amountAtomic,
                    feePayerIdentity: request.feePayerIdentity,
                    preparedPayload,
                  },
                  payerSecret,
                  ...(input.config.x402SignFeePayer === true
                    ? { feePayerSecret: feePayerSecret! }
                    : {}),
                })
              }
              if (feePayerSecret === undefined) {
                throw new DependencyUnavailableError(
                  'Fee-payer custody is unavailable for outgoing execution',
                )
              }
              return await signSolanaV2PreparedEffect({
                request,
                payerSecret,
                feePayerSecret,
              })
            } finally {
              payerSecret.fill(0)
            }
          },
        } satisfies ConstrainedCustodyBackend,
        input.config.nodeEnv,
      )
  const rpc = createSolanaRpc(input.config.solanaRpcUrl as ClusterUrl)
  const x402Network = x402NetworkForSolanaCluster(input.config.solanaCluster)
  const standardExecutor = createSolanaV2OutgoingExecutor({
    rpc,
    settlementMint: input.config.solanaSettlementMint,
    ...(reconcileOnly || feePayerSecret === undefined ? {} : { feePayerSecret }),
    ...(input.config.solanaPlatformCostAssetId === undefined
      ? {}
      : { platformCostAssetId: input.config.solanaPlatformCostAssetId }),
    getPayerPublicKey: (accountId) => input.database.findAccountPublicKey(accountId),
    getDenomination: (denominationId) =>
      input.database.v2.findDenomination(denominationId),
    getSettlementAsset: (assetId) => input.database.v2.findSettlementAsset(assetId),
    getEconomicMapping: (mappingId) => input.database.v2.findEconomicMapping(mappingId),
    getSettlementRoute: (routeId) => input.database.v2.findSettlementRoute(routeId),
    getActiveKeyVersion: async (accountId) =>
      (await input.database.v2Admin.findActiveCustodyKeyVersion(accountId))
        ?.keyVersion ?? null,
    reserveSponsorship: (reservation) =>
      input.database.reserveFeeSponsorship({
        ...reservation,
        maxLamportsPerDay: SPONSORSHIP_MAX_LAMPORTS_PER_DAY,
        maxTransactionsPerHour: SPONSORSHIP_MAX_TRANSACTIONS_PER_HOUR,
      }),
    signPaymentEffect: async (request) => {
      if (custodyBoundary === undefined) {
        throw new DependencyUnavailableError(
          'Reconciliation runtime cannot sign payment effects',
        )
      }
      return custodyBoundary.signPaymentEffect(request)
    },
  })
  const x402Executor = createX402OutgoingExecutor({
    rpc,
    rpcUrl: input.config.solanaRpcUrl,
    settlementMint: input.config.solanaSettlementMint,
    ...(x402Network === undefined
      ? {}
      : {
          network: x402Network,
          routeNetwork: input.config.solanaCluster,
        }),
    signFeePayer: input.config.x402SignFeePayer === true,
    ...(input.config.solanaFeePayerIdentity === undefined
      ? {}
      : { platformFeePayerIdentity: input.config.solanaFeePayerIdentity }),
    resourceUrl: input.config.x402ResourceUrl ?? DEFAULT_X402_RESOURCE_URL,
    httpTimeoutMs: input.config.x402HttpTimeoutMs ?? DEFAULT_X402_HTTP_TIMEOUT_MS,
    maxPaymentAtomic:
      input.config.x402MaxPaymentAtomic ?? DEFAULT_X402_MAX_PAYMENT_ATOMIC,
    getPayerPublicKey: (accountId) => input.database.findAccountPublicKey(accountId),
    getDenomination: (denominationId) =>
      input.database.v2.findDenomination(denominationId),
    getSettlementAsset: (assetId) => input.database.v2.findSettlementAsset(assetId),
    getEconomicMapping: (mappingId) => input.database.v2.findEconomicMapping(mappingId),
    getSettlementRoute: (routeId) => input.database.v2.findSettlementRoute(routeId),
    getActiveKeyVersion: async (accountId) =>
      (await input.database.v2Admin.findActiveCustodyKeyVersion(accountId))
        ?.keyVersion ?? null,
    signPaymentEffect: async (request) => {
      if (custodyBoundary === undefined) {
        throw new DependencyUnavailableError(
          'Reconciliation runtime cannot sign payment effects',
        )
      }
      return custodyBoundary.signPaymentEffect(request)
    },
  })
  const executor: V2OutgoingExecutor & { checkReadiness(): Promise<void> } = {
    prepare: (input: { view: V2PaymentView; attempt: V2PaymentAttemptSnapshot }) =>
      isX402PaymentMetadata(input.view.payment.metadataJson)
        ? x402Executor.prepare(input)
        : standardExecutor.prepare(input),
    sign: (request: Parameters<typeof standardExecutor.sign>[0]) =>
      isX402PreparedPayload(request.preparedPayload)
        ? x402Executor.sign(request)
        : standardExecutor.sign(request),
    submit: (input: Parameters<typeof standardExecutor.submit>[0]) =>
      isX402PreparedPayload(input.prepared.preparedPayload)
        ? x402Executor.submit(input)
        : standardExecutor.submit(input),
    reconcile: (input: {
      readonly view: V2PaymentView
      readonly attempt: V2PaymentAttemptSnapshot
      readonly signedPayload?: Uint8Array
    }) =>
      isX402PreparedAttempt(input.attempt)
        ? x402Executor.reconcile!(input)
        : standardExecutor.reconcile(input),
    checkReadiness: async () => {
      await standardExecutor.checkReadiness()
      if (x402Network !== undefined) await x402Executor.checkReadiness()
    },
  }
  const findAccountSummary = input.database.findAccountSummary
  const limits = getRuntimeLimits(input.config)
  const capacity = new DurableCapacityController(input.database.v2Admin, limits)
  const worker = new V2OutgoingWorker({
    repository: input.database.v2,
    custody: input.database.v2Admin,
    platformCosts: input.database.v2Operations,
    ...(input.walletCipher === undefined
      ? {}
      : { signedPayloadCipher: input.walletCipher }),
    ...(input.metrics === undefined ? {} : { metrics: input.metrics }),
    executor,
    serviceIdentity: custodyIdentity,
    capacity,
    mode: input.config.runtimeRole === 'reconcile' ? 'reconcile' : 'outgoing',
    batchSize: limits.workerBatchSize,
    leaseSeconds: limits.workerLeaseSeconds,
    owner: `outgoing-v2-${process.pid}-${randomUUID()}`,
    accountStatusProvider: {
      getStatus: async (accountId) => {
        if (findAccountSummary === undefined) {
          throw new DependencyUnavailableError(
            'Account lifecycle provider is unavailable',
          )
        }
        const account = await findAccountSummary(accountId)
        if (account === null) {
          throw new DependencyUnavailableError('Payer account lifecycle is unavailable')
        }
        return account.status
      },
    },
  })
  const checkReadiness = async (): Promise<void> => {
    await executor.checkReadiness()
    if (!input.config.restoreGateRequired) return
    const environment = input.config.restoreGateEnvironment
    const verification =
      await input.database.v2Operations.findLatestBackupVerification()
    const gateStatus = await input.database.getRuntimeMetadata('money_worker_gate')
    if (
      environment === undefined ||
      verification === null ||
      verification.status !== 'VERIFIED' ||
      verification.verifiedAt === null ||
      verification.environment !== environment ||
      verification.custodyIdentity !== custodyIdentity ||
      gateStatus !== 'RESTORE_VERIFIED'
    ) {
      throw new DependencyUnavailableError(
        'Outgoing workers are blocked until restore verification and external reconciliation are complete',
      )
    }
  }
  return { worker, checkReadiness }
}

function isX402PreparedPayload(value: string | undefined): boolean {
  if (value === undefined) return false
  try {
    return parseSolanaX402PreparedPayload(value).protocol === 'x402-v2'
  } catch {
    return false
  }
}

function isX402PreparedAttempt(attempt: V2PaymentAttemptSnapshot): boolean {
  if (attempt.preparedEffectJson === undefined || attempt.preparedEffectJson === null) {
    return false
  }
  try {
    const parsed = JSON.parse(attempt.preparedEffectJson) as {
      preparedPayload?: unknown
    }
    return (
      typeof parsed.preparedPayload === 'string' &&
      isX402PreparedPayload(parsed.preparedPayload)
    )
  } catch {
    return false
  }
}
