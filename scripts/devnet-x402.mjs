import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { buildChildProcessEnvironment } from './child-environment.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const defaultHomeDirectory = path.join(repositoryRoot, '.local', 'devnet-x402')

export const DEVNET_X402_NETWORK = 'devnet'
export const DEVNET_X402_RPC_URL = 'https://api.devnet.solana.com'
export const DEVNET_X402_DEVNET_GENESIS_HASH =
  'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'
export const TEST_USDC_SYMBOL = 'TEST_USDC'
export const TEST_USDC_DECIMALS = 6
export const DEFAULT_DEVNET_X402_SOL_TARGET = '0.1'
export const DEFAULT_DEVNET_X402_TOKEN_TARGET = '1'

const TOKEN_PROGRAM_ADDRESS = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const LAMPORTS_PER_SOL = 1_000_000_000n
const MAX_AIRDROP_SOL = 2n
const MAX_TOKEN_TARGET = 1_000_000n * 10n ** BigInt(TEST_USDC_DECIMALS)
const COMMAND_TIMEOUT_MS = 120_000
const RPC_TIMEOUT_MS = 20_000
const RPC_RATE_LIMIT_MAX_RETRIES = 5
const RPC_RATE_LIMIT_BASE_DELAY_MS = 1_000
const RPC_RATE_LIMIT_MAX_DELAY_MS = 15_000
const CLI_BLOCKHASH_MAX_RETRIES = 3
const CLI_BLOCKHASH_BASE_DELAY_MS = 1_000
const POLL_INTERVAL_MS = 500
const POLL_TIMEOUT_MS = 45_000

const KEYPAIR_NAMES = Object.freeze({
  platformFeePayer: 'platform-fee-payer.json',
  fakeService: 'fake-service-destination.json',
  mint: 'test-usdc-mint.json',
})

export class DevnetX402SetupError extends Error {
  constructor(message, cause) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'DevnetX402SetupError'
  }
}

function isPathWithin(child, parent) {
  const relative = path.relative(parent, child)
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..'
}

function assertSafeHomeDirectory(homeDirectory) {
  const resolved = path.resolve(homeDirectory)
  const allowedRoots = [path.join(repositoryRoot, '.local'), os.tmpdir()]
  if (!allowedRoots.some((root) => isPathWithin(resolved, root))) {
    throw new DevnetX402SetupError(
      'DEVNET_X402_HOME must be inside the repository .local directory or the OS temporary directory.',
    )
  }
  return resolved
}

export function resolveDevnetX402Paths(homeDirectory = defaultHomeDirectory) {
  const home = assertSafeHomeDirectory(homeDirectory)
  return Object.freeze({
    home,
    platformFeePayer: path.join(home, KEYPAIR_NAMES.platformFeePayer),
    fakeService: path.join(home, KEYPAIR_NAMES.fakeService),
    mint: path.join(home, KEYPAIR_NAMES.mint),
  })
}

function parseDecimal(value, decimals, label, { maximum, allowZero = true } = {}) {
  const normalized = String(value).trim()
  if (!/^\d+(?:\.\d+)?$/u.test(normalized)) {
    throw new DevnetX402SetupError(`${label} must be a non-negative decimal amount.`)
  }

  const [whole, fraction = ''] = normalized.split('.')
  if (fraction.length > decimals) {
    throw new DevnetX402SetupError(
      `${label} supports at most ${decimals} fractional digits.`,
    )
  }
  const atomic =
    BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt(fraction.padEnd(decimals, '0') || '0')
  if (!allowZero && atomic === 0n) {
    throw new DevnetX402SetupError(`${label} must be greater than zero.`)
  }
  if (maximum !== undefined && atomic > maximum) {
    throw new DevnetX402SetupError(`${label} is larger than the safe harness limit.`)
  }
  return atomic
}

export function parseSolAmount(value, label = 'SOL target') {
  return parseDecimal(value, 9, label, {
    maximum: MAX_AIRDROP_SOL * LAMPORTS_PER_SOL,
    allowZero: false,
  })
}

export function parseTestUsdcAmount(value, label = `${TEST_USDC_SYMBOL} target`) {
  return parseDecimal(value, TEST_USDC_DECIMALS, label, {
    maximum: MAX_TOKEN_TARGET,
    allowZero: false,
  })
}

