import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

import { parse as parseDotenv } from 'dotenv'
import { buildChildProcessEnvironment } from './child-environment.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const environmentPath = path.join(repositoryRoot, '.env')
const projectVariableNames = [
  'DATABASE_URL',
  'PORT',
  'NODE_ENV',
  'ADMIN_API_KEY',
  'SOLANA_RPC_URL',
  'SOLANA_CLUSTER',
  'SOLANA_SETTLEMENT_MINT',
  'SOLANA_PLATFORM_COST_ASSET_ID',
  'SOLANA_FEE_PAYER_SECRET',
  'SOLANA_FEE_PAYER_IDENTITY',
  'X402_RESOURCE_URL',
  'X402_HTTP_TIMEOUT_MS',
  'X402_MAX_PAYMENT_ATOMIC',
  'WALLET_MASTER_KEY',
  'RECOVERY_ENVELOPE_KEY',
  'RUNTIME_ROLE',
  'RUNTIME_AUTHORITY_ID',
  'RESTORE_GATE_REQUIRED',
  'RESTORE_GATE_ENVIRONMENT',
  'CUSTODY_BACKEND_IDENTITY',
  'CUSTODY_BACKEND_MODE',
  'WORKER_BATCH_SIZE',
  'WORKER_INTERVAL_MS',
  'WORKER_LEASE_SECONDS',
  'SHUTDOWN_TIMEOUT_MS',
  'INCOMING_ACCOUNT_CONCURRENCY',
  'REQUEST_RATE_LIMIT_WINDOW_SECONDS',
  'REQUEST_RATE_LIMIT_PER_WINDOW',
  'REQUEST_BURST_WINDOW_SECONDS',
  'REQUEST_BURST_LIMIT',
  'PAYMENT_RATE_LIMIT_PER_WINDOW',
  'RECEIVE_RATE_LIMIT_PER_WINDOW',
  'CAPACITY_WINDOW_SECONDS',
  'DATABASE_CAPACITY_PER_WINDOW',
  'RPC_CAPACITY_PER_WINDOW',
  'CUSTODY_CAPACITY_PER_WINDOW',
  'RAIL_CAPACITY_PER_WINDOW',
  'WEBHOOK_CAPACITY_PER_WINDOW',
  'WEBHOOK_BATCH_SIZE',
  'WEBHOOK_LEASE_SECONDS',
  'WEBHOOK_MAX_ATTEMPTS',
  'WEBHOOK_TIMEOUT_MS',
  'WEBHOOK_SIGNING_KEYS_JSON',
  'CREDENTIAL_RECOVERY_TTL_SECONDS',
  'MAX_PAGE_SIZE',
  'REVIEW_REQUIRED_BACKLOG_ALERT_THRESHOLD',
  'REVIEW_REQUIRED_AGE_ALERT_SECONDS',
  'NO_PROGRESS_ALERT_SECONDS',
  'DATABASE_SATURATION_ALERT_RATIO',
  'WEBHOOK_BACKLOG_ALERT_THRESHOLD',
  'BACKUP_AGE_RECIPIENT',
  'BACKUP_AGE_IDENTITY',
  'BACKUP_VERIFY_DATABASE_URL',
  'BACKUP_VERIFY_ENVIRONMENT',
  'BACKUP_VERIFY_CUSTODY_IDENTITY',
  'BACKUP_VERIFY_RUNTIME_AUTHORITY_ID',
  'BACKUP_VERIFY_VERIFICATION_ID',
  'BACKUP_OUTPUT_DIRECTORY',
  'BACKUP_INTERVAL_SECONDS',
  'ALLOW_MAINNET',
]
export function buildChildEnvironment(
  parsedEnvironment,
  sourceEnvironment,
  environmentExists,
  fallbackVariable,
) {
  const childEnvironment = buildChildProcessEnvironment({}, sourceEnvironment)
  for (const name of projectVariableNames) {
    const value = parsedEnvironment[name]
    if (value !== undefined) childEnvironment[name] = value
  }
  if (!environmentExists && fallbackVariable !== undefined) {
    const value = sourceEnvironment[fallbackVariable]
    if (value !== undefined) childEnvironment[fallbackVariable] = value
  }
  return childEnvironment
}

function isMainModule() {
  const entrypoint = process.argv[1]
  return (
    entrypoint !== undefined &&
    pathToFileURL(path.resolve(entrypoint)).href === import.meta.url
  )
}

function main() {
  const launcherArgs = process.argv.slice(2)
  const environmentOptional = launcherArgs[0] === '--optional'
  if (environmentOptional) launcherArgs.shift()
  const requiredVariableArgument = launcherArgs[0]?.startsWith('--require=')
    ? launcherArgs.shift()
    : undefined
  const requiredVariable = requiredVariableArgument?.slice('--require='.length)
  const [command, ...args] = launcherArgs

  if (command === undefined) {
    console.error('No command was provided to the root environment launcher.')
    process.exit(1)
  }

  const environmentExists = existsSync(environmentPath)
  if (!environmentExists && !environmentOptional) {
    console.error(
      'Root .env not found. Run "pnpm local:setup" or create it from .env.example.',
    )
    process.exit(1)
  }

  const parsedEnvironment = environmentExists
    ? parseDotenv(readFileSync(environmentPath, 'utf8'))
    : {}
  if (
    process.env.NODE_ENV?.trim() === 'production' ||
    parsedEnvironment.NODE_ENV?.trim() === 'production'
  ) {
    console.error(
      'The root .env launcher is for local development only; production must use its secret backend.',
    )
    process.exit(1)
  }
  const childEnvironment = buildChildEnvironment(
    parsedEnvironment,
    process.env,
    environmentExists,
    requiredVariable,
  )

  if (requiredVariable !== undefined && !childEnvironment[requiredVariable]?.trim()) {
    console.error(`${requiredVariable} is required.`)
    process.exit(1)
  }

  const executable =
    process.platform === 'win32' && command === 'pnpm' ? 'pnpm.cmd' : command
  const result = spawnSync(executable, args, {
    cwd: repositoryRoot,
    env: childEnvironment,
    stdio: 'inherit',
  })

  if (result.error !== undefined) {
    console.error(`Unable to start ${command}: ${result.error.message}`)
    process.exit(1)
  }

  process.exit(result.status ?? 1)
}

if (isMainModule()) main()
