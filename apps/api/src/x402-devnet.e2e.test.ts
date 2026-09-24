import { createHash, randomBytes } from 'node:crypto'
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { readFileSync } from 'node:fs'
import type { Readable } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

import { createDatabaseClient } from '@agent-payment/db'
import type { SettlementRoute } from '@agent-payment/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { fingerprintWalletMasterKey } from './custody.js'

const enabled = process.env.DEVNET_X402_E2E === '1'
const repositoryRoot = path.resolve(
  fileURLToPath(new URL('../../../', import.meta.url)),
)
const databaseUrl =
  process.env.DEVNET_X402_DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim()
const apiPort = Number(process.env.DEVNET_X402_API_PORT ?? 3_842)
const fakePort = Number(process.env.DEVNET_X402_FAKE_PORT ?? 4_542)
const adminApiKey = `devnet-x402-admin-${randomBytes(16).toString('hex')}`
const runtimeWalletKey =
  process.env.DEVNET_X402_WALLET_MASTER_KEY?.trim() || randomBytes(32).toString('hex')
const recoveryEnvelopeKey =
  process.env.DEVNET_X402_RECOVERY_ENVELOPE_KEY?.trim() ||
  randomBytes(32).toString('hex')
const runId = randomBytes(8).toString('hex')
const accountName = `devnet-x402-${runId}`
const accountIdempotencyKey = `devnet-x402-account-${runId}`
const paymentIdempotencyKey = `devnet-x402-payment-${runId}`
const deniedPaymentIdempotencyKey = `devnet-x402-denied-${runId}`
const lowBalanceAccountIdempotencyKey = `devnet-x402-low-balance-account-${runId}`
const lowBalancePaymentIdempotencyKey = `devnet-x402-low-balance-payment-${runId}`
const lostResponsePaymentIdempotencyKey = `devnet-x402-lost-response-${runId}`
const delegatedCredentialIdempotencyKey = `devnet-x402-delegated-credential-${runId}`
const resourceUrl = `http://127.0.0.1:${fakePort}/api/crypto/price?ids=bitcoin`

const DENOMINATION_ID = 'devnet_x402_usd'
const SETTLEMENT_ASSET_ID = 'devnet_x402_test_usdc'
const ECONOMIC_MAPPING_ID = 'devnet_x402_usd_to_test_usdc'
const SETTLEMENT_ROUTE_ID = 'devnet_x402_solana_route'
const DEVNET_RPC_RATE_LIMIT_MAX_RETRIES = 5
const DEVNET_RPC_RATE_LIMIT_BASE_DELAY_MS = 1_000
const DEVNET_RPC_RATE_LIMIT_MAX_DELAY_MS = 15_000
const DEVNET_E2E_HOOK_TIMEOUT_MS = 480_000
const DEVNET_E2E_API_READINESS_TIMEOUT_MS = 120_000

interface HttpResult {
  readonly status: number
  readonly body: unknown
  readonly headers: Headers
}

interface RunningProcess {
  readonly child: ChildProcessByStdio<null, Readable, Readable>
  readonly diagnostics: () => string
}

interface E2EState {
  readonly database: ReturnType<typeof createDatabaseClient>
  readonly apiBaseUrl: string
  readonly fakeBaseUrl: string
  readonly adminApiKey: string
  readonly accountId: string
  readonly accountOwner: string
  readonly apiKey: string
  readonly providerDestination: string
  readonly settlementMint: string
  readonly platformFeePayer: string
  readonly apiProcess: RunningProcess
  readonly fakeProcess: RunningProcess
}

interface DevnetX402Tools {
  readonly DEVNET_X402_RPC_URL: string
  readonly setupDevnetX402: (options: {
    readonly homeDirectory: string
    readonly rpcUrl: string
    readonly agentAddress?: string
    readonly tokenTargetAtomic: bigint
    readonly solTargetLamports: bigint
  }) => Promise<{
    readonly platformFeePayer: { readonly address: string }
    readonly fakeService: {
      readonly destination: string
      readonly tokenAccount: string
    }
    readonly settlementAsset: { readonly mint: string }
    readonly agentAccount?: { readonly tokenAccount?: string }
  }>
  readonly resolveDevnetX402Paths: (homeDirectory: string) => {
    readonly home: string
    readonly platformFeePayer: string
  }
}

let state: E2EState | undefined