export function formatAtomicAmount(atomic, decimals) {
  if (typeof atomic !== 'bigint' || atomic < 0n) {
    throw new DevnetX402SetupError('Atomic amount must be a non-negative bigint.')
  }
  const divisor = 10n ** BigInt(decimals)
  const whole = atomic / divisor
  const fraction = (atomic % divisor)
    .toString()
    .padStart(decimals, '0')
    .replace(/0+$/u, '')
  return fraction === '' ? whole.toString() : `${whole}.${fraction}`
}

export function amountToTopUp(current, target) {
  if (typeof current !== 'bigint' || typeof target !== 'bigint') {
    throw new DevnetX402SetupError('Balance calculations require bigint values.')
  }
  return current >= target ? 0n : target - current
}

function assertDevnetRpcUrl(rpcUrl) {
  let parsed
  try {
    parsed = new URL(rpcUrl)
  } catch (error) {
    throw new DevnetX402SetupError(
      'DEVNET_X402_RPC_URL must be a valid HTTPS URL.',
      error,
    )
  }
  if (parsed.protocol !== 'https:') {
    throw new DevnetX402SetupError(
      'DEVNET_X402_RPC_URL must use HTTPS; this harness never targets localnet or mainnet.',
    )
  }
  if (/mainnet|testnet|localhost|127\.0\.0\.1|0\.0\.0\.0/iu.test(parsed.hostname)) {
    throw new DevnetX402SetupError(
      'DEVNET_X402_RPC_URL looks like a non-devnet endpoint; refusing to continue.',
    )
  }
  return parsed.toString().replace(/\/$/u, '')
}

export function resolveDevnetX402Config(options = {}) {
  const environment = options.environment ?? process.env
  const rpcUrl = assertDevnetRpcUrl(
    options.rpcUrl ?? environment.DEVNET_X402_RPC_URL ?? DEVNET_X402_RPC_URL,
  )
  const homeDirectory = assertSafeHomeDirectory(
    options.homeDirectory ?? environment.DEVNET_X402_HOME ?? defaultHomeDirectory,
  )
  const solTargetLamports =
    options.solTargetLamports ??
    parseSolAmount(environment.DEVNET_X402_SOL_TARGET ?? DEFAULT_DEVNET_X402_SOL_TARGET)
  const tokenTargetAtomic =
    options.tokenTargetAtomic ??
    parseTestUsdcAmount(
      environment.DEVNET_X402_TOKEN_TARGET ?? DEFAULT_DEVNET_X402_TOKEN_TARGET,
    )
  const configuredAgentAddress =
    options.agentAddress ?? environment.DEVNET_X402_AGENT_ADDRESS
  const agentAddress =
    configuredAgentAddress === undefined || configuredAgentAddress.trim() === ''
      ? undefined
      : parsePublicKey(configuredAgentAddress, 'MUX Agent Account')

  if (typeof solTargetLamports !== 'bigint' || solTargetLamports <= 0n) {
    throw new DevnetX402SetupError('SOL target must be a positive bigint.')
  }
  if (typeof tokenTargetAtomic !== 'bigint' || tokenTargetAtomic <= 0n) {
    throw new DevnetX402SetupError('TEST_USDC target must be a positive bigint.')
  }

  return Object.freeze({
    rpcUrl,
    homeDirectory,
    solTargetLamports,
    tokenTargetAtomic,
    agentAddress,
    pollIntervalMs: options.pollIntervalMs ?? POLL_INTERVAL_MS,
    pollTimeoutMs: options.pollTimeoutMs ?? POLL_TIMEOUT_MS,
  })
}

function ensureDirectory(directory) {
  if (existsSync(directory)) {
    const stat = lstatSync(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new DevnetX402SetupError(
        'Harness home exists but is not a regular directory.',
      )
    }
  } else {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
  }
  chmodSync(directory, 0o700)
}

function assertRegularKeypairFile(filePath) {
  const stat = lstatSync(filePath)
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new DevnetX402SetupError('Harness keypair path is not a regular file.')
  }
  chmodSync(filePath, 0o600)
}

function isPublicKey(value) {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/u.test(value)
}

