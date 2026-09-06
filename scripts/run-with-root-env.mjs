import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { loadEnvFile } from 'node:process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const environmentPath = path.join(repositoryRoot, '.env')
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

if (existsSync(environmentPath)) loadEnvFile(environmentPath)

if (requiredVariable !== undefined && !process.env[requiredVariable]?.trim()) {
  console.error(`${requiredVariable} is required.`)
  process.exit(1)
}

const executable =
  process.platform === 'win32' && command === 'pnpm' ? 'pnpm.cmd' : command
const result = spawnSync(executable, args, {
  cwd: repositoryRoot,
  env: process.env,
  stdio: 'inherit',
})

if (result.error !== undefined) {
  console.error(`Unable to start ${command}: ${result.error.message}`)
  process.exit(1)
}

process.exit(result.status ?? 1)
