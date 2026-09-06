import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { parse as parseDotenv } from 'dotenv'

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
  'SOLANA_FEE_PAYER_SECRET',
  'WALLET_MASTER_KEY',
  'ALLOW_MAINNET',
]
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

if (!existsSync(environmentPath) && !environmentOptional) {
  console.error(
    'Root .env not found. Run "pnpm local:setup" or create it from .env.example.',
  )
  process.exit(1)
}

const parsedEnvironment = existsSync(environmentPath)
  ? parseDotenv(readFileSync(environmentPath, 'utf8'))
  : {}
const projectEnvironment = Object.fromEntries(
  projectVariableNames.flatMap((name) =>
    parsedEnvironment[name] === undefined ? [] : [[name, parsedEnvironment[name]]],
  ),
)
// Repository configuration overrides stale project values inherited from the shell.
// Unrelated system variables such as PATH, HOME, and TMP remain untouched.
const childEnvironment = { ...process.env, ...projectEnvironment }

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