function parsePublicKey(value, label) {
  const normalized = value.trim()
  if (!isPublicKey(normalized)) {
    throw new DevnetX402SetupError(
      `${label} command returned an invalid public identity.`,
    )
  }
  return normalized
}

function createCommandRunner() {
  const environment = buildChildProcessEnvironment({ NO_DNA: '1' })
  return (command, args) => {
    const result = spawnSync(command, args, {
      cwd: repositoryRoot,
      env: environment,
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: COMMAND_TIMEOUT_MS,
    })
    if (result.error !== undefined) {
      throw new DevnetX402SetupError(`Unable to run ${command}.`, result.error)
    }
    if (result.status !== 0) {
      const detail = result.stderr.trim().replace(/\s+/gu, ' ').slice(0, 500)
      throw new DevnetX402SetupError(
        `${command} command failed${detail === '' ? '.' : `: ${detail}`}`,
      )
    }
    return result.stdout.trim()
  }
}

function checkPrerequisites() {
  for (const command of ['solana', 'solana-keygen', 'spl-token']) {
    const result = spawnSync(command, ['--version'], {
      cwd: repositoryRoot,
      env: buildChildProcessEnvironment({ NO_DNA: '1' }),
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: COMMAND_TIMEOUT_MS,
    })
    if (result.error !== undefined || result.status !== 0) {
      throw new DevnetX402SetupError(
        `Missing ${command}. Install the Solana CLI and spl-token CLI before running the harness.`,
      )
    }
  }
}

function createRpcClient(rpcUrl) {
  return {
    async request(method, params = []) {
      for (let attempt = 0; attempt <= RPC_RATE_LIMIT_MAX_RETRIES; attempt += 1) {
        let response
        try {
          response = await fetch(rpcUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
            signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
          })
        } catch (error) {
          throw new DevnetX402SetupError(`Devnet RPC request failed: ${method}.`, error)
        }
        if (response.status === 429 && attempt < RPC_RATE_LIMIT_MAX_RETRIES) {
          await waitForRpcRateLimit(response, attempt)
          continue
        }
        if (!response.ok) {
          throw new DevnetX402SetupError(`Devnet RPC returned HTTP ${response.status}.`)
        }
        let payload
        try {
          payload = await response.json()
        } catch (error) {
          throw new DevnetX402SetupError(
            `Devnet RPC returned invalid JSON: ${method}.`,
            error,
          )
        }
        if (
          payload === null ||
          typeof payload !== 'object' ||
          payload.error !== undefined
        ) {
          throw new DevnetX402SetupError(`Devnet RPC rejected ${method}.`)
        }
        return payload.result
      }
      throw new DevnetX402SetupError(`Devnet RPC rate limit persisted: ${method}.`)
    },
  }
}

async function waitForRpcRateLimit(response, attempt) {
  const retryAfter = response.headers.get('retry-after')
  const retryAfterMs = parseRetryAfterMs(retryAfter)
  const exponentialDelay = Math.min(
    RPC_RATE_LIMIT_MAX_DELAY_MS,
    RPC_RATE_LIMIT_BASE_DELAY_MS * 2 ** attempt,
  )
  const delayMs = Math.min(
    RPC_RATE_LIMIT_MAX_DELAY_MS,
    Math.max(exponentialDelay, retryAfterMs ?? 0),
  )
  await new Promise((resolve) => setTimeout(resolve, delayMs))
}

function parseRetryAfterMs(value) {
  if (value === null) return undefined
  const seconds = Number(value.trim())
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000)
  const timestamp = Date.parse(value)
  if (Number.isNaN(timestamp)) return undefined
  return Math.max(0, timestamp - Date.now())
}

async function request(rpcClient, method, params) {
  return rpcClient.request(method, params)
}

async function assertDevnetRpc(rpcClient) {
  const genesisHash = await request(rpcClient, 'getGenesisHash')
  if (genesisHash !== DEVNET_X402_DEVNET_GENESIS_HASH) {
    throw new DevnetX402SetupError(
      'RPC is not Solana devnet; refusing to create or fund test assets.',
    )
  }
}

async function waitFor(check, timeoutMs, pollIntervalMs, description) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
  }
  throw new DevnetX402SetupError(`Timed out waiting for ${description}.`)
}

