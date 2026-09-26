import { createDevnetFacilitator } from './facilitator.js'
import { createFakeX402App } from './app.js'
import { loadFakeX402Config } from './config.js'
import { assertDevnetRpc, createDevnetRpc } from './rpc.js'

const config = loadFakeX402Config()
const rpc = createDevnetRpc(config.rpcUrl)
const facilitatorSecret = process.env.FAKE_X402_FACILITATOR_SECRET?.trim()
let app: ReturnType<typeof createFakeX402App> | undefined

try {
  await assertDevnetRpc(rpc)
  const submitter = await createDevnetFacilitator({
    config,
    rpc,
    ...(facilitatorSecret === undefined || facilitatorSecret.length === 0
      ? {}
      : { secret: facilitatorSecret }),
  })
  app = createFakeX402App({
    config,
    rpc,
    submitter,
    logger: true,
  })
  await app.listen({ host: config.host, port: config.port })
  app.log.info(
    {
      host: config.host,
      port: config.port,
      network: config.network,
      resourceUrl: config.resourceUrl,
    },
    'local fake x402 service listening',
  )
} catch (error) {
  if (app !== undefined) {
    app.log.error({ err: error }, 'local fake x402 service failed to start')
    await app.close()
  } else {
    const message = error instanceof Error ? error.message : 'unknown startup failure'
    process.stderr.write(`local fake x402 service failed to start: ${message}\n`)
  }
  process.exitCode = 1
}

const close = async () => {
  if (app !== undefined) {
    await app.close()
  }
}

process.once('SIGINT', close)
process.once('SIGTERM', close)