describe.skipIf(!enabled)('V2 fake x402 Solana devnet E2E', () => {
  beforeAll(async () => {
    if (databaseUrl === undefined || databaseUrl.length === 0) {
      throw new Error(
        'DEVNET_X402_E2E=1 requires DEVNET_X402_DATABASE_URL or DATABASE_URL',
      )
    }
    assertPort(apiPort, 'DEVNET_X402_API_PORT')
    assertPort(fakePort, 'DEVNET_X402_FAKE_PORT')
    if (apiPort === fakePort) {
      throw new Error('DEVNET_X402_API_PORT and DEVNET_X402_FAKE_PORT must differ')
    }

    const devnetTools = (await import(
      pathToFileURL(path.join(repositoryRoot, 'scripts', 'devnet-x402.mjs')).href
    )) as unknown as DevnetX402Tools
    const devnetRpcUrl = devnetTools.DEVNET_X402_RPC_URL

    const setup = await devnetTools.setupDevnetX402({
      homeDirectory: path.join(repositoryRoot, '.local', 'devnet-x402'),
      rpcUrl: devnetRpcUrl,
      tokenTargetAtomic: 10_000_000n,
      solTargetLamports: 100_000_000n,
    })
    const paths = devnetTools.resolveDevnetX402Paths(
      path.join(repositoryRoot, '.local', 'devnet-x402'),
    )
    const platformFeePayerSecret = readFileSync(paths.platformFeePayer, 'utf8').trim()

    await seedDevnetFinancialIdentity(databaseUrl, setup.settlementAsset.mint)
    const database = createDatabaseClient(databaseUrl)
    let apiProcess: RunningProcess | undefined
    let fakeProcess: RunningProcess | undefined
    try {
      apiProcess = startProcess(
        ['--filter', '@agent-payment/api', 'exec', 'tsx', 'src/server.ts'],
        {
          DATABASE_URL: databaseUrl,
          PORT: String(apiPort),
          NODE_ENV: 'test',
          ADMIN_API_KEY: adminApiKey,
          SOLANA_RPC_URL: devnetRpcUrl,
          SOLANA_CLUSTER: 'devnet',
          SOLANA_SETTLEMENT_MINT: setup.settlementAsset.mint,
          SOLANA_FEE_PAYER_SECRET: platformFeePayerSecret,
          SOLANA_FEE_PAYER_IDENTITY: setup.platformFeePayer.address,
          X402_RESOURCE_URL: resourceUrl,
          X402_MAX_PAYMENT_ATOMIC: '1000',
          X402_SIGN_FEE_PAYER: 'true',
          WALLET_MASTER_KEY: runtimeWalletKey,
          RECOVERY_ENVELOPE_KEY: recoveryEnvelopeKey,
          RUNTIME_ROLE: 'all',
          CUSTODY_BACKEND_IDENTITY: 'devnet-local-test-custody',
          CUSTODY_BACKEND_MODE: 'LOCAL_TEST',
          WORKER_INTERVAL_MS: '250',
          WORKER_LEASE_SECONDS: '30',
          ALLOW_MAINNET: 'false',
        },
      )
      await waitForHttp(
        `${apiBaseUrl()}/health/ready`,
        apiProcess,
        DEVNET_E2E_API_READINESS_TIMEOUT_MS,
      )

      const initialProvisioning = await requestJson(`${apiBaseUrl()}/v2/accounts`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-admin-api-key': adminApiKey,
          'idempotency-key': accountIdempotencyKey,
        },
        body: JSON.stringify({ name: accountName }),
      })

      const requestHash = createHash('sha256')
        .update(JSON.stringify({ name: accountName }), 'utf8')
        .digest('hex')
      const replay = await database.v2Admin.findProvisioningReplay({
        idempotencyKey: accountIdempotencyKey,
        requestHash,
      })

      let accountId: string
      let accountOwner: string
      let apiKey: string
      let accountCredentialId: string
      if (initialProvisioning.status === 201) {
        throw new Error(
          'Fresh devnet x402 account unexpectedly provisioned before its token account was created',
        )
      }
      if (replay === null) {
        throw new Error(
          `V2 account provisioning did not persist a replay record (HTTP ${initialProvisioning.status})`,
        )
      }
      accountId = replay.accountId
      const failedAccount = await database.v2Admin.findAccount(accountId)
      if (failedAccount === null || failedAccount.status !== 'PROVISIONING_FAILED') {
        throw new Error(
          'V2 account did not enter PROVISIONING_FAILED before funding setup',
        )
      }
      accountOwner = failedAccount.solanaPublicKey

      const funded = await devnetTools.setupDevnetX402({
        homeDirectory: path.join(repositoryRoot, '.local', 'devnet-x402'),
        rpcUrl: devnetRpcUrl,
        agentAddress: accountOwner,
        tokenTargetAtomic: 10_000_000n,
        solTargetLamports: 100_000_000n,
      })
      if (funded.agentAccount?.tokenAccount === undefined) {
        throw new Error(
          'Devnet setup did not produce the MUX Agent Account token account',
        )
      }

      const completedProvisioning = await requestJson(`${apiBaseUrl()}/v2/accounts`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-admin-api-key': adminApiKey,
          'idempotency-key': accountIdempotencyKey,
        },
        body: JSON.stringify({ name: accountName }),
      })
      expect(completedProvisioning.status).toBe(201)
      const accountResponse = asRecord(
        completedProvisioning.body,
        'completed account response',
      )
      apiKey = requireString(accountResponse.api_key, 'agent API key')
      accountCredentialId = requireString(
        accountResponse.credential_id,
        'initial credential id',
      )
      expect(requireString(accountResponse.id, 'completed account id')).toBe(accountId)
      expect(requireString(accountResponse.status, 'account status')).toBe('ACTIVE')

      await database.v2Admin.createCustodyKeyVersion({
        id: `custody_${accountId}_v1`,
        accountId,
        keyVersion: 1,
        backendIdentity: 'devnet-local-test-custody',
        keyReference: `agent:${accountId}:v1`,
        rootKeyFingerprint: fingerprintWalletMasterKey(runtimeWalletKey),
      })
      expect(
        await database.v2Admin.findActiveCustodyKeyVersion(accountId),
      ).toMatchObject({
        keyVersion: 1,
        backendIdentity: 'devnet-local-test-custody',
      })

      fakeProcess = startProcess(
        ['--filter', '@agent-payment/fake-x402', 'exec', 'tsx', 'server.ts'],
        {
          FAKE_X402_PORT: String(fakePort),
          FAKE_X402_RPC_URL: devnetRpcUrl,
          FAKE_X402_TEST_USDC_MINT: funded.settlementAsset.mint,
          FAKE_X402_DESTINATION: funded.fakeService.destination,
          FAKE_X402_FEE_PAYER: funded.platformFeePayer.address,
          FAKE_X402_RESOURCE_URL: resourceUrl,
        },
      )
      await waitForHttp(`${fakeBaseUrl()}/healthz`, fakeProcess, 30_000)

      const recipient = await requestJson(`${apiBaseUrl()}/v2/recipients`, {
        method: 'POST',
        headers: agentHeaders(apiKey),
        body: JSON.stringify({
          display_name: 'Local fake x402 service',
          type: 'SOLANA_SPL',
          destination: {
            type: 'SOLANA_SPL',
            wallet_address: funded.fakeService.destination,
          },
        }),
      })
      expect(recipient.status).toBe(201)

      const fingerprint = sha256(
        JSON.stringify({
          rail: 'SOLANA_SPL',
          network: 'devnet',
          assetReference: funded.settlementAsset.mint,
          destination: funded.fakeService.destination,
        }),
      )
      const approvedDestination = await requestJson(
        `${apiBaseUrl()}/v2/accounts/${accountId}/approved-destinations`,
        {
          method: 'POST',
          headers: adminHeaders(adminApiKey),
          body: JSON.stringify({
            fingerprint,
            rail: 'SOLANA_SPL',
            network: 'devnet',
            asset_reference: funded.settlementAsset.mint,
            destination: funded.fakeService.destination,
          }),
        },
      )
      expect(approvedDestination.status).toBe(201)

      const policy = await requestJson(
        `${apiBaseUrl()}/v2/accounts/${accountId}/policy`,
        {
          method: 'PUT',
          headers: adminHeaders(adminApiKey),
          body: JSON.stringify({
            denomination_id: DENOMINATION_ID,
            max_per_payment: '0.01',
            rolling_budget: '1',
            rolling_window_seconds: 3_600,
            transaction_count_cap: 10,
          }),
        },
      )
      expect(policy.status).toBe(200)
      const initialPolicy = asRecord(policy.body, 'policy')
      expect(requireString(initialPolicy.status, 'policy status')).toBe('ACTIVE')
      const initialPolicyVersion = requireInteger(
        initialPolicy.version,
        'initial policy version',
      )

      const fundingDestination = await requestJson(
        `${apiBaseUrl()}/v2/accounts/${accountId}/funding-destination`,
        { method: 'GET', headers: agentHeaders(apiKey) },
      )
      expect(fundingDestination.status).toBe(200)
      const fundingBody = asRecord(fundingDestination.body, 'funding destination')
      expect(fundingBody.readiness).toBe('READY')
      expect(fundingBody.network).toBe('devnet')
      expect(fundingBody.destination).toBe(funded.agentAccount?.tokenAccount)
      const agentTokenAccount = requireString(
        funded.agentAccount?.tokenAccount,
        'devnet Agent Account token account',
      )
      const providerTokenAccount = requireString(
        funded.fakeService.tokenAccount,
        'fake service token account',
      )
      const initialAgentTokenBalance = await readTokenAccountBalance(
        devnetRpcUrl,
        agentTokenAccount,
      )
      const initialProviderTokenBalance = await readTokenAccountBalance(
        devnetRpcUrl,
        providerTokenAccount,
      )

      const deniedPolicy = await requestJson(
        `${apiBaseUrl()}/v2/accounts/${accountId}/policy`,
        {
          method: 'PUT',
          headers: adminHeaders(adminApiKey),
          body: JSON.stringify({
            denomination_id: DENOMINATION_ID,
            max_per_payment: '0.0005',
            rolling_budget: '1',
            rolling_window_seconds: 3_600,
            transaction_count_cap: 10,
            version: initialPolicyVersion,
          }),
        },
      )
      expect(deniedPolicy.status).toBe(200)
      const deniedPolicyRecord = asRecord(deniedPolicy.body, 'denied policy')
      const deniedPolicyVersion = requireInteger(
        deniedPolicyRecord.version,
        'denied policy version',
      )
      const denied = await requestJson(`${apiBaseUrl()}/v2/external-payments/x402`, {
        method: 'POST',
        headers: {
          ...agentHeaders(apiKey),
          'idempotency-key': deniedPaymentIdempotencyKey,
        },
        body: JSON.stringify({ denomination_id: DENOMINATION_ID }),
      })
      expect(denied.status).toBe(403)
      const deniedBody = asRecord(denied.body, 'denied payment response')
      expect(deniedBody.code).toBe('POLICY_DENIED')
      const deniedPaymentId = requireString(deniedBody.payment_id, 'denied payment id')
      const deniedView = await database.v2.findPaymentView(accountId, deniedPaymentId)
      expect(deniedView?.payment.status).toBe('REJECTED_BY_POLICY')
      expect(deniedView?.policyDecision).toBe('DENY')
      expect(deniedView?.attempts).toHaveLength(0)
      expect(
        await database.v2.findV2Idempotency(accountId, deniedPaymentIdempotencyKey),
      ).not.toBeNull()

      const restoredPolicy = await requestJson(
        `${apiBaseUrl()}/v2/accounts/${accountId}/policy`,
        {
          method: 'PUT',
          headers: adminHeaders(adminApiKey),
          body: JSON.stringify({
            denomination_id: DENOMINATION_ID,
            max_per_payment: '0.01',
            rolling_budget: '1',
            rolling_window_seconds: 3_600,
            transaction_count_cap: 10,
            version: deniedPolicyVersion,
          }),
        },
      )
      expect(restoredPolicy.status).toBe(200)

      const discovery = await fetch(`${fakeBaseUrl()}/api/crypto/price?ids=bitcoin`)
      expect(discovery.status).toBe(402)
      expect(discovery.headers.get('payment-required')).toBeTruthy()

      const paymentRequest = await requestJson(
        `${apiBaseUrl()}/v2/external-payments/x402`,
        {
          method: 'POST',
          headers: {
            ...agentHeaders(apiKey),
            'idempotency-key': paymentIdempotencyKey,
          },
          body: JSON.stringify({ denomination_id: DENOMINATION_ID }),
        },
      )
      expect([200, 201]).toContain(paymentRequest.status)
      const createdPayment = asRecord(paymentRequest.body, 'created payment')
      const paymentId = requireString(createdPayment.id, 'payment id')

      let confirmedPayment: HttpResult | undefined
      try {
        await waitForCondition(
          async () => {
            const result = await requestJson(
              `${apiBaseUrl()}/v2/payments/${paymentId}`,
              {
                method: 'GET',
                headers: agentHeaders(apiKey),
              },
            )
            if (result.status !== 200) return false
            confirmedPayment = result
            return asRecord(result.body, 'payment poll').status === 'CONFIRMED'
          },
          120_000,
          'x402 payment confirmation',
        )
      } catch (error) {
        const diagnostics = [
          `API:\n${apiProcess?.diagnostics() ?? ''}`,
          `Fake x402:\n${fakeProcess?.diagnostics() ?? ''}`,
        ].join('\n')
        throw new Error(
          `${error instanceof Error ? error.message : 'x402 payment confirmation failed'}\nAPI diagnostics:\n${diagnostics}`,
          { cause: error },
        )
      }
      const confirmed = asRecord(confirmedPayment?.body, 'confirmed payment')
      expect(confirmed.status).toBe('CONFIRMED')
      expect(confirmed.policy_decision).toBe('ALLOW')
      expect(confirmed.reservation_status).toBe('CONSUMED')
      expect(confirmed.settlement_state).toBe('CONFIRMED')
      expect(confirmed.execution_state).toBe('TERMINAL')
      expect(confirmed.outcome_state).toBe('CONFIRMED')
      expect(confirmed.route_id).toBe(SETTLEMENT_ROUTE_ID)
      expect(confirmed.settlement_asset_id).toBe(SETTLEMENT_ASSET_ID)
      expect(await readTokenAccountBalance(devnetRpcUrl, agentTokenAccount)).toBe(
        initialAgentTokenBalance - 1_000n,
      )
      expect(await readTokenAccountBalance(devnetRpcUrl, providerTokenAccount)).toBe(
        initialProviderTokenBalance + 1_000n,
      )

      const view = await database.v2.findPaymentView(accountId, paymentId)
      if (view === null) throw new Error('Confirmed payment view is unavailable')
      expect(view.attempts).toHaveLength(1)
      const attempt = view.attempts[0]
      if (
        attempt === undefined ||
        attempt.externalId === undefined ||
        attempt.externalId === null
      ) {
        throw new Error('Confirmed payment has no durable external Solana signature')
      }
      const transactionSignature = attempt.externalId
      const signatureStatus = await readRpc(devnetRpcUrl, 'getSignatureStatuses', [
        [transactionSignature],
        { searchTransactionHistory: true },
      ])
      const signatureResponse = asRecord(signatureStatus, 'signature status response')
      if (!Array.isArray(signatureResponse.value)) {
        throw new Error('Solana signature status response value must be an array')
      }
      const signatureEntry = asRecord(signatureResponse.value[0], 'signature status')
      expect(signatureEntry.err).toBeNull()
      expect(['confirmed', 'finalized']).toContain(signatureEntry.confirmationStatus)

      const history = await requestJson(
        `${apiBaseUrl()}/v2/accounts/${accountId}/history`,
        {
          method: 'GET',
          headers: agentHeaders(apiKey),
        },
      )
      expect(history.status).toBe(200)
      const historyItems = asRecord(history.body, 'history').items
      expect(Array.isArray(historyItems)).toBe(true)
      expect(
        (historyItems as unknown[]).some(
          (item) =>
            asRecord(item, 'history item').id === paymentId &&
            asRecord(item, 'history item').status === 'CONFIRMED' &&
            asRecord(item, 'history item').external_id === transactionSignature,
        ),
      ).toBe(true)

      const timeline = await requestJson(`${apiBaseUrl()}/v2/timeline`, {
        method: 'GET',
        headers: agentHeaders(apiKey),
      })
      expect(timeline.status).toBe(200)
      const timelineItems = asRecord(timeline.body, 'timeline').items
      expect(Array.isArray(timelineItems)).toBe(true)
      expect(
        (timelineItems as unknown[]).some(
          (item) =>
            asRecord(item, 'timeline item').event_type === 'EVIDENCE_RECORDED' &&
            timelinePaymentId(asRecord(item, 'timeline item').new_state) === paymentId,
        ),
      ).toBe(true)

      const duplicate = await requestJson(`${apiBaseUrl()}/v2/external-payments/x402`, {
        method: 'POST',
        headers: {
          ...agentHeaders(apiKey),
          'idempotency-key': paymentIdempotencyKey,
        },
        body: JSON.stringify({ denomination_id: DENOMINATION_ID }),
      })
      expect(duplicate.status).toBe(200)
      expect(
        requireString(asRecord(duplicate.body, 'duplicate payment').id, 'payment id'),
      ).toBe(paymentId)
      const afterDuplicate = await database.v2.findPaymentView(accountId, paymentId)
      expect(afterDuplicate?.attempts).toHaveLength(1)

      const lowBalanceAccountName = `devnet-x402-low-balance-${runId}`
      const lowBalanceProvisioning = await requestJson(`${apiBaseUrl()}/v2/accounts`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-admin-api-key': adminApiKey,
          'idempotency-key': lowBalanceAccountIdempotencyKey,
        },
        body: JSON.stringify({ name: lowBalanceAccountName }),
      })
      expect(lowBalanceProvisioning.status).not.toBe(201)
      const lowBalanceRequestHash = sha256(
        JSON.stringify({ name: lowBalanceAccountName }),
      )
      const lowBalanceReplay = await database.v2Admin.findProvisioningReplay({
        idempotencyKey: lowBalanceAccountIdempotencyKey,
        requestHash: lowBalanceRequestHash,
      })
      if (lowBalanceReplay === null) {
        throw new Error(
          `Low-balance account provisioning did not persist a replay record (HTTP ${lowBalanceProvisioning.status})`,
        )
      }
      const lowBalanceAccount = await database.v2Admin.findAccount(
        lowBalanceReplay.accountId,
      )
      if (
        lowBalanceAccount === null ||
        lowBalanceAccount.status !== 'PROVISIONING_FAILED'
      ) {
        throw new Error('Low-balance account did not enter PROVISIONING_FAILED')
      }
      const lowBalanceSetup = await devnetTools.setupDevnetX402({
        homeDirectory: path.join(repositoryRoot, '.local', 'devnet-x402'),
        rpcUrl: devnetRpcUrl,
        agentAddress: lowBalanceAccount.solanaPublicKey,
        tokenTargetAtomic: 500n,
        solTargetLamports: 100_000_000n,
      })
      expect(lowBalanceSetup.agentAccount?.tokenAccount).toBeTruthy()
      let lowBalanceCompleted: HttpResult | undefined
      let lastLowBalanceResponse: HttpResult | undefined
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const response = await requestJson(`${apiBaseUrl()}/v2/accounts`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-admin-api-key': adminApiKey,
            'idempotency-key': lowBalanceAccountIdempotencyKey,
          },
          body: JSON.stringify({ name: lowBalanceAccountName }),
        })
        lastLowBalanceResponse = response
        if (response.status === 201) {
          lowBalanceCompleted = response
          break
        }
        if (response.status !== 502) {
          throw new Error(
            `Low-balance provisioning returned HTTP ${response.status}: ${JSON.stringify(response.body)}`,
          )
        }
        const delayMs = Math.min(15_000, 1_000 * 2 ** attempt)
        await new Promise((resolve) => setTimeout(resolve, delayMs))
      }
      if (lowBalanceCompleted === undefined) {
        throw new Error(
          [
            'Low-balance provisioning remained transiently unavailable',
            `last response: ${JSON.stringify(lastLowBalanceResponse?.body)}`,
            `API diagnostics:\n${apiProcess?.diagnostics() ?? ''}`,
          ].join('\n'),
        )
      }
      const lowBalanceResponse = asRecord(
        lowBalanceCompleted.body,
        'low-balance account response',
      )
      const lowBalanceApiKey = requireString(
        lowBalanceResponse.api_key,
        'low-balance agent API key',
      )
      const lowBalanceAccountId = requireString(
        lowBalanceResponse.id,
        'low-balance account id',
      )
      const lowBalanceRecipient = await requestJson(`${apiBaseUrl()}/v2/recipients`, {
        method: 'POST',
        headers: agentHeaders(lowBalanceApiKey),
        body: JSON.stringify({
          display_name: 'Low-balance fake x402 service',
          type: 'SOLANA_SPL',
          destination: {
            type: 'SOLANA_SPL',
            wallet_address: funded.fakeService.destination,
          },
        }),
      })
      expect(lowBalanceRecipient.status).toBe(201)
      const lowBalanceApproved = await requestJson(
        `${apiBaseUrl()}/v2/accounts/${lowBalanceAccountId}/approved-destinations`,
        {
          method: 'POST',
          headers: adminHeaders(adminApiKey),
          body: JSON.stringify({
            fingerprint,
            rail: 'SOLANA_SPL',
            network: 'devnet',
            asset_reference: funded.settlementAsset.mint,
            destination: funded.fakeService.destination,
          }),
        },
      )
      expect(lowBalanceApproved.status).toBe(201)
      const lowBalancePolicy = await requestJson(
        `${apiBaseUrl()}/v2/accounts/${lowBalanceAccountId}/policy`,
        {
          method: 'PUT',
          headers: adminHeaders(adminApiKey),
          body: JSON.stringify({
            denomination_id: DENOMINATION_ID,
            max_per_payment: '0.01',
            rolling_budget: '1',
            rolling_window_seconds: 3_600,
            transaction_count_cap: 10,
          }),
        },
      )
      expect(lowBalancePolicy.status).toBe(200)
      const insufficient = await requestJson(
        `${apiBaseUrl()}/v2/external-payments/x402`,
        {
          method: 'POST',
          headers: {
            ...agentHeaders(lowBalanceApiKey),
            'idempotency-key': lowBalancePaymentIdempotencyKey,
          },
          body: JSON.stringify({ denomination_id: DENOMINATION_ID }),
        },
      )
      expect(insufficient.status).toBe(409)
      expect(asRecord(insufficient.body, 'insufficient balance response').code).toBe(
        'INSUFFICIENT_FUNDS',
      )
      expect(
        await database.v2.findV2Idempotency(
          lowBalanceAccountId,
          lowBalancePaymentIdempotencyKey,
        ),
      ).toBeNull()

      await stopProcess(apiProcess)
      apiProcess = startProcess(
        ['--filter', '@agent-payment/api', 'exec', 'tsx', 'src/server.ts'],
        {
          DATABASE_URL: databaseUrl,
          PORT: String(apiPort),
          NODE_ENV: 'test',
          ADMIN_API_KEY: adminApiKey,
          SOLANA_RPC_URL: devnetRpcUrl,
          SOLANA_CLUSTER: 'devnet',
          SOLANA_SETTLEMENT_MINT: setup.settlementAsset.mint,
          SOLANA_FEE_PAYER_SECRET: platformFeePayerSecret,
          SOLANA_FEE_PAYER_IDENTITY: setup.platformFeePayer.address,
          X402_RESOURCE_URL: resourceUrl,
          X402_MAX_PAYMENT_ATOMIC: '1000',
          X402_SIGN_FEE_PAYER: 'true',
          WALLET_MASTER_KEY: runtimeWalletKey,
          RECOVERY_ENVELOPE_KEY: recoveryEnvelopeKey,
          RUNTIME_ROLE: 'all',
          CUSTODY_BACKEND_IDENTITY: 'devnet-local-test-custody',
          CUSTODY_BACKEND_MODE: 'LOCAL_TEST',
          WORKER_INTERVAL_MS: '250',
          WORKER_LEASE_SECONDS: '30',
          ALLOW_MAINNET: 'false',
        },
      )
      await waitForHttp(
        `${apiBaseUrl()}/health/ready`,
        apiProcess,
        DEVNET_E2E_API_READINESS_TIMEOUT_MS,
      )
      let afterRestart: HttpResult
      try {
        afterRestart = await requestJson(`${apiBaseUrl()}/v2/payments/${paymentId}`, {
          method: 'GET',
          headers: agentHeaders(apiKey),
        })
      } catch (error) {
        throw new Error(
          `Payment read after API restart failed: ${
            error instanceof Error ? error.message : String(error)
          }\nAPI diagnostics:\n${apiProcess.diagnostics()}`,
          { cause: error },
        )
      }
      expect(afterRestart.status).toBe(200)
      expect(asRecord(afterRestart.body, 'payment after restart').status).toBe(
        'CONFIRMED',
      )

      await stopProcess(fakeProcess)
      fakeProcess = startProcess(
        ['--filter', '@agent-payment/fake-x402', 'exec', 'tsx', 'server.ts'],
        {
          FAKE_X402_PORT: String(fakePort),
          FAKE_X402_RPC_URL: devnetRpcUrl,
          FAKE_X402_TEST_USDC_MINT: funded.settlementAsset.mint,
          FAKE_X402_DESTINATION: funded.fakeService.destination,
          FAKE_X402_FEE_PAYER: funded.platformFeePayer.address,
          FAKE_X402_RESOURCE_URL: resourceUrl,
          FAKE_X402_DROP_RESPONSE_AFTER_SETTLEMENT: 'true',
        },
      )
      await waitForHttp(`${fakeBaseUrl()}/healthz`, fakeProcess, 30_000)
      const lostResponseRequest = await requestJson(
        `${apiBaseUrl()}/v2/external-payments/x402`,
        {
          method: 'POST',
          headers: {
            ...agentHeaders(apiKey),
            'idempotency-key': lostResponsePaymentIdempotencyKey,
          },
          body: JSON.stringify({ denomination_id: DENOMINATION_ID }),
        },
      )
      expect([200, 201]).toContain(lostResponseRequest.status)
      const lostResponsePayment = asRecord(
        lostResponseRequest.body,
        'lost-response payment',
      )
      const lostResponsePaymentId = requireString(
        lostResponsePayment.id,
        'lost-response payment id',
      )
      let recoveredLostResponse: HttpResult | undefined
      await waitForCondition(
        async () => {
          const result = await requestJson(
            `${apiBaseUrl()}/v2/payments/${lostResponsePaymentId}`,
            { method: 'GET', headers: agentHeaders(apiKey) },
          )
          if (result.status !== 200) return false
          recoveredLostResponse = result
          return (
            asRecord(result.body, 'lost-response payment poll').status === 'CONFIRMED'
          )
        },
        120_000,
        'x402 lost-response reconciliation',
      )
      expect(
        asRecord(recoveredLostResponse?.body, 'recovered lost-response payment').status,
      ).toBe('CONFIRMED')
      const lostResponseView = await database.v2.findPaymentView(
        accountId,
        lostResponsePaymentId,
      )
      expect(lostResponseView?.attempts).toHaveLength(1)
      expect(lostResponseView?.attempts[0]?.externalId).toBeTruthy()
      expect(await readTokenAccountBalance(devnetRpcUrl, agentTokenAccount)).toBe(
        initialAgentTokenBalance - 2_000n,
      )
      expect(await readTokenAccountBalance(devnetRpcUrl, providerTokenAccount)).toBe(
        initialProviderTokenBalance + 2_000n,
      )
      await stopProcess(fakeProcess)

      const credentialRevocation = await requestJson(
        `${apiBaseUrl()}/v2/accounts/${accountId}/credentials/${accountCredentialId}/revoke`,
        {
          method: 'POST',
          headers: { 'x-admin-api-key': adminApiKey },
        },
      )
      expect(credentialRevocation.status).toBe(200)
      const revokedCredentialPayment = await requestJson(
        `${apiBaseUrl()}/v2/external-payments/x402`,
        {
          method: 'POST',
          headers: {
            ...agentHeaders(apiKey),
            'idempotency-key': `devnet-x402-revoked-${runId}`,
          },
          body: JSON.stringify({ denomination_id: DENOMINATION_ID }),
        },
      )
      expect(revokedCredentialPayment.status).toBe(401)
      expect(
        await database.v2.findV2Idempotency(accountId, `devnet-x402-revoked-${runId}`),
      ).toBeNull()

      const delegatedCredential = await requestJson(
        `${apiBaseUrl()}/v2/accounts/${accountId}/credentials`,
        {
          method: 'POST',
          headers: {
            ...adminHeaders(adminApiKey),
            'idempotency-key': delegatedCredentialIdempotencyKey,
          },
          body: JSON.stringify({
            scopes: [
              'payments:create',
              'payments:read',
              'balance:read',
              'history:read',
            ],
          }),
        },
      )
      expect(delegatedCredential.status).toBe(201)
      const delegatedCredentialBody = asRecord(
        delegatedCredential.body,
        'delegated credential response',
      )
      const delegatedApiKey = requireString(
        delegatedCredentialBody.api_key,
        'delegated API key',
      )
      const accountBeforeDisable = await requestJson(
        `${apiBaseUrl()}/v2/accounts/${accountId}`,
        { method: 'GET', headers: agentHeaders(delegatedApiKey) },
      )
      expect(accountBeforeDisable.status).toBe(200)
      const accountBeforeDisableBody = asRecord(
        accountBeforeDisable.body,
        'account before disable',
      )
      const disable = await requestJson(
        `${apiBaseUrl()}/v2/accounts/${accountId}/lifecycle`,
        {
          method: 'POST',
          headers: adminHeaders(adminApiKey),
          body: JSON.stringify({
            current_status: 'ACTIVE',
            next_status: 'DISABLED',
            row_version: accountBeforeDisableBody.row_version,
            reason: 'devnet x402 negative-path verification',
          }),
        },
      )
      expect(disable.status).toBe(200)
      const disabledCredentialPayment = await requestJson(
        `${apiBaseUrl()}/v2/external-payments/x402`,
        {
          method: 'POST',
          headers: {
            ...agentHeaders(delegatedApiKey),
            'idempotency-key': `devnet-x402-disabled-${runId}`,
          },
          body: JSON.stringify({ denomination_id: DENOMINATION_ID }),
        },
      )
      expect(disabledCredentialPayment.status).toBe(401)

      state = {
        database,
        apiBaseUrl: apiBaseUrl(),
        fakeBaseUrl: fakeBaseUrl(),
        adminApiKey,
        accountId,
        accountOwner,
        apiKey,
        providerDestination: funded.fakeService.destination,
        settlementMint: funded.settlementAsset.mint,
        platformFeePayer: funded.platformFeePayer.address,
        apiProcess,
        fakeProcess,
      }
      apiProcess = undefined
      fakeProcess = undefined
    } catch (error) {
      if (fakeProcess !== undefined) await stopProcess(fakeProcess)
      if (apiProcess !== undefined) await stopProcess(apiProcess)
      await database.disconnect()
      throw error
    }
  }, DEVNET_E2E_HOOK_TIMEOUT_MS)

  afterAll(async () => {
    if (state !== undefined) {
      await stopProcess(state.fakeProcess)
      await stopProcess(state.apiProcess)
      await state.database.disconnect()
      state = undefined
    }
  })

  it('completes the real devnet transaction and all durable MUX states', () => {
    expect(state).toBeDefined()
    expect(state?.providerDestination).toBeTruthy()
    expect(state?.settlementMint).toBeTruthy()
    expect(state?.platformFeePayer).toBeTruthy()
  })
})