function ensureKeypair(filePath, label, runCommand) {
  ensureDirectory(path.dirname(filePath))
  if (!existsSync(filePath)) {
    runCommand('solana-keygen', [
      'new',
      '--silent',
      '--no-bip39-passphrase',
      '--outfile',
      filePath,
    ])
  }
  assertRegularKeypairFile(filePath)
  return parsePublicKey(
    runCommand('solana-keygen', ['pubkey', filePath]),
    `${label} public identity`,
  )
}

async function getSolBalance(rpcClient, address) {
  const result = await request(rpcClient, 'getBalance', [
    address,
    { commitment: 'confirmed' },
  ])
  if (
    result === null ||
    typeof result !== 'object' ||
    typeof result.value !== 'number'
  ) {
    throw new DevnetX402SetupError('Devnet RPC returned an invalid SOL balance.')
  }
  return BigInt(result.value)
}

async function ensureSolBalance(
  address,
  targetLamports,
  config,
  runCommand,
  rpcClient,
) {
  let balance = await getSolBalance(rpcClient, address)
  let remaining = amountToTopUp(balance, targetLamports)
  while (remaining > 0n) {
    const requestAmount =
      remaining > MAX_AIRDROP_SOL * LAMPORTS_PER_SOL
        ? MAX_AIRDROP_SOL * LAMPORTS_PER_SOL
        : remaining
    await runCommandWithConfirmationRecovery(
      runCommand,
      'solana',
      [
        'airdrop',
        formatAtomicAmount(requestAmount, 9),
        address,
        '--url',
        config.rpcUrl,
        '--commitment',
        'confirmed',
      ],
      async () => (await getSolBalance(rpcClient, address)) >= balance + requestAmount,
      config.pollTimeoutMs,
      config.pollIntervalMs,
    ).catch((error) => {
      throw new DevnetX402SetupError(
        `Devnet SOL faucet could not fund ${address} with ${formatAtomicAmount(
          requestAmount,
          9,
        )} SOL. Request that amount from a Solana devnet faucet, then rerun the setup.`,
        error,
      )
    })
    await waitFor(
      async () => (await getSolBalance(rpcClient, address)) >= balance + requestAmount,
      config.pollTimeoutMs,
      config.pollIntervalMs,
      `${address} devnet SOL faucet balance`,
    )
    balance = await getSolBalance(rpcClient, address)
    remaining = amountToTopUp(balance, targetLamports)
  }
  return balance
}

async function getAccountInfo(rpcClient, accountAddress, encoding = 'base64') {
  const result = await request(rpcClient, 'getAccountInfo', [
    accountAddress,
    { commitment: 'confirmed', encoding },
  ])
  if (result === null || typeof result !== 'object') {
    throw new DevnetX402SetupError('Devnet RPC returned invalid account information.')
  }
  return result.value
}

function parseBase64AccountData(value) {
  if (
    value === null ||
    typeof value !== 'object' ||
    value.owner !== TOKEN_PROGRAM_ADDRESS ||
    !Array.isArray(value.data) ||
    typeof value.data[0] !== 'string'
  ) {
    return undefined
  }
  return Buffer.from(value.data[0], 'base64')
}

async function mintIsReady(rpcClient, mintAddress) {
  const value = await getAccountInfo(rpcClient, mintAddress)
  const data = parseBase64AccountData(value)
  return (
    data !== undefined &&
    data.length === 82 &&
    data[44] === TEST_USDC_DECIMALS &&
    data[45] === 1
  )
}

async function ensureMint(
  mintAddress,
  config,
  feePayerPath,
  feePayerAddress,
  runCommand,
  rpcClient,
) {
  const account = await getAccountInfo(rpcClient, mintAddress)
  if (account !== null && !(await mintIsReady(rpcClient, mintAddress))) {
    throw new DevnetX402SetupError(
      'Existing TEST_USDC mint identity points to an incompatible token account.',
    )
  }
  if (await mintIsReady(rpcClient, mintAddress)) return

  await runCommandWithConfirmationRecovery(
    runCommand,
    'spl-token',
    [
      'create-token',
      config.mintPath,
      '--decimals',
      String(TEST_USDC_DECIMALS),
      '--fee-payer',
      feePayerPath,
      '--mint-authority',
      feePayerAddress,
      '--url',
      config.rpcUrl,
      '--output',
      'json-compact',
      '--verbose',
    ],
    async () => mintIsReady(rpcClient, mintAddress),
    config.pollTimeoutMs,
    config.pollIntervalMs,
  )
  await waitFor(
    () => mintIsReady(rpcClient, mintAddress),
    config.pollTimeoutMs,
    config.pollIntervalMs,
    'TEST_USDC mint',
  )
}

