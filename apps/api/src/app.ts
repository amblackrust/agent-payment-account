import Fastify, { type FastifyInstance } from 'fastify'
import {
  AuthenticationError,
  formatMoney,
  moneyFromAtomicUnits,
  ValidationError,
} from '@agent-payment/core'
import type { AccountRepository, ReservationRepository } from '@agent-payment/db'
import type { SolanaRail } from '@agent-payment/solana-rail'

import type { AppConfig } from './config.js'
import { serializeAccountCreation, serializeReceiveDestination } from './accounts.js'
import type { AccountService } from './accounts.js'
import { assertAdminApiKey, authenticateAgent } from './auth.js'
import { serializePayment } from './payments.js'
import type { PaymentService } from './payments.js'
import { serializeRecipient } from './recipients.js'
import type { RecipientService } from './recipients.js'
import type { ReceiveService } from './receives.js'
import type { TransactionService } from './transactions.js'

export interface ReadinessDependency {
  checkReadiness(): Promise<void>
}

export interface BuildAppOptions {
  readonly config: AppConfig
  readonly readinessDependency: ReadinessDependency
  readonly accountRepository?: AccountRepository
  readonly accountService?: AccountService
  readonly solanaRail?: SolanaRail
  readonly recipientService?: RecipientService
  readonly paymentService?: PaymentService
  readonly reservationRepository?: ReservationRepository
  readonly receiveService?: ReceiveService
  readonly transactionService?: TransactionService
}

interface ErrorWithCode {
  readonly code?: string
  readonly details?: Readonly<Record<string, string>>
  readonly statusCode?: number
  readonly validation?: unknown
  readonly kind?: string
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
    case 'REFUND_NOT_SUPPORTED':
    case 'VALIDATION_ERROR':
      return 422
    case 'EXTERNAL_RAIL_FAILURE':
      return error.kind === 'DETERMINISTIC' ? 422 : 502
    default:
      return error.statusCode ?? 500
  }
}