async function seedDevnetFinancialIdentity(
  url: string,
  settlementMint: string,
): Promise<void> {
  const database = createDatabaseClient(url)
  try {
    const denomination = await database.v2.findDenomination(DENOMINATION_ID)
    if (denomination === null) {
      await database.v2.createDenomination({
        id: DENOMINATION_ID,
        symbol: 'USD',
        maxScale: 6,
      })
    } else if (denomination.symbol !== 'USD' || denomination.maxScale !== 6) {
      throw new Error(`Denomination ${DENOMINATION_ID} is incompatible with TEST_USDC`)
    }

    const asset = await database.v2.findSettlementAsset(SETTLEMENT_ASSET_ID)
    if (asset === null) {
      await database.v2.createSettlementAsset({
        id: SETTLEMENT_ASSET_ID,
        rail: 'SOLANA_SPL',
        network: 'devnet',
        assetReference: settlementMint,
        decimals: 6,
      })
    } else if (
      asset.rail !== 'SOLANA_SPL' ||
      asset.network !== 'devnet' ||
      asset.assetReference !== settlementMint ||
      asset.decimals !== 6
    ) {
      throw new Error(
        `Settlement asset ${SETTLEMENT_ASSET_ID} is incompatible with TEST_USDC`,
      )
    }

    const mapping = await database.v2.findEconomicMapping(ECONOMIC_MAPPING_ID)
    if (mapping === null) {
      await database.v2.createEconomicMapping({
        id: ECONOMIC_MAPPING_ID,
        denominationId: DENOMINATION_ID,
        settlementAssetId: SETTLEMENT_ASSET_ID,
        numerator: 1n,
        denominator: 1n,
      })
    } else if (
      mapping.denominationId !== DENOMINATION_ID ||
      mapping.settlementAssetId !== SETTLEMENT_ASSET_ID ||
      mapping.numerator !== 1n ||
      mapping.denominator !== 1n
    ) {
      throw new Error(`Economic mapping ${ECONOMIC_MAPPING_ID} is incompatible`)
    }

    const activeRoutes = await database.v2.listActiveSettlementRoutes()
    if (activeRoutes.some((route) => route.id !== SETTLEMENT_ROUTE_ID)) {
      throw new Error(
        'The devnet E2E database contains another active route; use a dedicated database',
      )
    }
    const route = await database.v2.findSettlementRoute(SETTLEMENT_ROUTE_ID)
    if (route === null) {
      const devnetRoute: SettlementRoute = {
        id: SETTLEMENT_ROUTE_ID,
        rail: 'SOLANA_SPL',
        railVersion: 'v2-devnet',
        network: 'devnet',
        settlementAssetId: SETTLEMENT_ASSET_ID,
        economicMappingId: ECONOMIC_MAPPING_ID,
        status: 'ACTIVE',
        priority: 1,
        configVersion: 'devnet-x402-v1',
      }
      await database.v2.createSettlementRoute(devnetRoute)
    } else if (
      route.rail !== 'SOLANA_SPL' ||
      route.network !== 'devnet' ||
      route.settlementAssetId !== SETTLEMENT_ASSET_ID ||
      route.economicMappingId !== ECONOMIC_MAPPING_ID ||
      route.status !== 'ACTIVE'
    ) {
      throw new Error(`Settlement route ${SETTLEMENT_ROUTE_ID} is incompatible`)
    }
  } finally {
    await database.disconnect()
  }
}

