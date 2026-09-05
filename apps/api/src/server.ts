import 'dotenv/config'

import { createDatabaseClient } from '@agent-payment/db'

import { buildApp } from './app.js'
import { loadConfig, redactConfig } from './config.js'

async function startServer(): Promise<void> {
  const config = loadConfig()
  const database = createDatabaseClient(config.databaseUrl)
  const app = buildApp({ config, readinessDependency: database })

  app.addHook('onClose', async () => {
    await database.disconnect()
  })

  try {
    await app.listen({ host: '0.0.0.0', port: config.port })
    app.log.info({ config: redactConfig(config) }, 'API started')
  } catch (error) {
    app.log.error({ err: error }, 'API failed to start')
    await app.close()
    throw error
  }
}

await startServer()
