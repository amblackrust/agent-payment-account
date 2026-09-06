import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parse as parseDotenv } from 'dotenv'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const localDirectory = path.join(repositoryRoot, '.local')
const ledgerPath = path.join(localDirectory, 'solana-ledger')
const feePayerPath = path.join(localDirectory, 'fee-payer.json')
const mintPath = path.join(localDirectory, 'mint.json')
const validatorStatePath = path.join(localDirectory, 'solana-validator.json')
const validatorLogPath = path.join(localDirectory, 'solana-validator.log')
const environmentPath = path.join(repositoryRoot, '.env')
const rpcUrl = 'http://127.0.0.1:8899'
const tokenProgramAddress = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const settlementDecimals = 6
const minimumFeePayerLamports = 10_000_000n
const airdropSol = '100'
const commandTimeoutMs = 30_000
const startupTimeoutMs = 45_000
const localEnvironmentDefaults = {
  DATABASE_URL:
    'postgresql://postgres:postgres@127.0.0.1:5432/agent_payment_account?schema=public',
  PORT: '3000',
  NODE_ENV: 'development',
  SOLANA_RPC_URL: rpcUrl,
  SOLANA_CLUSTER: 'localnet',
  ALLOW_MAINNET: 'false',
}
const placeholderValues = new Set([
  'replace-with-a-local-admin-key',
  'replace-with-local-token-mint',
  'replace-with-64-byte-fee-payer-secret',
  'replace-with-32-byte-hex-master-key',
])

class LocalSetupError extends Error {
  constructor(message) {
    super(message)
    this.name = 'LocalSetupError'
  }
}

function executableName(command) {
  return process.platform === 'win32' && command === 'pnpm' ? 'pnpm.cmd' : command
}

function run(command, args, options = {}) {
  const result = spawnSync(executableName(command), args, {
    cwd: repositoryRoot,
    env: { ...process.env, NO_DNA: '1', ...options.environment },
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
    timeout: options.timeoutMs ?? 120_000,
  })

  if (result.error !== undefined) {
    throw new LocalSetupError(`Unable to run ${command}: ${result.error.message}`)
  }
  if (result.status !== 0) {
    const detail = options.capture ? result.stderr.trim() : ''
    throw new LocalSetupError(
      `${command} ${args.join(' ')} failed${detail === '' ? '' : `: ${detail}`}`,
    )
  }
  return options.capture ? result.stdout.trim() : ''
}

function commandSucceeds(command, args) {
  const result = spawnSync(executableName(command), args, {
    cwd: repositoryRoot,
    env: { ...process.env, NO_DNA: '1' },
    stdio: 'ignore',
    timeout: commandTimeoutMs,
  })
  return result.status === 0
}

function majorVersion(version) {
  const match = version.match(/(\d+)/)
  return match === null ? undefined : Number(match[1])
}

function checkPrerequisites() {
  const checks = [
    {
      label: 'Node.js 22+',
      command: process.execPath,
      args: ['--version'],
      minimumMajor: 22,
      install: 'Install it first: https://nodejs.org/',
    },
    {
      label: 'pnpm 11+',
      command: 'pnpm',
      args: ['--version'],
      minimumMajor: 11,
      install: 'Install it first: https://pnpm.io/installation',
    },
    {
      label: 'Docker',
      command: 'docker',
      args: ['--version'],
      install: 'Install it first: https://docs.docker.com/engine/install/',
    },
    {
      label: 'Docker Compose',
      command: 'docker',
      args: ['compose', 'version'],
      install: 'Install it first: https://docs.docker.com/compose/install/',
    },
    {
      label: 'Solana CLI',
      command: 'solana',
      args: ['--version'],
      install: 'Install it first: https://solana.com/docs/intro/installation',
    },
    {
      label: 'solana-test-validator',
      command: 'solana-test-validator',
      args: ['--version'],
      install:
        'Install it with the Solana CLI: https://solana.com/docs/intro/installation',
    },
    {
      label: 'solana-keygen',
      command: 'solana-keygen',
      args: ['--version'],
      install:
        'Install it with the Solana CLI: https://solana.com/docs/intro/installation',
    },
    {
      label: 'spl-token',
      command: 'spl-token',
      args: ['--version'],
      install: 'Install it first: cargo install spl-token-cli',
    },
  ]

  for (const check of checks) {
    const result = spawnSync(executableName(check.command), check.args, {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: commandTimeoutMs,
    })
    if (result.error !== undefined || result.status !== 0) {
      throw new LocalSetupError(`Missing ${check.label}.\n${check.install}`)
    }
    if (check.minimumMajor !== undefined) {
      const detectedMajor = majorVersion(result.stdout)
      if (detectedMajor === undefined || detectedMajor < check.minimumMajor) {
        throw new LocalSetupError(
          `${check.label} is required; found ${result.stdout.trim()}.\n${check.install}`,
        )
      }
    }
  }

  if (!commandSucceeds('docker', ['info'])) {
    throw new LocalSetupError(
      'Docker is installed, but the Docker daemon is not available.',
    )
  }
}

