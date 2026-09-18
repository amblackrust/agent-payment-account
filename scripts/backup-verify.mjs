import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

import {
  assertDistinctDatabaseIdentity,
  assertFreshRuntimeAuthority,
} from './restore-safety.mjs'

const command = process.argv[2]

if (command === 'backup') {
  createBackup(process.argv[3])
} else if (command === 'verify') {
  verifyBackup(process.argv[3])
} else if (command === 'complete-reconciliation') {
  completeReconciliation(process.argv[3])
} else {
  throw new Error(
    'Usage: node scripts/backup-verify.mjs backup <encrypted-output> | verify <encrypted-input> | complete-reconciliation <evidence-reference>',
  )
}

function createBackup(outputArgument) {
  const databaseUrl = requiredEnvironment('DATABASE_URL')
  const recipient = requiredEnvironment('BACKUP_AGE_RECIPIENT')
  const output = requiredArgument(outputArgument, 'encrypted output path')
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), 'mux-backup-'))
  const dumpPath = path.join(temporaryDirectory, 'database.dump')

  try {
    mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 })
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
  const custodyIdentity = requiredEnvironment('BACKUP_VERIFY_CUSTODY_IDENTITY')
  const runtimeAuthorityId = requiredEnvironment('BACKUP_VERIFY_RUNTIME_AUTHORITY_ID')
  const environment =
    process.env.BACKUP_VERIFY_ENVIRONMENT?.trim() || 'isolated-restore'
  const input = requiredArgument(inputArgument, 'encrypted input path')
  if (environment === 'production') {
    throw new Error('Backup verification must target a non-production environment')
  }
  const sourceDatabaseIdentity = readDatabaseIdentity(sourceDatabaseUrl)
  const targetDatabaseIdentity = readDatabaseIdentity(targetDatabaseUrl)
  assertDistinctDatabaseIdentity(sourceDatabaseIdentity, targetDatabaseIdentity)
  const sourceRuntimeAuthority = readRuntimeAuthority(sourceDatabaseUrl)

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
    const restoredRuntimeAuthority = readRuntimeAuthority(targetDatabaseUrl)
    assertFreshRuntimeAuthority(
      sourceRuntimeAuthority,
      restoredRuntimeAuthority,
      runtimeAuthorityId,
    )
    runSql(targetDatabaseUrl, setRestoredRuntimePendingSql(), {
      runtime_authority: runtimeAuthorityId,
    })
    const summary = runSql(targetDatabaseUrl, restoreInvariantQuery(), {
      runtime_authority: runtimeAuthorityId,
      custody_identity: custodyIdentity,
    })
    const values = summary.split('\t').map((value) => Number(value))
    if (
      values.length !== 15 ||
      values.some((value) => !Number.isInteger(value) || value < 0) ||
      values[0] < 10 ||
      values[1] !== 0 ||
      values[2] !== 0 ||
      values[3] !== 1 ||
      values[4] !== 1 ||
      values[5] !== 1 ||
      values.slice(10).some((value) => value !== 0)
    ) {
      throw new Error(`Restore invariant validation failed: ${summary}`)
    }
    const invariantSummary = JSON.stringify({
      required_table_count: values[0],
      invalid_held_reservations: values[1],
      missing_attempt_links: values[2],
      runtime_identity_rows: values[3],
      runtime_authority_rows: values[4],
      custody_identity_rows: values[5],
      payment_rows: values[6],
      reservation_rows: values[7],
      evidence_rows: values[8],
      credential_rows: values[9],
      invalid_payment_metadata: values[10],
      invalid_reservation_links: values[11],
      invalid_evidence_metadata: values[12],
      invalid_credential_metadata: values[13],
      invalid_recovery_envelopes: values[14],
    })
    runSql(
      targetDatabaseUrl,
      `BEGIN;
       INSERT INTO backup_restore_verifications
         (id, backup_reference, environment, status, schema_version, invariant_summary_json, custody_identity, verified_at)
       VALUES (:'id', :'backup_reference', :'environment', 'VERIFIED', :'schema_version', :'summary', :'custody_identity', NOW());
       INSERT INTO operation_timeline_events
         (id, account_id, resource_type, resource_id, event_type, actor_type, source, occurred_at, new_state_json)
       VALUES (
         'timeline_restore_' || :'id',
         NULL,
         'RESTORE_VERIFICATION',
         :'id',
         'RESTORE_VERIFICATION_PASSED',
         'SYSTEM',
         'BACKUP_RESTORE_VERIFIER',
         NOW(),
         jsonb_build_object(
           'backup_reference', :'backup_reference',
           'environment', :'environment',
           'schema_version', :'schema_version',
           'custody_identity_present', TRUE,
           'invariant_summary_present', TRUE
         )::TEXT
       );
       COMMIT;`,
      {
        id: verificationId,
        backup_reference: backupReference,
        environment,
        schema_version: 'prisma-verified',
        summary: invariantSummary,
        custody_identity: custodyIdentity,
      },
    )
    runSql(
      targetDatabaseUrl,
      `UPDATE "RuntimeMetadata"
          SET "value" = 'RESTORE_RECONCILIATION_REQUIRED', "updatedAt" = NOW()
        WHERE "key" = 'money_worker_gate'`,
    )
    process.stdout.write(
      `Restore verification passed for ${backupReference}; external reconciliation is required before promotion\n`,
    )
  } catch (error) {
    try {
      runSql(
        targetDatabaseUrl,
        `BEGIN;
         INSERT INTO backup_restore_verifications
           (id, backup_reference, environment, status, schema_version, failure_safe)
         VALUES (:'id', :'backup_reference', :'environment', 'FAILED', 'restore-check', :'failure');
         INSERT INTO operation_timeline_events
           (id, account_id, resource_type, resource_id, event_type, actor_type, source, occurred_at, new_state_json)
         VALUES (
           'timeline_restore_' || :'id',
           NULL,
           'RESTORE_VERIFICATION',
           :'id',
           'RESTORE_VERIFICATION_FAILED',
           'SYSTEM',
           'BACKUP_RESTORE_VERIFIER',
           NOW(),
           jsonb_build_object(
             'backup_reference', :'backup_reference',
             'environment', :'environment',
             'failure_present', TRUE
           )::TEXT
         );
         COMMIT;`,
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
      process.stderr.write('Restore verification failure could not be recorded\n')
    }
    throw error
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true })
  }
}

