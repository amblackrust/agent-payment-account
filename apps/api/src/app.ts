import Fastify, { type FastifyInstance } from 'fastify'

import type { AppConfig } from './config.js'

export interface ReadinessDependency {
  checkReadiness(): Promise<void>
}

export interface BuildAppOptions {
  readonly config: AppConfig
  readonly readinessDependency: ReadinessDependency
}

interface ErrorWithCode {
  readonly code?: string
  readonly statusCode?: number
  readonly validation?: unknown
}

const healthResponseSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', const: 'ok' },
  },
  required: ['status'],
} as const

function getErrorStatusCode(error: ErrorWithCode): number {
  if (error.validation !== undefined) {
    return 400
  }

  switch (error.code) {
    case 'AUTHENTICATION_ERROR':
      return 401
    case 'INSUFFICIENT_FUNDS':
    case 'CONFLICT':
      return 409
    case 'UNSUPPORTED_CURRENCY':
    case 'RECIPIENT_RESOLUTION_FAILURE':
    case 'UNSUPPORTED_RAIL':
    case 'VALIDATION_ERROR':
      return 422
    case 'EXTERNAL_RAIL_FAILURE':
      return 502
    default:
      return error.statusCode ?? 500
  }
}

function getErrorResponse(error: ErrorWithCode & Error, statusCode: number) {
  const isInternal = statusCode >= 500
  return {
    statusCode,
    error: error.code ?? 'INTERNAL_ERROR',
    message: isInternal ? 'Internal Server Error' : error.message,
  }
}

export function buildApp(options: BuildAppOptions): FastifyInstance {
  const app = Fastify({
    logger: {
      level: options.config.nodeEnv === 'development' ? 'debug' : 'info',
      redact: [
        'req.headers.authorization',
        'req.headers.x-api-key',
        'headers.authorization',
        'headers.x-api-key',
      ],
    },
  })

  app.get(
    '/health',
    { schema: { response: { 200: healthResponseSchema } } },
    async () => ({
      status: 'ok',
    }),
  )

  app.get(
    '/ready',
    {
      schema: {
        response: {
          200: healthResponseSchema,
          503: {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: { type: 'string', const: 'not_ready' },
            },
            required: ['status'],
          },
        },
      },
    },
    async (_request, reply) => {
      try {
        await options.readinessDependency.checkReadiness()
        return { status: 'ok' }
      } catch (error) {
        app.log.error({ err: error }, 'Readiness check failed')
        return reply.code(503).send({ status: 'not_ready' })
      }
    },
  )

  app.setErrorHandler((error: Error & ErrorWithCode, _request, reply) => {
    const statusCode = getErrorStatusCode(error)
    return reply.code(statusCode).send(getErrorResponse(error, statusCode))
  })

  return app
}