function readEnvironment() {
  if (!existsSync(environmentPath)) return { content: '', values: {} }
  const content = readFileSync(environmentPath, 'utf8')
  return { content, values: parseDotenv(content) }
}

function isMissingOrPlaceholder(value) {
  return value === undefined || value.trim() === '' || placeholderValues.has(value)
}

function parseSecretKey(value, variableName) {
  let bytes
  try {
    if (value.trim().startsWith('[')) {
      bytes = JSON.parse(value)
    } else if (/^[0-9a-fA-F]{128}$/.test(value.trim())) {
      bytes = [...Buffer.from(value.trim(), 'hex')]
    } else {
      bytes = [...Buffer.from(value.trim(), 'base64')]
    }
  } catch {
    throw new LocalSetupError(`${variableName} is not a valid Solana secret key.`)
  }
  if (
    !Array.isArray(bytes) ||
    bytes.length !== 64 ||
    bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)
  ) {
    throw new LocalSetupError(`${variableName} must encode exactly 64 bytes.`)
  }
  return bytes
}

function writePrivateFile(filePath, content) {
  writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o600 })
  chmodSync(filePath, 0o600)
}

function ensureFeePayer(environmentValues) {
  if (!existsSync(feePayerPath)) {
    const configuredSecret = environmentValues.SOLANA_FEE_PAYER_SECRET
    if (!isMissingOrPlaceholder(configuredSecret)) {
      const bytes = parseSecretKey(configuredSecret, 'SOLANA_FEE_PAYER_SECRET')
      writePrivateFile(feePayerPath, `${JSON.stringify(bytes)}\n`)
    } else {
      run(
        'solana-keygen',
        ['new', '--silent', '--no-bip39-passphrase', '--outfile', feePayerPath],
        { capture: true },
      )
      chmodSync(feePayerPath, 0o600)
    }
  }

  const bytes = parseSecretKey(readFileSync(feePayerPath, 'utf8'), 'local fee payer')
  const configuredSecret = environmentValues.SOLANA_FEE_PAYER_SECRET
  if (!isMissingOrPlaceholder(configuredSecret)) {
    const configuredBytes = parseSecretKey(configuredSecret, 'SOLANA_FEE_PAYER_SECRET')
    if (!Buffer.from(bytes).equals(Buffer.from(configuredBytes))) {
      throw new LocalSetupError(
        'SOLANA_FEE_PAYER_SECRET does not match .local/fee-payer.json. Refusing to overwrite either secret.',
      )
    }
  }
  return JSON.stringify(bytes)
}

function publicKey(keypairPath) {
  return run('solana-keygen', ['pubkey', keypairPath], { capture: true })
}

function ensureMintKeypair(environmentValues) {
  const configuredMint = environmentValues.SOLANA_SETTLEMENT_MINT
  if (!existsSync(mintPath)) {
    if (!isMissingOrPlaceholder(configuredMint)) {
      throw new LocalSetupError(
        'SOLANA_SETTLEMENT_MINT is already customized, but .local/mint.json is absent. Move the custom .env aside to create an automated local environment.',
      )
    }
    run(
      'solana-keygen',
      ['new', '--silent', '--no-bip39-passphrase', '--outfile', mintPath],
      { capture: true },
    )
    chmodSync(mintPath, 0o600)
  }
  const address = publicKey(mintPath)
  if (!isMissingOrPlaceholder(configuredMint) && configuredMint !== address) {
    throw new LocalSetupError(
      'SOLANA_SETTLEMENT_MINT does not match .local/mint.json. Refusing to overwrite the configured mint.',
    )
  }
  return address
}