function completeReconciliation(evidenceArgument) {
  const databaseUrl = requiredEnvironment('BACKUP_VERIFY_DATABASE_URL')
  const environment = requiredEnvironment('BACKUP_VERIFY_ENVIRONMENT')
  const custodyIdentity = requiredEnvironment('BACKUP_VERIFY_CUSTODY_IDENTITY')
  const runtimeAuthorityId = requiredEnvironment('BACKUP_VERIFY_RUNTIME_AUTHORITY_ID')
  const verificationId = process.env.BACKUP_VERIFY_VERIFICATION_ID?.trim() || ''
  const evidenceReference = requiredArgument(
    evidenceArgument,
    'reconciliation evidence reference',
  )
  if (environment === 'production') {
    throw new Error(
      'Restore reconciliation must be completed in the promoted non-production gate environment',
    )
  }
  runSql(databaseUrl, completeReconciliationSql(), {
    environment,
    custody_identity: custodyIdentity,
    runtime_authority: runtimeAuthorityId,
    evidence: evidenceReference,
    verification_id: verificationId,
  })
  process.stdout.write(
    `Restore reconciliation evidence ${evidenceReference} recorded; money workers may be promoted\n`,
  )
}

function completeReconciliationSql() {
  return `BEGIN;
  SELECT
    set_config('mux_restore.environment', :'environment', false),
    set_config('mux_restore.custody_identity', :'custody_identity', false),
    set_config('mux_restore.runtime_authority', :'runtime_authority', false),
    set_config('mux_restore.evidence', :'evidence', false),
    set_config('mux_restore.verification_id', :'verification_id', false);
  DO $restore_reconciliation_fence$
  DECLARE
    requested_environment TEXT := current_setting('mux_restore.environment');
    requested_custody_identity TEXT := current_setting('mux_restore.custody_identity');
    requested_runtime_authority TEXT := current_setting('mux_restore.runtime_authority');
    requested_evidence TEXT := current_setting('mux_restore.evidence');
    requested_verification_id TEXT := current_setting('mux_restore.verification_id');
    gate_status TEXT;
    authority_value TEXT;
    latest_id TEXT;
    latest_backup_reference TEXT;
    latest_environment TEXT;
    latest_status TEXT;
    latest_custody_identity TEXT;
    latest_verified_at TIMESTAMPTZ;
    existing_evidence JSONB;
    expected_evidence JSONB;
  BEGIN
    SELECT value
      INTO gate_status
      FROM "RuntimeMetadata"
     WHERE "key" = 'money_worker_gate'
     FOR UPDATE;

    SELECT value
      INTO authority_value
      FROM "RuntimeMetadata"
     WHERE "key" = 'runtime_authority';

    SELECT id, backup_reference, environment, status, custody_identity, verified_at
      INTO latest_id, latest_backup_reference, latest_environment, latest_status,
        latest_custody_identity, latest_verified_at
      FROM backup_restore_verifications
     ORDER BY created_at DESC, id DESC
     LIMIT 1;

    IF latest_id IS NULL
      OR latest_status IS DISTINCT FROM 'VERIFIED'
      OR latest_verified_at IS NULL THEN
      RAISE EXCEPTION 'No current verified restore exists for reconciliation';
    END IF;
    IF latest_environment IS DISTINCT FROM requested_environment
      OR latest_custody_identity IS DISTINCT FROM requested_custody_identity THEN
      RAISE EXCEPTION 'Current restore verification does not match the requested environment or custody identity';
    END IF;
    IF authority_value IS DISTINCT FROM requested_runtime_authority THEN
      RAISE EXCEPTION 'Runtime authority does not match the requested restore authority';
    END IF;
    IF requested_verification_id <> ''
      AND requested_verification_id IS DISTINCT FROM latest_id THEN
      RAISE EXCEPTION 'Requested restore verification is stale or does not match the current verification';
    END IF;

    expected_evidence := jsonb_build_object(
      'reference', requested_evidence,
      'verification_id', latest_id,
      'backup_reference', latest_backup_reference,
      'environment', requested_environment,
      'custody_identity', requested_custody_identity,
      'runtime_authority', requested_runtime_authority
    );

    IF gate_status = 'RESTORE_VERIFIED' THEN
      SELECT value::jsonb
        INTO existing_evidence
        FROM "RuntimeMetadata"
       WHERE "key" = 'restore_reconciliation_evidence';
      IF existing_evidence IS NULL
        OR existing_evidence->>'reference' IS DISTINCT FROM expected_evidence->>'reference'
        OR existing_evidence->>'verification_id' IS DISTINCT FROM expected_evidence->>'verification_id'
        OR existing_evidence->>'backup_reference' IS DISTINCT FROM expected_evidence->>'backup_reference'
        OR existing_evidence->>'environment' IS DISTINCT FROM expected_evidence->>'environment'
        OR existing_evidence->>'custody_identity' IS DISTINCT FROM expected_evidence->>'custody_identity'
        OR existing_evidence->>'runtime_authority' IS DISTINCT FROM expected_evidence->>'runtime_authority' THEN
        RAISE EXCEPTION 'Restore reconciliation is already complete with different evidence';
      END IF;
      RETURN;
    END IF;

    IF gate_status IS DISTINCT FROM 'RESTORE_RECONCILIATION_REQUIRED' THEN
      RAISE EXCEPTION 'Restore reconciliation requires money_worker_gate=RESTORE_RECONCILIATION_REQUIRED';
    END IF;

    INSERT INTO "RuntimeMetadata" ("key", "value", "createdAt", "updatedAt")
      VALUES ('restore_reconciliation_evidence', expected_evidence::TEXT, NOW(), NOW())
      ON CONFLICT ("key") DO UPDATE
        SET "value" = EXCLUDED."value", "updatedAt" = NOW()
      WHERE "RuntimeMetadata"."value" = EXCLUDED."value";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Restore reconciliation evidence already exists with different contents';
    END IF;

    UPDATE "RuntimeMetadata"
       SET "value" = 'RESTORE_VERIFIED', "updatedAt" = NOW()
     WHERE "key" = 'money_worker_gate'
       AND "value" = 'RESTORE_RECONCILIATION_REQUIRED';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Restore reconciliation gate changed before completion';
    END IF;
  END
  $restore_reconciliation_fence$;
  INSERT INTO operation_timeline_events
    (id, account_id, resource_type, resource_id, event_type, actor_type, source, occurred_at, new_state_json)
  SELECT
    'timeline_rr_' || verification.id,
    NULL,
    'RESTORE_VERIFICATION',
    verification.id,
    'RESTORE_RECONCILIATION_COMPLETED',
    'OPERATOR',
    'BACKUP_RESTORE_VERIFIER',
    NOW(),
    jsonb_build_object(
      'evidence_reference', current_setting('mux_restore.evidence'),
      'verification_id', verification.id,
      'environment', verification.environment
    )::TEXT
  FROM backup_restore_verifications verification
  WHERE verification.id = CASE
    WHEN current_setting('mux_restore.verification_id') <> ''
      THEN current_setting('mux_restore.verification_id')
    ELSE (
      SELECT id
      FROM backup_restore_verifications
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    )
  END
  ON CONFLICT (id) DO NOTHING;
  COMMIT;`
}

