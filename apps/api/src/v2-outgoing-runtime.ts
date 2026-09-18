import { DependencyUnavailableError } from '@agent-payment/core'
import type { createDatabaseClient } from '@agent-payment/db'
import {
  createSolanaV2OutgoingExecutor,
  signSolanaV2PreparedEffect,
} from '@agent-payment/solana-rail'
import { createSolanaRpc, type ClusterUrl } from '@solana/kit'
import { ConfigurationError, getRuntimeLimits, type AppConfig } from './config.js'
import { DurableCapacityController } from './capacity.js'
import { ConstrainedCustodyBoundary } from './custody.js'
import type { ConstrainedCustodyBackend, WalletSecretCipher } from './custody.js'
import { V2OutgoingWorker } from './outgoing-v2.js'

const SPONSORSHIP_MAX_LAMPORTS_PER_DAY = 10_000_000n
const SPONSORSHIP_MAX_TRANSACTIONS_PER_HOUR = 60

export function createV2OutgoingWorker(input: {
  readonly config: AppConfig
  readonly database: ReturnType<typeof createDatabaseClient>
  readonly walletCipher?: WalletSecretCipher
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
  const executor = createSolanaV2OutgoingExecutor({
    rpc: createSolanaRpc(input.config.solanaRpcUrl as ClusterUrl),
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
    executor,
    serviceIdentity: custodyIdentity,
    capacity,
    mode: input.config.runtimeRole === 'reconcile' ? 'reconcile' : 'outgoing',
    batchSize: limits.workerBatchSize,
    leaseSeconds: limits.workerLeaseSeconds,
    owner: `outgoing-v2-${process.pid}`,
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
