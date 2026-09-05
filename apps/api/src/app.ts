import Fastify, { type FastifyInstance } from 'fastify'
import { AuthenticationError, ValidationError } from '@agent-payment/core'
import type { AccountRepository } from '@agent-payment/db'
import type { SolanaRail } from '@agent-payment/solana-rail'

import type { AppConfig } from './config.js'
import { serializeAccountCreation, serializeReceiveDestination } from './accounts.js'
import type { AccountService } from './accounts.js'
import { assertAdminApiKey, authenticateAgent } from './auth.js'

export interface ReadinessDependency {
  checkReadiness(): Promise<void>
}

export interface BuildAppOptions {
  readonly config: AppConfig
  readonly readinessDependency: ReadinessDependency
  readonly accountRepository?: AccountRepository
  readonly accountService?: AccountService
  readonly solanaRail?: SolanaRail
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
        'req.headers.x-admin-api-key',
        'headers.authorization',
        'headers.x-api-key',
        'headers.x-admin-api-key',
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

  if (
    options.accountRepository !== undefined &&
    options.accountService !== undefined &&
    options.solanaRail !== undefined
  ) {
    const { accountRepository, accountService, solanaRail } = options
    app.decorateRequest('agentAccount', null)

    app.post<{ Body: { name: string } }>(
      '/v1/accounts',
      {
        schema: {
          body: {
            type: 'object',
            additionalProperties: false,
            properties: { name: { type: 'string', minLength: 1, maxLength: 120 } },
            required: ['name'],
          },
        },
      },
      async (request) => {
        assertAdminApiKey(request, options.config.adminApiKey)
        return serializeAccountCreation(
          await accountService.createAccount(request.body.name),
        )
      },
    )

    app.post<{ Params: { accountId: string; credentialId: string } }>(
      '/v1/accounts/:accountId/credentials/:credentialId/revoke',
      {
        schema: {
          params: {
            type: 'object',
            additionalProperties: false,
            properties: {
              accountId: { type: 'string', minLength: 1 },
              credentialId: { type: 'string', minLength: 1 },
            },
            required: ['accountId', 'credentialId'],
          },
        },
      },
      async (request, reply) => {
        assertAdminApiKey(request, options.config.adminApiKey)
        const revoked = await accountRepository.revokeCredential(
          request.params.accountId,
          request.params.credentialId,
        )
        if (!revoked) {
          throw new ValidationError('Credential was not found or already revoked')
        }
        return reply.send({ status: 'REVOKED' })
      },
    )

    app.get(
      '/v1/balance',
      { preHandler: async (request) => authenticateAgent(request, accountRepository) },
      async (request) => {
        const account = request.agentAccount
        if (account === null) {
          throw new AuthenticationError()
        }
        const balance = await solanaRail.getSettlementBalance(
          account.account.solanaPublicKey,
        )
        return {
          currency: balance.currency,
          settled: balance.settled,
          pending_outgoing: '0.00',
          available: balance.settled,
        }
      },
    )

    app.post<{ Body: { currency: 'USD' } }>(
      '/v1/receives',
      {
        preHandler: async (request) => authenticateAgent(request, accountRepository),
        schema: {
          body: {
            type: 'object',
            additionalProperties: false,
            properties: { currency: { type: 'string', const: 'USD' } },
            required: ['currency'],
          },
        },
      },
      async (request) => {
        if (request.body.currency !== 'USD') {
          throw new ValidationError('Only USD receive instructions are supported')
        }
        const account = request.agentAccount
        if (account === null) {
          throw new AuthenticationError()
        }
        return serializeReceiveDestination(
          await solanaRail.getReceiveDestination(account.account.solanaPublicKey),
          account.account.id,
        )
      },
    )
  }

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
      } catch {
        app.log.error('Readiness check failed')
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