function startProcess(
  args: readonly string[],
  environment: Readonly<Record<string, string>>,
): RunningProcess {
  const child = spawn('pnpm', args, {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      COREPACK_HOME: '/tmp/agent-payment-account-corepack',
      NO_DNA: '1',
      ...environment,
    },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  const capture = (chunk: Buffer): void => {
    if (output.length >= 12_000) return
    output += chunk.toString('utf8').slice(0, 12_000 - output.length)
  }
  child.stdout.on('data', capture)
  child.stderr.on('data', capture)
  return {
    child,
    diagnostics: () => output.slice(-4_000),
  }
}

async function stopProcess(runningProcess: RunningProcess): Promise<void> {
  if (
    runningProcess.child.exitCode !== null ||
    runningProcess.child.signalCode !== null
  ) {
    return
  }
  const pid = runningProcess.child.pid
  if (pid !== undefined) {
    try {
      globalThis.process.kill(-pid, 'SIGTERM')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  } else {
    runningProcess.child.kill('SIGTERM')
  }
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      if (
        runningProcess.child.exitCode === null &&
        runningProcess.child.signalCode === null
      ) {
        if (pid !== undefined) {
          try {
            globalThis.process.kill(-pid, 'SIGKILL')
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
          }
        } else {
          runningProcess.child.kill('SIGKILL')
        }
      }
      resolve()
    }, 10_000)
    runningProcess.child.once('exit', () => {
      clearTimeout(timeout)
      resolve()
    })
  })
}

