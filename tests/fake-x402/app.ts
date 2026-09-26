import Fastify, { type FastifyInstance } from 'fastify'
import {
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from '@x402/core/http'
import type { PaymentRequired, SettleResponse } from '@x402/core/types'
import type { FakeX402Config } from './config.js'
import type { FakeX402Rpc } from './rpc.js'
import {
  createFakeX402PaymentVerifier,
  FakeX402VerificationError,
  type FakeX402PaymentSubmitter,
} from './verification.js'

const RESOURCE_DESCRIPTION = 'Deterministic local fake x402 bitcoin price'
const RESOURCE_MIME_TYPE = 'application/json'
const PRICE_RESPONSE = Object.freeze({ bitcoin: Object.freeze({ usd: 60_000 }) })

export interface FakeX402AppOptions {
  readonly config: FakeX402Config
  readonly rpc: FakeX402Rpc
  readonly submitter?: FakeX402PaymentSubmitter
  readonly logger?: boolean
}

export function createFakeX402App(options: FakeX402AppOptions): FastifyInstance {
  const verifier = createFakeX402PaymentVerifier(options)
  let settlementResponseDropped = false
  const app = Fastify({
    logger:
      options.logger === true
        ? {
            redact: ['req.headers.payment-signature', 'req.headers.authorization'],
          }
        : false,
  })

  app.get('/healthz', async () => ({ status: 'ok' }))

  app.get<{
    readonly Querystring: { readonly ids: string }
  }>(
    '/api/crypto/price',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: { ids: { type: 'string', const: 'bitcoin' } },
          required: ['ids'],
          additionalProperties: false,
        },
        response: {
          200: {
            type: 'object',
            properties: {
              bitcoin: {
                type: 'object',
                properties: { usd: { type: 'integer', const: 60_000 } },
                required: ['usd'],
                additionalProperties: false,
              },
            },
            required: ['bitcoin'],
            additionalProperties: false,
          },
        },
      },
    },
    async (request, reply) => {
      const paymentSignature = request.headers['payment-signature']
      if (typeof paymentSignature !== 'string') {
        return sendPaymentRequired(reply, options.config, 'PAYMENT_REQUIRED', 402)
      }

      try {
        const verified = await verifier.verify(paymentSignature)
        if (options.config.dropResponseAfterSettlement && !settlementResponseDropped) {
          settlementResponseDropped = true
          reply.hijack()
          request.raw.destroy()
          return
        }
        const settlement: SettleResponse = {
          success: true,
          transaction: verified.transactionSignature,
          network: options.config.network,
          payer: verified.payer,
        }
        return reply
          .code(200)
          .header('PAYMENT-RESPONSE', encodePaymentResponseHeader(settlement))
          .send(PRICE_RESPONSE)
      } catch (error) {
        const verificationError =
          error instanceof FakeX402VerificationError
            ? error
            : new FakeX402VerificationError(
                'RPC_UNAVAILABLE',
                'The fake x402 service could not verify the payment',
              )
        if (options.logger === true) {
          request.log.warn(
            { code: verificationError.code },
            'fake x402 payment verification rejected',
          )
        }
        const responseStatus =
          verificationError.code === 'DUPLICATE_PAYMENT' ? 409 : 402
        return sendPaymentRequired(
          reply,
          options.config,
          verificationError.code,
          responseStatus,
        )
      }
    },
  )

  return app
}

function sendPaymentRequired(
  reply: {
    code(statusCode: number): typeof reply
    header(name: string, value: string): typeof reply
    send(payload: unknown): unknown
  },
  config: FakeX402Config,
  error: string,
  statusCode: number,
): unknown {
  const paymentRequired: PaymentRequired = {
    x402Version: 2,
    error,
    resource: {
      url: config.resourceUrl,
      description: RESOURCE_DESCRIPTION,
      mimeType: RESOURCE_MIME_TYPE,
      serviceName: 'mux-local-fake-x402',
    },
    accepts: [
      {
        scheme: 'exact',
        network: config.network,
        amount: config.amountAtomic.toString(),
        asset: config.settlementMint,
        payTo: config.destination,
        maxTimeoutSeconds: config.maxTimeoutSeconds,
        extra: {
          feePayer: config.facilitatorFeePayer,
          decimals: config.tokenDecimals,
        },
      },
    ],
  }
  return reply
    .code(statusCode)
    .header('PAYMENT-REQUIRED', encodePaymentRequiredHeader(paymentRequired))
    .send({ error })
}