function getErrorResponse(error: ErrorWithCode & Error, statusCode: number) {
  const isInternal = statusCode >= 500
  const response = {
    statusCode,
    error: error.code ?? 'INTERNAL_ERROR',
    message: isInternal ? 'Internal Server Error' : error.message,
  }
  return error.details === undefined
    ? response
    : { ...response, details: error.details }
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

  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id)
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

    app.post<{ Params: { accountId: string } }>(
      '/v1/accounts/:accountId/credentials',
      {
        schema: {
          params: {
            type: 'object',
            additionalProperties: false,
            properties: { accountId: { type: 'string', minLength: 1 } },
            required: ['accountId'],
          },
        },
      },
      async (request, reply) => {
        assertAdminApiKey(request, options.config.adminApiKey)
        if (
          accountRepository.findAccountSummary === undefined ||
          accountService.createCredential === undefined
        ) {
          throw new Error('Credential management is unavailable')
        }
        if (
          (await accountRepository.findAccountSummary(request.params.accountId)) ===
          null
        ) {
          throw new ValidationError('Account was not found')
        }
        const credential = await accountService.createCredential(
          request.params.accountId,
        )
        return reply.code(201).send({
          credential_id: credential.id,
          account_id: credential.accountId,
          api_key: credential.apiKey,
          key_prefix: credential.keyPrefix,
          created_at: credential.createdAt.toISOString(),
        })
      },
    )

    app.get('/v1/accounts', async (request) => {
      assertAdminApiKey(request, options.config.adminApiKey)
      if (accountRepository.listAccountSummaries === undefined) {
        throw new Error('Account lookup is unavailable')
      }
      const accounts = await accountRepository.listAccountSummaries()
      return {
        accounts: accounts.map((account) => ({
          id: account.id,
          name: account.name,
          status: account.status,
          solana_public_key: account.solanaPublicKey,
          created_at: account.createdAt.toISOString(),
          updated_at: account.updatedAt.toISOString(),
          credentials: account.credentials.map((credential) => ({
            id: credential.id,
            key_prefix: credential.keyPrefix,
            created_at: credential.createdAt.toISOString(),
            revoked_at: credential.revokedAt?.toISOString() ?? null,
          })),
        })),
      }
    })

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
        const pendingAtomic =
          options.reservationRepository === undefined
            ? 0n
            : await options.reservationRepository.getActiveOutgoingReservationAtomic(
                account.account.id,
                balance.currency,
              )
        const availableAtomic =
          balance.settled.atomicUnits > pendingAtomic
            ? balance.settled.atomicUnits - pendingAtomic
            : 0n
        return {
          currency: balance.currency,
          settled: formatMoney(balance.settled),
          pending_outgoing: formatMoney(moneyFromAtomicUnits(pendingAtomic)),
          available: formatMoney(moneyFromAtomicUnits(availableAtomic)),
        }
      },
    )

    app.post<{
      Body: {
        currency: 'USD'
        amount?: string
        reference?: string
        expires_at?: string
      }
    }>(
      '/v1/receives',
      {
        preHandler: async (request) => authenticateAgent(request, accountRepository),
        schema: {
          body: {
            type: 'object',
            additionalProperties: false,
            properties: {
              currency: { type: 'string', const: 'USD' },
              amount: { type: 'string', minLength: 1 },
              reference: { type: 'string', minLength: 1, maxLength: 255 },
              expires_at: { type: 'string', minLength: 1 },
            },
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
        if (options.receiveService !== undefined) {
          return options.receiveService.createReceiveRequest(
            account.account.id,
            account.account.solanaPublicKey,
            {
              currency: request.body.currency,
              ...(request.body.amount === undefined
                ? {}
                : { amount: request.body.amount }),
              ...(request.body.reference === undefined
                ? {}
                : { reference: request.body.reference }),
              ...(request.body.expires_at === undefined
                ? {}
                : { expiresAt: request.body.expires_at }),
            },
          )
        }
        return serializeReceiveDestination(
          await solanaRail.getReceiveDestination(account.account.solanaPublicKey),
          account.account.id,
        )
      },
    )

    if (options.receiveService !== undefined) {
      app.get<{ Params: { receiveId: string } }>(
        '/v1/receives/:receiveId',
        {
          preHandler: async (request) => authenticateAgent(request, accountRepository),
          schema: {
            params: {
              type: 'object',
              additionalProperties: false,
              properties: { receiveId: { type: 'string', minLength: 1 } },
              required: ['receiveId'],
            },
          },
        },
        async (request) => {
          const account = requireAgentAccount(request)
          return options.receiveService!.getReceiveRequest(
            account.account.id,
            account.account.solanaPublicKey,
            request.params.receiveId,
          )
        },
      )
    }

    if (options.recipientService !== undefined) {
      const { recipientService } = options
      app.post<{
        Body: {
          display_name: string
          type: string
          managed_account_id?: string
          destination: { type: string; wallet_address: string }
        }
      }>(
        '/v1/recipients',
        {
          preHandler: async (request) => authenticateAgent(request, accountRepository),
          schema: {
            body: {
              type: 'object',
              additionalProperties: false,
              properties: {
                display_name: { type: 'string', minLength: 1, maxLength: 120 },
                type: { type: 'string', minLength: 1, maxLength: 64 },
                managed_account_id: { type: 'string', minLength: 1, maxLength: 64 },
                destination: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    type: { type: 'string', const: 'SOLANA_SPL' },
                    wallet_address: { type: 'string', minLength: 1, maxLength: 128 },
                  },
                  required: ['type', 'wallet_address'],
                },
              },
              required: ['display_name', 'type', 'destination'],
            },
          },
        },
        async (request, reply) => {
          const account = requireAgentAccount(request)
          const recipient = await recipientService.createRecipient(account.account.id, {
            displayName: request.body.display_name,
            type: request.body.type,
            ...(request.body.managed_account_id === undefined
              ? {}
              : { managedAccountId: request.body.managed_account_id }),
            destination: {
              type: request.body.destination.type,
              walletAddress: request.body.destination.wallet_address,
            },
          })
          return reply.code(201).send(serializeRecipient(recipient))
        },
      )

      app.get<{ Querystring: { limit?: number; cursor?: string } }>(
        '/v1/recipients',
        {
          preHandler: async (request) => authenticateAgent(request, accountRepository),
          schema: {
            querystring: {
              type: 'object',
              additionalProperties: false,
              properties: {
                limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
                cursor: { type: 'string', minLength: 1 },
              },
            },
          },
        },
        async (request) => {
          const account = requireAgentAccount(request)
          const page = await recipientService.listRecipientsPage(
            account.account.id,
            request.query,
          )
          return {
            recipients: page.recipients.map(serializeRecipient),
            next_cursor: page.next_cursor,
          }
        },
      )

      app.get<{ Params: { recipientId: string } }>(
        '/v1/recipients/:recipientId',
        {
          preHandler: async (request) => authenticateAgent(request, accountRepository),
        },
        async (request) => {
          const account = requireAgentAccount(request)
          return serializeRecipient(
            await recipientService.getRecipient(
              account.account.id,
              request.params.recipientId,
            ),
          )
        },
      )

      app.patch<{
        Params: { recipientId: string }
        Body: {
          display_name?: string
          type?: string
          managed_account_id?: string | null
          destination?: { id: string; type: string; wallet_address: string }
        }
      }>(
        '/v1/recipients/:recipientId',
        {
          preHandler: async (request) => authenticateAgent(request, accountRepository),
          schema: {
            params: {
              type: 'object',
              additionalProperties: false,
              properties: { recipientId: { type: 'string', minLength: 1 } },
              required: ['recipientId'],
            },
            body: {
              type: 'object',
              additionalProperties: false,
              properties: {
                display_name: { type: 'string', minLength: 1, maxLength: 120 },
                type: { type: 'string', minLength: 1, maxLength: 64 },
                managed_account_id: { type: 'string', minLength: 1, maxLength: 64 },
                destination: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    id: { type: 'string', minLength: 1, maxLength: 64 },
                    type: { type: 'string', const: 'SOLANA_SPL' },
                    wallet_address: { type: 'string', minLength: 1, maxLength: 128 },
                  },
                  required: ['id', 'type', 'wallet_address'],
                },
              },
              minProperties: 1,
            },
          },
        },
        async (request) => {
          const account = requireAgentAccount(request)
          return serializeRecipient(
            await recipientService.updateRecipient(
              account.account.id,
              request.params.recipientId,
              {
                ...(request.body.display_name === undefined
                  ? {}
                  : { displayName: request.body.display_name }),
                ...(request.body.type === undefined ? {} : { type: request.body.type }),
                ...(request.body.managed_account_id === undefined
                  ? {}
                  : { managedAccountId: request.body.managed_account_id }),
                ...(request.body.destination === undefined
                  ? {}
                  : {
                      destination: {
                        id: request.body.destination.id,
                        type: request.body.destination.type,
                        walletAddress: request.body.destination.wallet_address,
                      },
                    }),
              },
            ),
          )
        },
      )
    }

    if (options.paymentService !== undefined) {
      const { paymentService } = options
      const paymentSchema = {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            recipient_id: { type: 'string', minLength: 1 },
            amount: { type: 'string', minLength: 1 },
            currency: { type: 'string', minLength: 1 },
            description: { type: 'string', minLength: 1, maxLength: 500 },
            external_reference: { type: 'string', minLength: 1, maxLength: 255 },
          },
          required: ['recipient_id', 'amount', 'currency'],
        },
        headers: {
          type: 'object',
          properties: {
            'idempotency-key': { type: 'string', minLength: 1, maxLength: 255 },
          },
          required: ['idempotency-key'],
        },
      } as const

      app.post<{ Body: PaymentBody }>(
        '/v1/pay',
        {
          preHandler: async (request) => authenticateAgent(request, accountRepository),
          schema: paymentSchema,
        },
        async (request, reply) => {
          const result = await paymentService.createPayment(
            requireAgentAccount(request),
            'PAY',
            toPaymentRequest(request.body),
            getIdempotencyKey(request),
            request.id,
          )
          logPaymentResult(
            request,
            requireAgentAccount(request).account.id,
            'PAY',
            result.payment,
          )
          return reply
            .code(result.created ? 201 : 200)
            .send(serializePayment(result.payment))
        },
      )

      app.post<{
        Body: { original_payment_id: string; amount: string; currency: string }
      }>(
        '/v1/refunds',
        {
          preHandler: async (request) => authenticateAgent(request, accountRepository),
          schema: {
            body: {
              type: 'object',
              additionalProperties: false,
              properties: {
                original_payment_id: { type: 'string', minLength: 1 },
                amount: { type: 'string', minLength: 1 },
                currency: { type: 'string', const: 'USD' },
              },
              required: ['original_payment_id', 'amount', 'currency'],
            },
            headers: paymentSchema.headers,
          },
        },
        async (request, reply) => {
          const result = await paymentService.createRefund(
            requireAgentAccount(request),
            {
              originalPaymentId: request.body.original_payment_id,
              amount: request.body.amount,
              currency: request.body.currency,
            },
            getIdempotencyKey(request),
            request.id,
          )
          logPaymentResult(
            request,
            requireAgentAccount(request).account.id,
            'REFUND',
            result.payment,
          )
          return reply
            .code(result.created ? 201 : 200)
            .send(serializePayment(result.payment))
        },
      )

      app.post<{ Body: PaymentBody }>(
        '/v1/send',
        {
          preHandler: async (request) => authenticateAgent(request, accountRepository),
          schema: paymentSchema,
        },
        async (request, reply) => {
          const result = await paymentService.createPayment(
            requireAgentAccount(request),
            'SEND',
            toPaymentRequest(request.body),
            getIdempotencyKey(request),
            request.id,
          )
          logPaymentResult(
            request,
            requireAgentAccount(request).account.id,
            'SEND',
            result.payment,
          )
          return reply
            .code(result.created ? 201 : 200)
            .send(serializePayment(result.payment))
        },
      )

      app.get<{ Params: { paymentId: string } }>(
        '/v1/payments/:paymentId',
        {
          preHandler: async (request) => authenticateAgent(request, accountRepository),
        },
        async (request) => {
          const account = requireAgentAccount(request)
          return serializePayment(
            await paymentService.getPayment(
              account.account.id,
              request.params.paymentId,
            ),
          )
        },
      )

      app.get<{ Querystring: { limit?: number; cursor?: string } }>(
        '/v1/payments',
        {
          preHandler: async (request) => authenticateAgent(request, accountRepository),
          schema: {
            querystring: {
              type: 'object',
              additionalProperties: false,
              properties: {
                limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
                cursor: { type: 'string', minLength: 1 },
              },
            },
          },
        },
        async (request) => {
          const account = requireAgentAccount(request)
          const page = await paymentService.listPaymentsPage(
            account.account.id,
            request.query,
          )
          return {
            payments: page.payments.map(serializePayment),
            next_cursor: page.next_cursor,
          }
        },
      )

      if (options.transactionService !== undefined) {
        app.get<{ Querystring: { limit?: number; cursor?: string } }>(
          '/v1/transactions',
          {
            preHandler: async (request) =>
              authenticateAgent(request, accountRepository),
            schema: {
              querystring: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
                  cursor: { type: 'string', minLength: 1 },
                },
              },
            },
          },
          async (request) =>
            options.transactionService!.listTransactionsPage(
              requireAgentAccount(request).account.id,
              request.query,
            ),
        )
        app.get<{ Params: { transactionId: string } }>(
          '/v1/transactions/:transactionId',
          {
            preHandler: async (request) =>
              authenticateAgent(request, accountRepository),
          },
          async (request) =>
            options.transactionService!.getTransaction(
              requireAgentAccount(request).account.id,
              request.params.transactionId,
            ),
        )
      }
    }
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
    async (request, reply) => {
      try {
        await options.readinessDependency.checkReadiness()
        return { status: 'ok' }
      } catch {
        request.log.error({ errorCode: 'READINESS_FAILURE' }, 'Readiness check failed')
        return reply.code(503).send({ status: 'not_ready' })
      }
    },
  )

  app.setErrorHandler((error: Error & ErrorWithCode, request, reply) => {
    const statusCode = getErrorStatusCode(error)
    request.log.error(
      {
        errorCode: error.code ?? 'INTERNAL_ERROR',
        statusCode,
        ...(error.details?.payment_id === undefined
          ? {}
          : { paymentId: error.details.payment_id }),
      },
      'API request failed',
    )
    return reply.code(statusCode).send(getErrorResponse(error, statusCode))
  })

  return app
}

