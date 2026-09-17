import { DependencyUnavailableError } from '@agent-payment/core'
import { createDatabaseClient } from '@agent-payment/db'
import {
  createSolanaV2OutgoingExecutor,
  signSolanaV2PreparedEffect,
} from '@agent-payment/solana-rail'
import { createSolanaRpc, type ClusterUrl } from '@solana/kit'
import { ConfigurationError, type AppConfig } from './config.js'
import { ConstrainedCustodyBoundary, WalletSecretCipher } from './custody.js'
import type { ConstrainedCustodyBackend } from './custody.js'
import { V2OutgoingWorker } from './outgoing-v2.js'

const SPONSORSHIP_MAX_LAMPORTS_PER_DAY = 10_000_000n
const SPONSORSHIP_MAX_TRANSACTIONS_PER_HOUR = 60

export function createV2OutgoingWorker(input: {
  readonly config: AppConfig
  readonly database: ReturnType<typeof createDatabaseClient>
  readonly walletCipher: WalletSecretCipher
}): {
  readonly worker: V2OutgoingWorker
  readonly checkReadiness: () => Promise<void>
} {
  const feePayerSecret = input.config.solanaFeePayerSecret
  if (feePayerSecret === undefined) {
    throw new ConfigurationError(
      'SOLANA_FEE_PAYER_SECRET is required for the V2 outgoing worker',
    )
  }
  const custodyMode = input.config.custodyBackendMode ?? 'LOCAL_TEST'
  if (custodyMode !== 'LOCAL_TEST') {
    throw new DependencyUnavailableError(
      'The selected external custody backend has no provider adapter configured for Solana V2',
    )
  }
  const custodyIdentity = input.config.custodyBackendIdentity ?? 'local-test-custody'
  const backend: ConstrainedCustodyBackend = {
    identity: custodyIdentity,
    mode: custodyMode,
    signPaymentEffect: async (request) => {
      const custody = await input.database.findAccountCustody(request.accountId)
      if (custody === null) {
        throw new DependencyUnavailableError('Payer account custody is unavailable')
      }
      const payerSecret = input.walletCipher.decrypt({
        ciphertext: custody.encryptedSolanaSecret,
        nonce: custody.encryptionNonce,
        authTag: custody.encryptionAuthTag,
      })
      try {
        return await signSolanaV2PreparedEffect({
          request,
          payerSecret,
          feePayerSecret,
        })
      } finally {
        payerSecret.fill(0)
      }
    },
  }
  const custodyBoundary = new ConstrainedCustodyBoundary(backend, input.config.nodeEnv)
  const executor = createSolanaV2OutgoingExecutor({
    rpc: createSolanaRpc(input.config.solanaRpcUrl as ClusterUrl),
    settlementMint: input.config.solanaSettlementMint,
    feePayerSecret,
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
    signPaymentEffect: (request) => custodyBoundary.signPaymentEffect(request),
  })
  const findAccountSummary = input.database.findAccountSummary
  const worker = new V2OutgoingWorker({
    repository: input.database.v2,
    custody: input.database.v2Admin,
    signedPayloadCipher: input.walletCipher,
    executor,
    serviceIdentity: custodyIdentity,
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
    const verification = await input.database.v2Operations.findLatestBackupVerification()
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
        'Outgoing workers are blocked until an isolated restore is verified for this runtime authority',
      )
    }
  }
  return { worker, checkReadiness }
}