function restoreInvariantQuery() {
  return `SELECT
    (SELECT count(*) FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN (
          'agent_accounts', 'payments', 'payment_attempts', 'outgoing_reservations',
          'evidence_records', 'operation_timeline_events', 'operational_exceptions',
          'webhook_events', 'backup_restore_verifications', 'RuntimeMetadata'
        )) AS required_table_count,
    (SELECT count(*) FROM outgoing_reservations r
      JOIN payments p ON p.id = r.payment_id
      WHERE r.lifecycle_state = 'HELD' AND p.execution_state = 'TERMINAL') AS invalid_held_reservations,
    (SELECT count(*) FROM payment_attempts a
      LEFT JOIN payments p ON p.id = a.payment_id
      WHERE p.id IS NULL) AS missing_attempt_links,
    (SELECT count(*) FROM "RuntimeMetadata" WHERE "key" = 'runtime_identity') AS runtime_identity_rows,
    (SELECT count(*) FROM "RuntimeMetadata"
      WHERE "key" = 'runtime_authority' AND "value" = :'runtime_authority') AS runtime_authority_rows,
    (SELECT count(*) FROM "RuntimeMetadata"
      WHERE "key" = 'runtime_identity'
        AND "value"::jsonb ->> 'custodyBackendIdentity' = :'custody_identity') AS custody_identity_rows,
    (SELECT count(*) FROM payments) AS payment_rows,
    (SELECT count(*) FROM outgoing_reservations) AS reservation_rows,
    (SELECT count(*) FROM evidence_records) AS evidence_rows,
    (SELECT count(*) FROM api_credentials) AS credential_rows,
    (SELECT count(*) FROM payments
      WHERE amount_atomic < 0
        OR currency = ''
        OR jsonb_typeof(metadata_json::jsonb) <> 'object') AS invalid_payment_metadata,
    (SELECT count(*) FROM outgoing_reservations r
      LEFT JOIN payments p ON p.id = r.payment_id
      WHERE p.id IS NULL OR r.owner_account_id <> p.payer_account_id) AS invalid_reservation_links,
    (SELECT count(*) FROM evidence_records e
      LEFT JOIN payments p ON p.id = e.payment_id
      LEFT JOIN payment_attempts a ON a.id = e.attempt_id
      WHERE p.id IS NULL
        OR (e.attempt_id IS NOT NULL AND a.id IS NULL)
        OR (a.id IS NOT NULL AND a.payment_id <> e.payment_id)
        OR jsonb_typeof(e.metadata_json::jsonb) <> 'object') AS invalid_evidence_metadata,
    (SELECT count(*) FROM api_credentials
      WHERE key_hash = ''
        OR key_prefix = ''
        OR jsonb_typeof(scopes::jsonb) <> 'array') AS invalid_credential_metadata,
    (SELECT count(*) FROM credential_recovery_envelopes e
      LEFT JOIN api_credentials c ON c.id = e.credential_id
      WHERE c.id IS NULL
        OR c.account_id <> e.account_id
        OR e.ciphertext = ''
        OR e.nonce = ''
        OR e.auth_tag = '') AS invalid_recovery_envelopes;`
}