async function waitForHttp(
  url: string,
  process: RunningProcess,
  timeoutMs: number,
): Promise<void> {
  try {
    await waitForCondition(
      async () => {
        if (process.child.exitCode !== null || process.child.signalCode !== null) {
          throw new Error(
            `Child process exited while waiting for ${url}: ${process.diagnostics()}`,
          )
        }
        try {
          const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
          return response.ok
        } catch {
          return false
        }
      },
      timeoutMs,
      `HTTP readiness at ${url}`,
    )
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : 'HTTP readiness failed'}\nProcess diagnostics:\n${process.diagnostics()}`,
      { cause: error },
    )
  }
}

async function waitForCondition(
  check: () => Promise<boolean>,
  timeoutMs: number,
  description: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      if (await check()) return
    } catch (error) {
      lastError = error
      if (error instanceof Error && error.message.includes('Child process exited')) {
        throw error
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(
    `Timed out waiting for ${description}${
      lastError instanceof Error ? `: ${lastError.message}` : ''
    }`,
  )
}

async function requestJson(url: string, init: RequestInit): Promise<HttpResult> {
  const response = await fetch(url, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(30_000),
  })
  const text = await response.text()
  let body: unknown = null
  if (text.length > 0) {
    try {
      body = JSON.parse(text) as unknown
    } catch {
      body = text
    }
  }
  return { status: response.status, body, headers: response.headers }
}

function apiBaseUrl(): string {
  return `http://127.0.0.1:${apiPort}`
}

