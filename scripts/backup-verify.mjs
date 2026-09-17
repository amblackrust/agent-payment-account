import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

const command = process.argv[2]

if (command === 'backup') {
  createBackup(process.argv[3])
} else if (command === 'verify') {
  verifyBackup(process.argv[3])
} else {
  throw new Error(
    'Usage: node scripts/backup-verify.mjs backup <encrypted-output> | verify <encrypted-input>',
  )
}

function createBackup(outputArgument) {
  const databaseUrl = requiredEnvironment('DATABASE_URL')
  const recipient = requiredEnvironment('BACKUP_AGE_RECIPIENT')
  const output = requiredArgument(outputArgument, 'encrypted output path')
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), 'mux-backup-'))
  const dumpPath = path.join(temporaryDirectory, 'database.dump')

  try {
    run('pg_dump', [
      '--format=custom',
      '--no-owner',
      '--no-privileges',
      '--file',
      dumpPath,
      databaseUrl,
    ])
    run('age', ['--encrypt', '--recipient', recipient, '--output', output, dumpPath])
    chmodSync(output, 0o600)
    process.stdout.write(`Encrypted backup created at ${output}\n`)
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true })
  }
}

function verifyBackup(inputArgument) {
  const sourceDatabaseUrl = requiredEnvironment('DATABASE_URL')
  const targetDatabaseUrl = requiredEnvironment('BACKUP_VERIFY_DATABASE_URL')
  const identity = requiredEnvironment('BACKUP_AGE_IDENTITY')
  const environment =
    process.env.BACKUP_VERIFY_ENVIRONMENT?.trim() || 'isolated-restore'
  const input = requiredArgument(inputArgument, 'encrypted input path')
  if (environment === 'production') {
    throw new Error('Backup verification must target a non-production environment')
  }
  if (targetDatabaseUrl === sourceDatabaseUrl) {
    throw new Error(
      'Backup verification target must be isolated from the source database',
    )
  }

  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), 'mux-restore-'))
  const dumpPath = path.join(temporaryDirectory, 'database.dump')
  const verificationId = `backup_verify_${randomBytes(16).toString('hex')}`
  const backupReference = path.basename(input)

  try {
    run('age', ['--decrypt', '--identity', identity, '--output', dumpPath, input])
    run('pg_restore', [
      '--clean',
      '--if-exists',
      '--exit-on-error',
      '--no-owner',
      '--no-privileges',
      '--dbname',
      targetDatabaseUrl,
      dumpPath,
    ])
    const summary = runSql(targetDatabaseUrl, restoreInvariantQuery())
    const values = summary.split('\t').map((value) => Number(value))
    if (
      values.length !== 4 ||
      values.some((value) => !Number.isInteger(value) || value < 0) ||
      values[0] < 10 ||
      values[1] !== 0 ||
      values[2] !== 0 ||
      values[3] !== 1
    ) {
      throw new Error(`Restore invariant validation failed: ${summary}`)
    }
    const invariantSummary = JSON.stringify({
      required_table_count: values[0],
      invalid_held_reservations: values[1],
      missing_attempt_links: values[2],
      runtime_identity_rows: values[3],
    })
    runSql(
      targetDatabaseUrl,
      `INSERT INTO backup_restore_verifications
        (id, backup_reference, environment, status, schema_version, invariant_summary_json, verified_at)
       VALUES (:'id', :'backup_reference', :'environment', 'VERIFIED', :'schema_version', :'summary', NOW())`,
      {
        id: verificationId,
        backup_reference: backupReference,
        environment,
        schema_version: 'prisma-verified',
        summary: invariantSummary,
      },
    )
    process.stdout.write(`Restore verification passed for ${backupReference}\n`)
  } catch (error) {
    try {
      runSql(
        targetDatabaseUrl,
        `INSERT INTO backup_restore_verifications
          (id, backup_reference, environment, status, schema_version, failure_safe)
         VALUES (:'id', :'backup_reference', :'environment', 'FAILED', 'restore-check', :'failure')`,
        {
          id: verificationId,
          backup_reference: backupReference,
          environment,
          failure: safeError(error),
        },
      )
    } catch {
      // A restore that never produced a usable schema cannot record its own
      // verification row; the original failure remains the actionable result.
    }
    throw error
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true })
  }
}

function restoreInvariantQuery() {
  return `SELECT
    (SELECT count(*) FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN (
          'agent_accounts', 'payments', 'payment_attempts', 'outgoing_reservations',
          'evidence_records', 'operation_timeline_events', 'operational_exceptions',
          'webhook_events', 'backup_restore_verifications', 'runtime_metadata'
        )) AS required_table_count,
    (SELECT count(*) FROM outgoing_reservations r
      JOIN payments p ON p.id = r.payment_id
      WHERE r.lifecycle_state = 'HELD' AND p.execution_state = 'TERMINAL') AS invalid_held_reservations,
    (SELECT count(*) FROM payment_attempts a
      LEFT JOIN payments p ON p.id = a.payment_id
      WHERE p.id IS NULL) AS missing_attempt_links,
    (SELECT count(*) FROM runtime_metadata WHERE key = 'runtime_identity') AS runtime_identity_rows;`
}

function runSql(databaseUrl, sql, variables = {}) {
  const args = [
    '--no-psqlrc',
    '--quiet',
    '--tuples-only',
    '--no-align',
    '--field-separator',
    '\t',
    '--dbname',
    databaseUrl,
  ]
  for (const [key, value] of Object.entries(variables))
    args.push('--variable', `${key}=${value}`)
  args.push('--command', sql)
  return run('psql', args).trim()
}

function run(commandName, args) {
  return execFileSync(commandName, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim()
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`)
  return value
}

function requiredArgument(value, description) {
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`A ${description} is required`)
  }
  return value
}

function safeError(error) {
  return error instanceof Error
    ? error.message.slice(0, 500)
    : 'restore verification failed'
}