interface PaymentBody {
  readonly recipient_id: string
  readonly amount: string
  readonly currency: string
  readonly description?: string
  readonly external_reference?: string
}

function requireAgentAccount(request: Parameters<typeof authenticateAgent>[0]) {
  if (request.agentAccount === null) {
    throw new AuthenticationError()
  }
  return request.agentAccount
}

function getIdempotencyKey(request: Parameters<typeof authenticateAgent>[0]): string {
  const value = request.headers['idempotency-key']
  const key = Array.isArray(value) ? value[0] : value
  if (key === undefined) {
    throw new ValidationError('Idempotency-Key header is required')
  }
  return key
}

function toPaymentRequest(body: PaymentBody) {
  return {
    recipientId: body.recipient_id,
    amount: body.amount,
    currency: body.currency,
    ...(body.description === undefined ? {} : { description: body.description }),
    ...(body.external_reference === undefined
      ? {}
      : { externalReference: body.external_reference }),
  }
}

function logPaymentResult(
  request: Parameters<typeof authenticateAgent>[0],
  accountId: string,
  operation: 'PAY' | 'SEND' | 'REFUND',
  payment: {
    readonly id: string
    readonly status: string
    readonly route: string | null
  },
): void {
  request.log.info(
    {
      paymentId: payment.id,
      accountId,
      operation,
      state: payment.status,
      rail: payment.route,
    },
    'Money operation state observed',
  )
}