function replaceOrAppend(content, key, value) {
  const expression = new RegExp(`^(?:export\\s+)?${key}\\s*=.*$`, 'm')
  if (expression.test(content)) return content.replace(expression, `${key}=${value}`)
  const separator = content === '' || content.endsWith('\n') ? '' : '\n'
  return `${content}${separator}${key}=${value}\n`
}

function requireLocalValue(values, key, expected) {
  const configured = values[key]
  if (!isMissingOrPlaceholder(configured) && configured !== expected) {
    throw new LocalSetupError(
      `${key} is already set to a non-local value. Refusing to modify the existing .env.`,
    )
  }
}

function validateLocalEnvironment(existing) {
  for (const [key, value] of Object.entries(localEnvironmentDefaults)) {
    requireLocalValue(existing.values, key, value)
  }
  if (
    !existsSync(mintPath) &&
    !isMissingOrPlaceholder(existing.values.SOLANA_SETTLEMENT_MINT)
  ) {
    throw new LocalSetupError(
      'SOLANA_SETTLEMENT_MINT is already customized, but .local/mint.json is absent. Move the custom .env aside to create an automated local environment.',
    )
  }
}

function writeLocalEnvironment(existing, generated) {
  const adminApiKey = isMissingOrPlaceholder(existing.values.ADMIN_API_KEY)
    ? randomBytes(32).toString('hex')
    : existing.values.ADMIN_API_KEY
  const walletMasterKey = isMissingOrPlaceholder(existing.values.WALLET_MASTER_KEY)
    ? randomBytes(32).toString('hex')
    : existing.values.WALLET_MASTER_KEY
  if (!/^[0-9a-fA-F]{64}$/.test(walletMasterKey)) {
    throw new LocalSetupError(
      'WALLET_MASTER_KEY in .env must be 64 hexadecimal characters.',
    )
  }

  const values = {
    ...localEnvironmentDefaults,
    ADMIN_API_KEY: adminApiKey,
    SOLANA_SETTLEMENT_MINT: generated.mintAddress,
    SOLANA_FEE_PAYER_SECRET: generated.feePayerSecret,
    WALLET_MASTER_KEY: walletMasterKey,
  }
  let content = existing.content
  if (content === '') {
    content = '# Generated by pnpm local:setup. LOCAL DEVELOPMENT ONLY.\n'
  }
  for (const [key, value] of Object.entries(values)) {
    const configured = existing.values[key]
    if (isMissingOrPlaceholder(configured))
      content = replaceOrAppend(content, key, value)
  }
  writePrivateFile(environmentPath, content)
  return { ...existing.values, ...values }
}

async function rpc(method, params = [], timeoutMs = 2_000) {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new Error(`RPC returned HTTP ${response.status}`)
  const payload = await response.json()
  if (payload.error !== undefined) throw new Error('RPC request failed')
  return payload.result
}

async function getGenesisHash() {
  try {
    return await rpc('getGenesisHash')
  } catch {
    return undefined
  }
}

function readValidatorState() {
  if (!existsSync(validatorStatePath)) return undefined
  try {
    const state = JSON.parse(readFileSync(validatorStatePath, 'utf8'))
    if (Number.isInteger(state.pid) && typeof state.genesisHash === 'string')
      return state
  } catch {
    return undefined
  }
  return undefined
}

