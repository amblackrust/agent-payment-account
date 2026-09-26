const BACKUP_CHILD_ENVIRONMENT_KEYS = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'TZ',
  'TMPDIR',
  'SystemRoot',
  'WINDIR',
  'ComSpec',
  'PATHEXT',
  'PGSERVICE',
  'PGSERVICEFILE',
  'PGSYSCONFDIR',
  'PGPASSFILE',
  'PGSSLROOTCERT',
  'PGSSLCERT',
  'PGSSLKEY',
  'PGSSLMODE',
  'PGAPPNAME',
  'PGPASSWORD',
  'PGSSLPASSWORD',
] as const

interface BackupChildEnvironmentInput {
  readonly databaseUrl: string
  readonly recipient: string
  readonly identity?: string
  readonly verifyDatabaseUrl?: string
  readonly runtimeAuthorityId?: string
  readonly custodyIdentity?: string
}

export function buildBackupChildEnvironment(
  input: BackupChildEnvironmentInput,
  sourceEnvironment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {}
  for (const name of BACKUP_CHILD_ENVIRONMENT_KEYS) {
    const value = sourceEnvironment[name]
    if (value !== undefined) environment[name] = value
  }
  environment.DATABASE_URL = input.databaseUrl
  environment.BACKUP_AGE_RECIPIENT = input.recipient
  if (input.identity !== undefined) {
    environment.BACKUP_AGE_IDENTITY = input.identity
  }
  if (input.verifyDatabaseUrl !== undefined) {
    environment.BACKUP_VERIFY_DATABASE_URL = input.verifyDatabaseUrl
  }
  if (input.runtimeAuthorityId !== undefined) {
    environment.BACKUP_VERIFY_RUNTIME_AUTHORITY_ID = input.runtimeAuthorityId
  }
  if (input.custodyIdentity !== undefined) {
    environment.BACKUP_VERIFY_CUSTODY_IDENTITY = input.custodyIdentity
  }
  return environment
}