function fakeBaseUrl(): string {
  return `http://127.0.0.1:${fakePort}`
}

function adminHeaders(key: string): Record<string, string> {
  return { 'content-type': 'application/json', 'x-admin-api-key': key }
}

function agentHeaders(key: string): Record<string, string> {
  return { 'content-type': 'application/json', authorization: `Bearer ${key}` }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function assertPort(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be a valid TCP port`)
  }
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`)
  }
  return value
}

function requireInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`${label} must be an integer`)
  }
  return value
}

function timelinePaymentId(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const paymentId = (value as Record<string, unknown>).payment_id
  return typeof paymentId === 'string' ? paymentId : undefined
}

async function readRpc(
  rpcUrl: string,
  method: string,
  params: readonly unknown[],
): Promise<unknown> {
  for (let attempt = 0; attempt <= DEVNET_RPC_RATE_LIMIT_MAX_RETRIES; attempt += 1) {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(30_000),
    })
    if (response.status === 429 && attempt < DEVNET_RPC_RATE_LIMIT_MAX_RETRIES) {
      await waitForDevnetRpcRateLimit(response, attempt)
      continue
    }
    if (!response.ok)
      throw new Error(`Solana RPC ${method} returned HTTP ${response.status}`)
    const payload: unknown = await response.json()
    const object = asRecord(payload, 'Solana RPC response')
    if (object.error !== undefined) throw new Error(`Solana RPC ${method} failed`)
    return object.result
  }
  throw new Error(`Solana RPC rate limit persisted: ${method}`)
}

