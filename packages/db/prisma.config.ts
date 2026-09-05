import 'dotenv/config'
import { defineConfig } from 'prisma/config'

import { requireDatabaseUrl } from './prisma-env.js'

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