function processExists(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(check, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new LocalSetupError(`Timed out waiting for ${description}.`)
}

async function ensureValidator() {
  const currentGenesisHash = await getGenesisHash()
  const state = readValidatorState()
  if (currentGenesisHash !== undefined) {
    if (state?.genesisHash === currentGenesisHash) return
    throw new LocalSetupError(
      `${rpcUrl} is already serving a Solana validator not managed by this checkout. Stop it or use the manual configuration path.`,
    )
  }
  if (state !== undefined && processExists(state.pid)) {
    await waitFor(
      async () => (await getGenesisHash()) !== undefined,
      startupTimeoutMs,
      'Solana',
    )
    const genesisHash = await getGenesisHash()
    writePrivateFile(
      validatorStatePath,
      `${JSON.stringify({ pid: state.pid, genesisHash }, null, 2)}\n`,
    )
    return
  }

  mkdirSync(localDirectory, { recursive: true, mode: 0o700 })
  const logFile = openSync(validatorLogPath, 'a', 0o600)
  const validator = spawn(
    'solana-test-validator',
    [
      '--ledger',
      ledgerPath,
      '--rpc-port',
      '8899',
      '--bind-address',
      '127.0.0.1',
      '--gossip-host',
      '127.0.0.1',
      '--faucet-port',
      '9900',
      '--quiet',
    ],
    {
      cwd: repositoryRoot,
      detached: true,
      env: { ...process.env, NO_DNA: '1' },
      stdio: ['ignore', logFile, logFile],
    },
  )
  validator.unref()
  closeSync(logFile)
  if (validator.pid === undefined) {
    throw new LocalSetupError('Unable to start solana-test-validator.')
  }
  writePrivateFile(
    validatorStatePath,
    `${JSON.stringify({ pid: validator.pid, genesisHash: '' }, null, 2)}\n`,
  )

  await waitFor(
    async () => (await getGenesisHash()) !== undefined,
    startupTimeoutMs,
    'Solana',
  )
  const genesisHash = await getGenesisHash()
  writePrivateFile(
    validatorStatePath,
    `${JSON.stringify({ pid: validator.pid, genesisHash }, null, 2)}\n`,
  )
}

function postgresReady() {
  return commandSucceeds('docker', [
    'compose',
    'exec',
    '-T',
    'postgres',
    'pg_isready',
    '-U',
    'postgres',
    '-d',
    'agent_payment_account',
  ])
}

async function ensurePostgres() {
  run('docker', ['compose', 'up', '-d', 'postgres'])
  await waitFor(async () => postgresReady(), startupTimeoutMs, 'PostgreSQL')
}

async function feePayerBalance(address) {
  const result = await rpc('getBalance', [address, { commitment: 'confirmed' }])
  return BigInt(result.value)
}

async function ensureFeePayerFunded(address) {
  if ((await feePayerBalance(address)) >= minimumFeePayerLamports) return
  run('solana', ['airdrop', airdropSol, address, '--url', rpcUrl], {
    capture: true,
  })
  await waitFor(
    async () => (await feePayerBalance(address)) >= minimumFeePayerLamports,
    commandTimeoutMs,
    'fee-payer funding',
  )
}

async function mintIsReady(address) {
  try {
    const result = await rpc('getAccountInfo', [address, { encoding: 'base64' }])
    if (result.value === null || result.value.owner !== tokenProgramAddress)
      return false
    const data = Buffer.from(result.value.data[0], 'base64')
    return data.length === 82 && data[44] === settlementDecimals && data[45] === 1
  } catch {
    return false
  }
}

async function ensureSettlementMint(address, feePayerAddress) {
  if (await mintIsReady(address)) return
  run(
    'spl-token',
    [
      'create-token',
      mintPath,
      '--decimals',
      String(settlementDecimals),
      '--fee-payer',
      feePayerPath,
      '--mint-authority',
      feePayerAddress,
      '--url',
      rpcUrl,
      '--output',
      'json-compact',
    ],
    { capture: true },
  )
  await waitFor(() => mintIsReady(address), commandTimeoutMs, 'settlement mint')
}

async function apiReady() {
  try {
    const response = await fetch('http://127.0.0.1:3000/ready', {
      signal: AbortSignal.timeout(2_000),
    })
    if (!response.ok) return false
    const payload = await response.json()
    return payload.status === 'ok'
  } catch {
    return false
  }
}

async function feePayerIsReady(solanaReady) {
  if (!solanaReady || !existsSync(feePayerPath)) return false
  try {
    return (await feePayerBalance(publicKey(feePayerPath))) >= minimumFeePayerLamports
  } catch {
    return false
  }
}

function statusLine(label, ready, unavailableLabel = 'NOT RUNNING') {
  console.log(`${label.padEnd(20)}${ready ? 'READY' : unavailableLabel}`)
}

async function showStatus() {
  const environment = readEnvironment()
  const genesisHash = await getGenesisHash()
  const validatorState = readValidatorState()
  const solanaReady =
    genesisHash !== undefined && validatorState?.genesisHash === genesisHash
  const mintAddress = environment.values.SOLANA_SETTLEMENT_MINT
  const feePayerReady = await feePayerIsReady(solanaReady)

  console.log('Mux local status\n')
  statusLine('PostgreSQL', postgresReady())
  statusLine('Solana', solanaReady)
  statusLine(
    'Settlement mint',
    solanaReady && mintAddress !== undefined ? await mintIsReady(mintAddress) : false,
    'NOT READY',
  )
  statusLine('Fee payer', feePayerReady, 'NOT READY')
  statusLine('Mux API', await apiReady())
}

function processMatchesValidator(pid) {
  if (process.platform === 'linux') {
    const commandLinePath = `/proc/${pid}/cmdline`
    if (!existsSync(commandLinePath)) return false
    const commandLine = readFileSync(commandLinePath, 'utf8').replaceAll('\0', ' ')
    return (
      commandLine.includes('solana-test-validator') && commandLine.includes(ledgerPath)
    )
  }
  if (process.platform === 'darwin') {
    const result = spawnSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: commandTimeoutMs,
    })
    return (
      result.status === 0 &&
      result.stdout.includes('solana-test-validator') &&
      result.stdout.includes(ledgerPath)
    )
  }
  return false
}