async function waitForDevnetRpcRateLimit(
  response: Response,
  attempt: number,
): Promise<void> {
  const retryAfter = response.headers.get('retry-after')
  const retryAfterMs = parseRetryAfterMs(retryAfter)
  const exponentialDelay = Math.min(
    DEVNET_RPC_RATE_LIMIT_MAX_DELAY_MS,
    DEVNET_RPC_RATE_LIMIT_BASE_DELAY_MS * 2 ** attempt,
  )
  const delayMs = Math.min(
    DEVNET_RPC_RATE_LIMIT_MAX_DELAY_MS,
    Math.max(exponentialDelay, retryAfterMs ?? 0),
  )
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs))
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (value === null) return undefined
  const seconds = Number(value.trim())
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000)
  const timestamp = Date.parse(value)
  if (Number.isNaN(timestamp)) return undefined
  return Math.max(0, timestamp - Date.now())
}

async function readTokenAccountBalance(
  rpcUrl: string,
  tokenAccountAddress: string,
): Promise<bigint> {
  const result = asRecord(
    await readRpc(rpcUrl, 'getTokenAccountBalance', [
      tokenAccountAddress,
      { commitment: 'confirmed' },
    ]),
    'token account balance result',
  )
  const value = asRecord(result.value, 'token account balance value')
  const amount = requireString(value.amount, 'token account balance amount')
  if (!/^\d+$/u.test(amount)) {
    throw new Error('token account balance amount must be a non-negative integer')
  }
  return BigInt(amount)
}