function parseAssociatedTokenAddress(value) {
  let parsed
  try {
    parsed = JSON.parse(value)
  } catch (error) {
    throw new DevnetX402SetupError('spl-token returned invalid ATA JSON.', error)
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    typeof parsed.associatedTokenAddress !== 'string'
  ) {
    throw new DevnetX402SetupError(
      'spl-token did not return an associated token address.',
    )
  }
  return parsePublicKey(parsed.associatedTokenAddress, 'Associated token')
}

async function associatedTokenAddress(mintAddress, ownerAddress, config, runCommand) {
  return parseAssociatedTokenAddress(
    runCommand('spl-token', [
      'address',
      '--verbose',
      '--token',
      mintAddress,
      '--owner',
      ownerAddress,
      '--url',
      config.rpcUrl,
      '--output',
      'json-compact',
    ]),
  )
}

function tokenAccountIsReady(value, mintAddress, ownerAddress) {
  if (
    value === null ||
    typeof value !== 'object' ||
    value.owner !== TOKEN_PROGRAM_ADDRESS ||
    value.data === null ||
    typeof value.data !== 'object' ||
    value.data.parsed === null ||
    typeof value.data.parsed !== 'object'
  ) {
    return false
  }
  const parsed = value.data.parsed
  if (
    parsed.type !== 'account' ||
    parsed.info === null ||
    typeof parsed.info !== 'object'
  ) {
    return false
  }
  return parsed.info.mint === mintAddress && parsed.info.owner === ownerAddress
}

async function ensureAta(
  mintAddress,
  ownerAddress,
  config,
  feePayerPath,
  runCommand,
  rpcClient,
) {
  const ataAddress = await associatedTokenAddress(
    mintAddress,
    ownerAddress,
    config,
    runCommand,
  )
  const existing = await getAccountInfo(rpcClient, ataAddress, 'jsonParsed')
  if (existing !== null && !tokenAccountIsReady(existing, mintAddress, ownerAddress)) {
    throw new DevnetX402SetupError(
      'Existing ATA identity points to an incompatible token account.',
    )
  }
  if (existing !== null) return ataAddress

  await runCommandWithConfirmationRecovery(
    runCommand,
    'spl-token',
    [
      'create-account',
      mintAddress,
      '--owner',
      ownerAddress,
      '--fee-payer',
      feePayerPath,
      '--url',
      config.rpcUrl,
      '--output',
      'json-compact',
      '--verbose',
    ],
    async () => {
      const observed = await getAccountInfo(rpcClient, ataAddress, 'jsonParsed')
      if (observed === null) return false
      if (!tokenAccountIsReady(observed, mintAddress, ownerAddress)) {
        throw new DevnetX402SetupError(
          'Existing ATA identity points to an incompatible token account.',
        )
      }
      return true
    },
    config.pollTimeoutMs,
    config.pollIntervalMs,
  )
  await waitFor(
    async () =>
      tokenAccountIsReady(
        await getAccountInfo(rpcClient, ataAddress, 'jsonParsed'),
        mintAddress,
        ownerAddress,
      ),
    config.pollTimeoutMs,
    config.pollIntervalMs,
    `${ownerAddress} TEST_USDC ATA`,
  )
  return ataAddress
}

async function getTokenBalance(rpcClient, tokenAccountAddress) {
  const result = await request(rpcClient, 'getTokenAccountBalance', [
    tokenAccountAddress,
    { commitment: 'confirmed' },
  ])
  if (
    result === null ||
    typeof result !== 'object' ||
    result.value === null ||
    typeof result.value !== 'object' ||
    typeof result.value.amount !== 'string' ||
    !/^\d+$/u.test(result.value.amount)
  ) {
    throw new DevnetX402SetupError('Devnet RPC returned an invalid TEST_USDC balance.')
  }
  return BigInt(result.value.amount)
}