function setRestoredRuntimePendingSql() {
  return `INSERT INTO "RuntimeMetadata" ("key", "value", "createdAt", "updatedAt")
    VALUES ('money_worker_gate', 'RESTORE_PENDING', NOW(), NOW())
    ON CONFLICT ("key") DO UPDATE
      SET "value" = EXCLUDED."value", "updatedAt" = NOW();
  INSERT INTO "RuntimeMetadata" ("key", "value", "createdAt", "updatedAt")
    VALUES ('runtime_authority', :'runtime_authority', NOW(), NOW())
    ON CONFLICT ("key") DO UPDATE
      SET "value" = EXCLUDED."value", "updatedAt" = NOW();`
}

function runSql(databaseUrl, sql, variables = {}) {
  const args = [
    '--no-psqlrc',
    '--set=ON_ERROR_STOP=1',
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

function readDatabaseIdentity(databaseUrl) {
  return runSql(
    databaseUrl,
    `SELECT current_database() || E'\\t' ||
      COALESCE(inet_server_addr()::TEXT, 'local') || E'\\t' ||
      COALESCE(inet_server_port()::TEXT, current_setting('port'));`,
  )
}

function readRuntimeAuthority(databaseUrl) {
  const authority = runSql(
    databaseUrl,
    `SELECT "value"
       FROM "RuntimeMetadata"
      WHERE "key" = 'runtime_authority';`,
  )
  if (authority.length === 0) {
    throw new Error('Database has no persisted runtime authority')
  }
  return authority
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