async function stopValidator() {
  const state = readValidatorState()
  if (state === undefined || !processExists(state.pid)) {
    if (existsSync(validatorStatePath)) rmSync(validatorStatePath)
    return false
  }
  if (!processMatchesValidator(state.pid)) {
    throw new LocalSetupError(
      `PID ${state.pid} no longer belongs to this project's validator; refusing to stop it.`,
    )
  }
  process.kill(process.platform === 'win32' ? state.pid : -state.pid, 'SIGTERM')
  await waitFor(
    async () => !processExists(state.pid),
    commandTimeoutMs,
    'Solana shutdown',
  )
  rmSync(validatorStatePath)
  return true
}

async function setup() {
  console.log('Mux local setup\n')
  checkPrerequisites()
  console.log('✓ Prerequisites available')

  const existingEnvironment = readEnvironment()
  validateLocalEnvironment(existingEnvironment)
  mkdirSync(localDirectory, { recursive: true, mode: 0o700 })
  const feePayerSecret = ensureFeePayer(existingEnvironment.values)
  const feePayerAddress = publicKey(feePayerPath)
  const mintAddress = ensureMintKeypair(existingEnvironment.values)
  const environment = writeLocalEnvironment(existingEnvironment, {
    feePayerSecret,
    mintAddress,
  })
  console.log('✓ Platform fee payer ready')
  console.log('✓ Local environment written')

  await Promise.all([ensurePostgres(), ensureValidator()])
  console.log('✓ PostgreSQL running')
  console.log('✓ Local Solana running')

  await ensureFeePayerFunded(feePayerAddress)
  console.log('✓ Fee payer funded with local SOL')
  await ensureSettlementMint(mintAddress, feePayerAddress)
  console.log('✓ Settlement mint ready')

  run('pnpm', ['db:migrate:deploy'], { environment })
  console.log('✓ Database migrations applied')

  console.log(`\nSettlement mint: ${mintAddress}`)
  console.log(`Fee payer address: ${feePayerAddress}`)
  console.log('\nLocal environment ready.\n\nStart Mux:\n\n  pnpm dev')
}

async function down() {
  console.log('Mux local shutdown\n')
  const validatorStopped = await stopValidator()
  const postgresWasRunning = postgresReady()
  run('docker', ['compose', 'stop', 'postgres'])
  console.log(
    `${validatorStopped ? '✓' : '·'} Solana validator ${validatorStopped ? 'stopped' : 'was not running'}`,
  )
  console.log(
    `${postgresWasRunning ? '✓' : '·'} PostgreSQL ${postgresWasRunning ? 'stopped' : 'was not running'}`,
  )
  console.log('\nLocal data, keypairs, and .env were preserved.')
}

const action = process.argv[2]

try {
  if (action === 'setup') await setup()
  else if (action === 'status') await showStatus()
  else if (action === 'down') await down()
  else throw new LocalSetupError('Usage: node scripts/local.mjs <setup|status|down>')
} catch (error) {
  const message =
    error instanceof Error ? error.message : 'Unknown local tooling failure'
  console.error(`\nLocal tooling failed: ${message}`)
  if (existsSync(validatorLogPath)) {
    console.error(
      `See ${path.relative(repositoryRoot, validatorLogPath)} for validator logs.`,
    )
  }
  process.exitCode = 1
}