async function ensureTokenBalance(
  mintAddress,
  tokenAccountAddress,
  targetAtomic,
  config,
  feePayerPath,
  runCommand,
  rpcClient,
) {
  let balance = await getTokenBalance(rpcClient, tokenAccountAddress)
  const topUp = amountToTopUp(balance, targetAtomic)
  if (topUp === 0n) return balance

  await runCommandWithConfirmationRecovery(
    runCommand,
    'spl-token',
    [
      'mint',
      mintAddress,
      formatAtomicAmount(topUp, TEST_USDC_DECIMALS),
      tokenAccountAddress,
      '--mint-authority',
      feePayerPath,
      '--fee-payer',
      feePayerPath,
      '--url',
      config.rpcUrl,
      '--output',
      'json-compact',
      '--verbose',
    ],
    async () => (await getTokenBalance(rpcClient, tokenAccountAddress)) >= targetAtomic,
    config.pollTimeoutMs,
    config.pollIntervalMs,
  )
  await waitFor(
    async () => (await getTokenBalance(rpcClient, tokenAccountAddress)) >= targetAtomic,
    config.pollTimeoutMs,
    config.pollIntervalMs,
    `${tokenAccountAddress} TEST_USDC balance`,
  )
  balance = await getTokenBalance(rpcClient, tokenAccountAddress)
  return balance
}

