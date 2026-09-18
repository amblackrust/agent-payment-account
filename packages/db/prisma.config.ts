import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { config as loadDotenv, parse as parseDotenv } from 'dotenv'
import { defineConfig } from 'prisma/config'

import {
  assertDotenvIsNotProduction,
  requireDatabaseUrl,
  shouldLoadLocalDotenv,
} from './prisma-env.js'

const dotenvPath = path.join(process.cwd(), '.env')

if (shouldLoadLocalDotenv() && existsSync(dotenvPath)) {
  assertDotenvIsNotProduction(parseDotenv(readFileSync(dotenvPath, 'utf8')))
  loadDotenv({ path: dotenvPath })
}

const databaseUrl = requireDatabaseUrl()

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: databaseUrl,
  },
})
