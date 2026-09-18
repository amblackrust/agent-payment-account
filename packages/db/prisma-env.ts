export class DatabaseConfigurationError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = 'DatabaseConfigurationError'
  }
}

export function shouldLoadLocalDotenv(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return environment.NODE_ENV?.trim() !== 'production'
}

export function assertDotenvIsNotProduction(environment: NodeJS.ProcessEnv): void {
  if (environment.NODE_ENV?.trim() === 'production') {
    throw new DatabaseConfigurationError(
      'The Prisma .env loader is for local development only; production must use its secret backend',
    )
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