async function runCommandWithTransientRetry(runCommand, command, args) {
  for (let attempt = 0; attempt <= CLI_BLOCKHASH_MAX_RETRIES; attempt += 1) {
    try {
      return runCommand(command, args)
    } catch (error) {
      if (!isBlockhashNotFoundError(error) || attempt === CLI_BLOCKHASH_MAX_RETRIES) {
        throw error
      }
      const delayMs = CLI_BLOCKHASH_BASE_DELAY_MS * 2 ** attempt
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
  throw new DevnetX402SetupError(`${command} command failed after transient retries.`)
}

async function runCommandWithConfirmationRecovery(
  runCommand,
  command,
  args,
  postcondition,
  postconditionTimeoutMs,
  postconditionPollIntervalMs,
) {
  try {
    await runCommandWithTransientRetry(runCommand, command, args)
    return
  } catch (error) {
    if (!isTransactionConfirmationUncertainError(error)) throw error
    try {
      await waitFor(
        postcondition,
        postconditionTimeoutMs,
        postconditionPollIntervalMs,
        `${command} transaction effect`,
      )
      return
    } catch (postconditionError) {
      throw new DevnetX402SetupError(
        `${command} confirmation outcome is unknown; refusing to resubmit the command automatically.`,
        postconditionError,
      )
    }
  }
}

function isBlockhashNotFoundError(error) {
  if (!(error instanceof Error)) return false
  const detail = `${error.name} ${error.message}`.toLowerCase()
  return detail.includes('blockhashnotfound') || detail.includes('blockhash not found')
}

function isTransactionConfirmationUncertainError(error) {
  if (!(error instanceof Error)) return false
  const detail = `${error.name} ${error.message}`.toLowerCase()
  return (
    detail.includes('unable to confirm transaction') ||
    detail.includes('transaction expiration') ||
    detail.includes('transaction expired') ||
    detail.includes('transaction was not confirmed') ||
    detail.includes('transaction confirmation timed out') ||
    detail.includes('timed out waiting for transaction confirmation')
  )
}

function publicSetupResult({
  config,
  feePayerAddress,
  feePayerSol,
  agentAddress,
  agentSol,
  agentAta,
  agentTokenBalance,
  fakeServiceAddress,
  fakeServiceAta,
  mintAddress,
}) {
  return {
    network: DEVNET_X402_NETWORK,
    rpcUrl: config.rpcUrl,
    platformFeePayer: {
      address: feePayerAddress,
      solBalance: formatAtomicAmount(feePayerSol, 9),
    },
    facilitatorFeePayer: feePayerAddress,
    agentAccount:
      agentAddress === undefined
        ? undefined
        : {
            address: agentAddress,
            solBalance:
              agentSol === undefined ? undefined : formatAtomicAmount(agentSol, 9),
            tokenAccount: agentAta,
            tokenBalance:
              agentTokenBalance === undefined
                ? undefined
                : formatAtomicAmount(agentTokenBalance, TEST_USDC_DECIMALS),
          },
    fakeService: {
      destination: fakeServiceAddress,
      tokenAccount: fakeServiceAta,
    },
    settlementAsset: {
      symbol: TEST_USDC_SYMBOL,
      decimals: TEST_USDC_DECIMALS,
      mint: mintAddress,
      economicValue: 'none',
    },
  }
}

export async function setupDevnetX402(options = {}) {
  const resolved = resolveDevnetX402Config(options)
  const paths = resolveDevnetX402Paths(resolved.homeDirectory)
  const runCommand = options.runCommand ?? createCommandRunner()
  const rpcClient = options.rpcClient ?? createRpcClient(resolved.rpcUrl)

  if (options.runCommand === undefined) checkPrerequisites()
  await assertDevnetRpc(rpcClient)
  ensureDirectory(paths.home)

  const feePayerAddress = ensureKeypair(
    paths.platformFeePayer,
    'Platform Fee Payer',
    runCommand,
  )
  const agentAddress = resolved.agentAddress
  if (agentAddress !== undefined && agentAddress === feePayerAddress) {
    throw new DevnetX402SetupError(
      'MUX Agent Account must use a different signer identity from the Platform Fee Payer.',
    )
  }
  const fakeServiceAddress = ensureKeypair(
    paths.fakeService,
    'fake service destination',
    runCommand,
  )
  const mintAddress = ensureKeypair(paths.mint, `${TEST_USDC_SYMBOL} mint`, runCommand)

  const feePayerSol = await ensureSolBalance(
    feePayerAddress,
    resolved.solTargetLamports,
    resolved,
    runCommand,
    rpcClient,
  )
  const agentSol =
    agentAddress === undefined
      ? undefined
      : await getSolBalance(rpcClient, agentAddress)

  await ensureMint(
    mintAddress,
    { ...resolved, mintPath: paths.mint },
    paths.platformFeePayer,
    feePayerAddress,
    runCommand,
    rpcClient,
  )
  const agentAta =
    agentAddress === undefined
      ? undefined
      : await ensureAta(
          mintAddress,
          agentAddress,
          resolved,
          paths.platformFeePayer,
          runCommand,
          rpcClient,
        )
  const fakeServiceAta = await ensureAta(
    mintAddress,
    fakeServiceAddress,
    resolved,
    paths.platformFeePayer,
    runCommand,
    rpcClient,
  )
  const agentTokenBalance =
    agentAta === undefined
      ? undefined
      : await ensureTokenBalance(
          mintAddress,
          agentAta,
          resolved.tokenTargetAtomic,
          resolved,
          paths.platformFeePayer,
          runCommand,
          rpcClient,
        )

  const finalFeePayerSol = await getSolBalance(rpcClient, feePayerAddress)
  const finalAgentSol =
    agentAddress === undefined
      ? undefined
      : await getSolBalance(rpcClient, agentAddress)

  return publicSetupResult({
    config: resolved,
    feePayerAddress,
    feePayerSol: finalFeePayerSol,
    agentAddress,
    agentSol: finalAgentSol,
    agentAta,
    agentTokenBalance,
    fakeServiceAddress,
    fakeServiceAta,
    mintAddress,
  })
}

async function readExistingPublicIdentity(filePath, label, runCommand) {
  if (!existsSync(filePath)) return undefined
  assertRegularKeypairFile(filePath)
  return parsePublicKey(runCommand('solana-keygen', ['pubkey', filePath]), label)
}

export async function statusDevnetX402(options = {}) {
  const resolved = resolveDevnetX402Config(options)
  const paths = resolveDevnetX402Paths(resolved.homeDirectory)
  const runCommand = options.runCommand ?? createCommandRunner()
  const rpcClient = options.rpcClient ?? createRpcClient(resolved.rpcUrl)
  await assertDevnetRpc(rpcClient)

  const feePayerAddress = await readExistingPublicIdentity(
    paths.platformFeePayer,
    'Platform Fee Payer',
    runCommand,
  )
  const agentAddress = resolved.agentAddress
  const fakeServiceAddress = await readExistingPublicIdentity(
    paths.fakeService,
    'fake service destination',
    runCommand,
  )
  const mintAddress = await readExistingPublicIdentity(
    paths.mint,
    `${TEST_USDC_SYMBOL} mint`,
    runCommand,
  )

  const feePayerSol =
    feePayerAddress === undefined
      ? undefined
      : await getSolBalance(rpcClient, feePayerAddress)
  const agentSol =
    agentAddress === undefined
      ? undefined
      : await getSolBalance(rpcClient, agentAddress)
  const mintReady =
    mintAddress === undefined ? false : await mintIsReady(rpcClient, mintAddress)

  let agentAta
  let fakeServiceAta
  let fakeServiceAtaReady = false
  let agentTokenBalance
  if (mintReady && agentAddress !== undefined && fakeServiceAddress !== undefined) {
    agentAta = await associatedTokenAddress(
      mintAddress,
      agentAddress,
      resolved,
      runCommand,
    )
    fakeServiceAta = await associatedTokenAddress(
      mintAddress,
      fakeServiceAddress,
      resolved,
      runCommand,
    )
    const agentAccount = await getAccountInfo(rpcClient, agentAta, 'jsonParsed')
    const fakeServiceAccount = await getAccountInfo(
      rpcClient,
      fakeServiceAta,
      'jsonParsed',
    )
    fakeServiceAtaReady = tokenAccountIsReady(
      fakeServiceAccount,
      mintAddress,
      fakeServiceAddress,
    )
    if (tokenAccountIsReady(agentAccount, mintAddress, agentAddress)) {
      agentTokenBalance = await getTokenBalance(rpcClient, agentAta)
    }
  }

  return {
    network: DEVNET_X402_NETWORK,
    rpcUrl: resolved.rpcUrl,
    ready:
      feePayerAddress !== undefined &&
      fakeServiceAddress !== undefined &&
      mintReady &&
      agentAta !== undefined &&
      fakeServiceAta !== undefined &&
      fakeServiceAtaReady &&
      agentTokenBalance !== undefined &&
      feePayerSol !== undefined &&
      feePayerSol >= resolved.solTargetLamports &&
      agentTokenBalance >= resolved.tokenTargetAtomic,
    platformFeePayer:
      feePayerAddress === undefined
        ? undefined
        : { address: feePayerAddress, solBalance: formatAtomicAmount(feePayerSol, 9) },
    agentAccount:
      agentAddress === undefined
        ? undefined
        : {
            address: agentAddress,
            solBalance:
              agentSol === undefined ? undefined : formatAtomicAmount(agentSol, 9),
            tokenAccount: agentAta,
            tokenBalance:
              agentTokenBalance === undefined
                ? undefined
                : formatAtomicAmount(agentTokenBalance, TEST_USDC_DECIMALS),
          },
    facilitatorFeePayer: feePayerAddress === undefined ? undefined : feePayerAddress,
    fakeService:
      fakeServiceAddress === undefined
        ? undefined
        : { destination: fakeServiceAddress, tokenAccount: fakeServiceAta },
    settlementAsset:
      mintAddress === undefined
        ? undefined
        : {
            symbol: TEST_USDC_SYMBOL,
            decimals: TEST_USDC_DECIMALS,
            mint: mintAddress,
            ready: mintReady,
            economicValue: 'none',
          },
  }
}

function isMainModule() {
  return (
    process.argv[1] !== undefined &&
    pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
  )
}

async function main() {
  const action = process.argv[2]
  if (action === '--help' || action === undefined) {
    process.stdout.write(
      'Usage: node scripts/devnet-x402.mjs <setup|status>\n' +
        'Environment: DEVNET_X402_AGENT_ADDRESS, DEVNET_X402_RPC_URL, DEVNET_X402_HOME, DEVNET_X402_SOL_TARGET, DEVNET_X402_TOKEN_TARGET\n',
    )
    return
  }
  if (action !== 'setup' && action !== 'status') {
    throw new DevnetX402SetupError('Usage: node scripts/devnet-x402.mjs <setup|status>')
  }
  const result = action === 'setup' ? await setupDevnetX402() : await statusDevnetX402()
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

if (isMainModule()) {
  main().catch((error) => {
    const message =
      error instanceof Error ? error.message : 'Unknown devnet harness failure'
    process.stderr.write(`devnet-x402: ${message}\n`)
    process.exitCode = 1
  })
}
