import { spawnSync } from 'node:child_process'

const composeFile = 'docker-compose.e2e.yml'
const projectName = 'agent-payment-account-verify-' + process.pid
const databaseUrl =
  process.env.VERIFY_DATABASE_URL ??
  'postgresql://postgres:postgres@127.0.0.1:55432/agent_payment_account?schema=public'
const composePrefix = ['compose', '-f', composeFile, '-p', projectName]

function run(command, args, environment = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    env: { ...process.env, ...environment },
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(
      command +
        ' ' +
        args.join(' ') +
        ' exited with status ' +
        (result.status ?? 'unknown'),
    )
  }
}

function stopDatabase() {
  const result = spawnSync(
    'docker',
    [...composePrefix, 'down', '-v', '--remove-orphans'],
    { stdio: 'inherit', env: process.env },
  )
  if (result.error !== undefined || result.status !== 0) {
    process.exitCode = 1
  }
}

try {
  run('docker', [...composePrefix, 'up', '-d', '--wait', 'postgres'])
  run('pnpm', ['--filter', '@agent-payment/db', 'migrate:deploy'], {
    DATABASE_URL: databaseUrl,
  })
  run('pnpm', ['lint'])
  run('pnpm', ['typecheck'])
  run('pnpm', ['test'], { DATABASE_URL: databaseUrl })
  run('pnpm', ['build'])
  run('pnpm', ['test:solana:raw'], { DATABASE_URL: databaseUrl })
} finally {
  stopDatabase()
}
