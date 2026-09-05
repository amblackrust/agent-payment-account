export class DatabaseConfigurationError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = 'DatabaseConfigurationError'
  }
}

export function requireDatabaseUrl(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const databaseUrl = environment.DATABASE_URL?.trim()
  if (!databaseUrl) {
    throw new DatabaseConfigurationError('DATABASE_URL is required for Prisma tooling')
  }
  return databaseUrl
}
