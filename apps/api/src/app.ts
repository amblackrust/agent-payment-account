import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import {
  AuthenticationError,
  formatMoney,
  moneyFromAtomicUnits,
  RateLimitedError,
  ValidationError,
} from '@agent-payment/core'
import type {
  AccountRepository,
  ReservationRepository,
  V2AdminRepository,
} from '@agent-payment/db'
import type { SolanaRail } from '@agent-payment/solana-rail'

import { getRuntimeLimits, type AppConfig } from './config.js'
import { serializeAccountCreation, serializeReceiveDestination } from './accounts.js'
import type { AccountService } from './accounts.js'
import {
  ADMIN_API_KEY_HEADER,
  assertAdminApiKey,
  authenticateAgentWithScope,
  getAdminOperatorId,
  hashApiKey,
} from './auth.js'
import type { authenticateAgent } from './auth.js'
import { serializePayment } from './payments.js'
import type { PaymentServiceLike } from './payments.js'
import { serializeRecipient } from './recipients.js'
import type { RecipientService } from './recipients.js'
import type { ReceiveService } from './receives.js'
import type { V2ReceiveService } from './receives.js'
import type { TransactionService } from './transactions.js'
import { type V2CreatePaymentInput, type V2PaymentService } from './payments-v2.js'
import type { V2ManagementService } from './v2-management.js'
import { registerV2OperationsRoutes } from './v2-operations-routes.js'
import type { V2OperationsService } from './v2-operations.js'
import {
  v2AccountCreationResponseSchema,
  v2AccountResponseSchema,
  v2ApprovalListResponseSchema,
  v2ApprovalResponseSchema,
  v2ApprovedDestinationListResponseSchema,
  v2ApprovedDestinationResponseSchema,
  v2BalanceResponseSchema,
  v2CredentialListResponseSchema,
  v2CredentialIssuanceResponseSchema,
  v2CredentialIssuanceRequestSchema,
  v2ErrorResponseSchema,
  v2FundingDestinationResponseSchema,
  v2HistoryResponseSchema,
  v2LifecycleResponseSchema,
  v2PaymentCreateRequestSchema,
  v2PaymentListResponseSchema,
  v2PaymentResponseSchema,
  v2PolicyListResponseSchema,
  v2PolicyResponseSchema,
  v2ReceiveListResponseSchema,
  v2ReceiveResponseSchema,
  v2RecipientListResponseSchema,
  v2RecipientResponseSchema,
  v2RotatedCredentialResponseSchema,
  v2StatusResponseSchema,
} from './v2-response-schemas.js'
import {
  CORRELATION_ID_HEADER,
  MetricsRegistry,
  normalizeCorrelationId,
  type DomainHealthDependency,
  type DomainHealthSnapshot,
} from './observability.js'

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
  readonly paymentService?: PaymentServiceLike
  readonly reservationRepository?: ReservationRepository
  readonly receiveService?: ReceiveService
  readonly v2ReceiveService?: V2ReceiveService
  readonly transactionService?: TransactionService
  readonly v2PaymentService?: V2PaymentService
  readonly v2ManagementService?: V2ManagementService
  readonly v2OperationsService?: V2OperationsService
  readonly v2AdminRepository?: Pick<V2AdminRepository, 'consumeRateLimit'>
  readonly metrics?: MetricsRegistry
  readonly domainHealthDependency?: DomainHealthDependency
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

const REQUEST_RATE_LIMIT_BUCKET = 'request'
const REQUEST_BURST_LIMIT_BUCKET = 'request-burst'

function getErrorStatusCode(error: ErrorWithCode): number {
  if (error.validation !== undefined) {
    return 400
  }

  switch (error.code) {
    case 'AUTHENTICATION_ERROR':
      return 401
    case 'AUTHORIZATION_ERROR':
      return 403
    case 'POLICY_DENIED':
      return 403
    case 'NOT_FOUND':
      return 404
    case 'RATE_LIMITED':
      return 429
    case 'DEPENDENCY_UNAVAILABLE':
    case 'CUSTODY_UNAVAILABLE':
      return 503
    case 'INVALID_STATE':
    case 'IDEMPOTENCY_CONFLICT':
    case 'IDEMPOTENCY_KEY_REUSED':
      return 409
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

function getErrorResponse(
  error: ErrorWithCode & Error,
  statusCode: number,
  requestId?: string,
  v2 = false,
) {
  const isInternal = statusCode >= 500
  if (v2) {
    return {
      code:
        error.validation === undefined
          ? (error.code ?? 'INTERNAL_ERROR')
          : 'VALIDATION_ERROR',
      message: isInternal ? 'Internal Server Error' : error.message,
      ...(requestId === undefined ? {} : { request_id: requestId }),
      ...(error.details === undefined ? {} : { details: error.details }),
    }
  }
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
  const metrics = options.metrics ?? new MetricsRegistry()
  const runtimeLimits = getRuntimeLimits(options.config)
  const requestStartTimes = new WeakMap<FastifyRequest, number>()
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

  app.addHook('onRequest', async (request) => {
    requestStartTimes.set(request, performance.now())
    const correlationId = normalizeCorrelationId(
      request.headers[CORRELATION_ID_HEADER],
      request.id,
    )
    request.log = request.log.child({ correlationId })
    if (options.v2AdminRepository !== undefined && request.url.startsWith('/v2/')) {
      await enforceRequestRateLimits(options.v2AdminRepository, request, runtimeLimits)
    }
  })

  app.addHook('onResponse', async (request, reply) => {
    metrics.incrementCounter('mux_api_requests_total', {
      status: String(Math.floor(reply.statusCode / 100) * 100),
    })
    const startedAt = requestStartTimes.get(request)
    if (startedAt !== undefined) {
      metrics.observeHistogram(
        'mux_api_request_duration_ms',
        performance.now() - startedAt,
        {
          status: String(Math.floor(reply.statusCode / 100) * 100),
        },
      )
    }
  })

  app.addHook('onError', async (_request, _reply, error) => {
    metrics.incrementCounter('mux_api_errors_total', {
      error_code:
        typeof (error as { code?: unknown }).code === 'string'
          ? (error as { code: string }).code
          : 'INTERNAL_ERROR',
    })
  })

  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id)
    reply.header(
      CORRELATION_ID_HEADER,
      normalizeCorrelationId(request.headers[CORRELATION_ID_HEADER], request.id),
    )
  })

  app.get(
    '/health',
    { schema: { response: { 200: healthResponseSchema } } },
    async () => ({
      status: 'ok',
    }),
  )

  app.get(
    '/health/live',
    { schema: { response: { 200: healthResponseSchema } } },
    async () => ({
      status: 'ok',
    }),
  )

  app.get(
    '/health/domain',
    {
      schema: {
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: { type: 'string', enum: ['ok', 'degraded'] },
              checks: { type: 'object', additionalProperties: { type: 'string' } },
              alerts: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    name: { type: 'string' },
                    severity: { type: 'string', enum: ['warning', 'critical'] },
                    message: { type: 'string' },
                  },
                  required: ['name', 'severity', 'message'],
                },
              },
            },
            required: ['status', 'checks'],
          },
          503: {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: { type: 'string', const: 'degraded' },
              checks: { type: 'object', additionalProperties: { type: 'string' } },
              alerts: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    name: { type: 'string' },
                    severity: { type: 'string', enum: ['warning', 'critical'] },
                    message: { type: 'string' },
                  },
                  required: ['name', 'severity', 'message'],
                },
              },
            },
            required: ['status', 'checks'],
          },
        },
      },
    },
    async (_request, reply) => {
      const snapshot: DomainHealthSnapshot =
        options.domainHealthDependency === undefined
          ? { status: 'ok', checks: {} }
          : await options.domainHealthDependency.checkDomainHealth()
      if (snapshot.status === 'degraded') return reply.code(503).send(snapshot)
      return snapshot
    },
  )

  app.get('/metrics', async (_request, reply) => {
    reply.type('text/plain; version=0.0.4')
    return metrics.renderPrometheus()
  })

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

    app.post<{ Body: { name: string } }>(
      '/v2/accounts',
      {
        schema: {
          body: {
            type: 'object',
            additionalProperties: false,
            properties: { name: { type: 'string', minLength: 1, maxLength: 120 } },
            required: ['name'],
          },
          headers: {
            type: 'object',
            properties: {
              'idempotency-key': { type: 'string', minLength: 1, maxLength: 255 },
            },
            required: ['idempotency-key'],
          },
          response: { 201: v2AccountCreationResponseSchema },
        },
      },
      async (request, reply) => {
        assertAdminApiKey(request, options.config.adminApiKey)
        const response = await accountService.createAccountV2(
          request.body.name,
          getIdempotencyKey(request),
        )
        return reply.code(201).send(serializeAccountCreation(response))
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
      {
        preHandler: async (request) =>
          authenticateAgentWithScope(request, accountRepository, 'balance:read'),
      },
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
        preHandler: async (request) =>
          authenticateAgentWithScope(request, accountRepository, 'receive:manage'),
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
          preHandler: async (request) =>
            authenticateAgentWithScope(request, accountRepository, 'receive:manage'),
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
          preHandler: async (request) =>
            authenticateAgentWithScope(request, accountRepository, 'contacts:manage'),
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
          preHandler: async (request) =>
            authenticateAgentWithScope(request, accountRepository, 'contacts:manage'),
          schema: {
            querystring: {
              type: 'object',
              additionalProperties: false,
              properties: {
                limit: {
                  type: 'integer',
                  minimum: 1,
                  maximum: runtimeLimits.maxPageSize,
                  default: 50,
                },
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
          preHandler: async (request) =>
            authenticateAgentWithScope(request, accountRepository, 'contacts:manage'),
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
          preHandler: async (request) =>
            authenticateAgentWithScope(request, accountRepository, 'contacts:manage'),
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
          preHandler: async (request) =>
            authenticateAgentWithScope(request, accountRepository, 'payments:create'),
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
          preHandler: async (request) =>
            authenticateAgentWithScope(request, accountRepository, 'payments:create'),
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
          preHandler: async (request) =>
            authenticateAgentWithScope(request, accountRepository, 'payments:create'),
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
          preHandler: async (request) =>
            authenticateAgentWithScope(request, accountRepository, 'payments:read'),
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
          preHandler: async (request) =>
            authenticateAgentWithScope(request, accountRepository, 'payments:read'),
          schema: {
            querystring: {
              type: 'object',
              additionalProperties: false,
              properties: {
                limit: {
                  type: 'integer',
                  minimum: 1,
                  maximum: runtimeLimits.maxPageSize,
                  default: 50,
                },
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
              authenticateAgentWithScope(request, accountRepository, 'history:read'),
            schema: {
              querystring: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  limit: {
                    type: 'integer',
                    minimum: 1,
                    maximum: runtimeLimits.maxPageSize,
                    default: 50,
                  },
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
              authenticateAgentWithScope(request, accountRepository, 'history:read'),
          },
          async (request) =>
            options.transactionService!.getTransaction(
              requireAgentAccount(request).account.id,
              request.params.transactionId,
            ),
        )
      }
    }

    if (options.v2PaymentService !== undefined) {
      const { v2PaymentService } = options
      const v2PaymentSchema = {
        body: v2PaymentCreateRequestSchema,
        headers: {
          type: 'object',
          properties: {
            'idempotency-key': { type: 'string', minLength: 1, maxLength: 255 },
          },
          required: ['idempotency-key'],
        },
      } as const

      app.post<{
        Body: {
          kind?: 'PAY' | 'SEND'
          recipient_id: string
          amount: string
          denomination_id: string
          description?: string
          external_reference?: string
          metadata?: Record<string, unknown>
          route_preference?: string
        }
      }>(
        '/v2/payments',
        {
          preHandler: async (request) => {
            await authenticateAgentWithScope(
              request,
              accountRepository,
              'payments:create',
            )
            await enforceRateLimit(
              options.v2AdminRepository,
              request,
              'payment:create',
              runtimeLimits.paymentRateLimitPerWindow,
              runtimeLimits.requestRateLimitWindowSeconds,
            )
          },
          schema: {
            ...v2PaymentSchema,
            response: {
              200: v2PaymentResponseSchema,
              201: v2PaymentResponseSchema,
              403: v2ErrorResponseSchema,
            },
          },
        },
        async (request, reply) => {
          const body: V2CreatePaymentInput = {
            kind: request.body.kind ?? 'PAY',
            recipientId: request.body.recipient_id,
            amount: request.body.amount,
            denominationId: request.body.denomination_id,
            ...(request.body.description === undefined
              ? {}
              : { description: request.body.description }),
            ...(request.body.external_reference === undefined
              ? {}
              : { externalReference: request.body.external_reference }),
            ...(request.body.metadata === undefined
              ? {}
              : { metadata: request.body.metadata }),
            ...(request.body.route_preference === undefined
              ? {}
              : { routePreference: request.body.route_preference }),
          }
          const result = await v2PaymentService.createPayment(
            requireAgentAccount(request),
            body,
            getIdempotencyKey(request),
            request.id,
          )
          const response = await v2PaymentService.serialize(result.view)
          if (result.view.policyDecision === 'DENY') {
            return reply.code(403).send({
              code: 'POLICY_DENIED',
              message: 'Payment was denied by policy',
              request_id: request.id,
              payment_id: result.view.payment.id,
              payment_status: result.view.payment.status,
              reason_codes: [...result.view.reasonCodes],
            })
          }
          return reply.code(result.created ? 201 : 200).send(response)
        },
      )

      app.get<{ Params: { paymentId: string } }>(
        '/v2/payments/:paymentId',
        {
          preHandler: async (request) =>
            authenticateAgentWithScope(request, accountRepository, 'payments:read'),

          schema: {
            params: {
              type: 'object',
              additionalProperties: false,
              properties: {
                paymentId: { type: 'string', minLength: 1, maxLength: 64 },
              },
              required: ['paymentId'],
            },
            response: { 200: v2PaymentResponseSchema },
          },
        },
        async (request) =>
          v2PaymentService.serialize(
            await v2PaymentService.getPayment(
              requireAgentAccount(request).account.id,
              request.params.paymentId,
            ),
          ),
      )

      app.get<{
        Querystring: {
          limit?: number
          cursor?: string
          status?: string
          outcome_state?: string
          recipient_id?: string
          denomination_id?: string
        }
      }>(
        '/v2/payments',
        {
          preHandler: async (request) =>
            authenticateAgentWithScope(request, accountRepository, 'payments:read'),
          schema: {
            querystring: {
              type: 'object',
              additionalProperties: false,
              properties: {
                limit: {
                  type: 'integer',
                  minimum: 1,
                  maximum: runtimeLimits.maxPageSize,
                  default: 50,
                },
                cursor: { type: 'string', minLength: 1 },
                status: { type: 'string', minLength: 1, maxLength: 32 },
                outcome_state: { type: 'string', minLength: 1, maxLength: 32 },
                recipient_id: { type: 'string', minLength: 1, maxLength: 64 },
                denomination_id: { type: 'string', minLength: 1, maxLength: 64 },
              },
            },
            response: { 200: v2PaymentListResponseSchema },
          },
        },
        async (request) => {
          const page = await v2PaymentService.listPayments(
            requireAgentAccount(request).account.id,
            {
              ...(request.query.limit === undefined
                ? {}
                : { limit: request.query.limit }),
              ...(request.query.cursor === undefined
                ? {}
                : { cursor: request.query.cursor }),
              ...(request.query.status === undefined
                ? {}
                : { status: request.query.status }),
              ...(request.query.outcome_state === undefined
                ? {}
                : { outcomeState: request.query.outcome_state }),
              ...(request.query.recipient_id === undefined
                ? {}
                : { recipientId: request.query.recipient_id }),
              ...(request.query.denomination_id === undefined
                ? {}
                : { denominationId: request.query.denomination_id }),
            },
          )
          return {
            payments: await Promise.all(
              page.payments.map((payment) => v2PaymentService.serialize(payment)),
            ),
            next_cursor: page.nextCursor,
          }
        },
      )

      app.post<{
        Params: { paymentId: string }
        Body: {
          amount: string
          denomination_id: string
          description?: string
          external_reference?: string
          metadata?: Record<string, unknown>
          route_preference?: string
        }
      }>(
        '/v2/payments/:paymentId/refunds',
        {
          preHandler: async (request) => {
            await authenticateAgentWithScope(
              request,
              accountRepository,
              'payments:create',
            )
            await enforceRateLimit(
              options.v2AdminRepository,
              request,
              'payment:create',
              runtimeLimits.paymentRateLimitPerWindow,
              runtimeLimits.requestRateLimitWindowSeconds,
            )
          },
          schema: {
            headers: v2PaymentSchema.headers,
            body: {
              type: 'object',
              additionalProperties: false,
              required: ['amount', 'denomination_id'],
              properties: {
                amount: { type: 'string', minLength: 1, maxLength: 256 },
                denomination_id: { type: 'string', minLength: 1, maxLength: 64 },
                description: { type: 'string', minLength: 1, maxLength: 500 },
                external_reference: { type: 'string', minLength: 1, maxLength: 255 },
                metadata: { type: 'object', additionalProperties: true },
                route_preference: { type: 'string', minLength: 1, maxLength: 64 },
              },
            },
            response: {
              200: v2PaymentResponseSchema,
              201: v2PaymentResponseSchema,
            },
          },
        },
        async (request, reply) => {
          const result = await v2PaymentService.createRefund(
            requireAgentAccount(request),
            request.params.paymentId,
            {
              amount: request.body.amount,
              denominationId: request.body.denomination_id,
              ...(request.body.description === undefined
                ? {}
                : { description: request.body.description }),
              ...(request.body.external_reference === undefined
                ? {}
                : { externalReference: request.body.external_reference }),
              ...(request.body.metadata === undefined
                ? {}
                : { metadata: request.body.metadata }),
              ...(request.body.route_preference === undefined
                ? {}
                : { routePreference: request.body.route_preference }),
            },
            getIdempotencyKey(request),
            request.id,
          )
          return reply
            .code(result.created ? 201 : 200)
            .send(await v2PaymentService.serialize(result.view))
        },
      )
    }

    if (options.v2ManagementService !== undefined) {
      const management = options.v2ManagementService
      if (options.recipientService !== undefined) {
        const recipients = options.recipientService
        const recipientParams = {
          type: 'object',
          additionalProperties: false,
          properties: { recipientId: { type: 'string', minLength: 1, maxLength: 64 } },
          required: ['recipientId'],
        } as const
        app.post<{
          Body: {
            display_name: string
            type: string
            managed_account_id?: string
            destination: { type: string; wallet_address: string }
          }
        }>(
          '/v2/recipients',
          {
            preHandler: async (request) =>
              authenticateAgentWithScope(request, accountRepository, 'contacts:manage'),
            schema: {
              response: { 201: v2RecipientResponseSchema },
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
            const recipient = await recipients.createRecipient(account.account.id, {
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
          '/v2/recipients',
          {
            preHandler: async (request) =>
              authenticateAgentWithScope(request, accountRepository, 'contacts:manage'),
            schema: {
              response: { 200: v2RecipientListResponseSchema },
              querystring: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  limit: {
                    type: 'integer',
                    minimum: 1,
                    maximum: runtimeLimits.maxPageSize,
                    default: 50,
                  },
                  cursor: { type: 'string', minLength: 1 },
                },
              },
            },
          },
          async (request) => {
            const page = await recipients.listRecipientsPage(
              requireAgentAccount(request).account.id,
              request.query,
            )
            return {
              recipients: page.recipients.map(serializeRecipient),
              next_cursor: page.next_cursor,
            }
          },
        )
        app.get<{ Params: { recipientId: string } }>(
          '/v2/recipients/:recipientId',
          {
            preHandler: async (request) =>
              authenticateAgentWithScope(request, accountRepository, 'contacts:manage'),
            schema: {
              params: recipientParams,
              response: { 200: v2RecipientResponseSchema },
            },
          },
          async (request) =>
            serializeRecipient(
              await recipients.getRecipient(
                requireAgentAccount(request).account.id,
                request.params.recipientId,
              ),
            ),
        )
        app.patch<{
          Params: { recipientId: string }
          Body: {
            display_name?: string
            type?: string
            managed_account_id?: string | null
            row_version: number
            destination?: { id: string; type: string; wallet_address: string }
          }
        }>(
          '/v2/recipients/:recipientId',
          {
            preHandler: async (request) =>
              authenticateAgentWithScope(request, accountRepository, 'contacts:manage'),
            schema: {
              response: { 200: v2RecipientResponseSchema },
              params: recipientParams,
              body: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  display_name: { type: 'string', minLength: 1, maxLength: 120 },
                  type: { type: 'string', minLength: 1, maxLength: 64 },
                  managed_account_id: { type: ['string', 'null'], maxLength: 64 },
                  row_version: { type: 'integer', minimum: 1 },
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
                required: ['row_version'],
                minProperties: 1,
              },
            },
          },
          async (request) =>
            serializeRecipient(
              await recipients.updateRecipient(
                requireAgentAccount(request).account.id,
                request.params.recipientId,
                {
                  ...(request.body.display_name === undefined
                    ? {}
                    : { displayName: request.body.display_name }),
                  ...(request.body.type === undefined
                    ? {}
                    : { type: request.body.type }),
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
                  rowVersion: request.body.row_version,
                },
              ),
            ),
        )
        app.post<{ Params: { recipientId: string }; Body: { row_version: number } }>(
          '/v2/recipients/:recipientId/archive',
          {
            preHandler: async (request) =>
              authenticateAgentWithScope(request, accountRepository, 'contacts:manage'),
            schema: {
              response: { 200: v2StatusResponseSchema },
              params: recipientParams,
              body: {
                type: 'object',
                additionalProperties: false,
                properties: { row_version: { type: 'integer', minimum: 1 } },
                required: ['row_version'],
              },
            },
          },
          async (request) => {
            const account = requireAgentAccount(request)
            await management.archiveRecipient({
              ownerAccountId: account.account.id,
              recipientId: request.params.recipientId,
              rowVersion: request.body.row_version,
            })
            return { status: 'ARCHIVED' }
          },
        )
      }
      const accountParams = {
        type: 'object',
        additionalProperties: false,
        properties: { accountId: { type: 'string', minLength: 1, maxLength: 64 } },
        required: ['accountId'],
      } as const
      const policyBody = {
        type: 'object',
        additionalProperties: false,
        properties: {
          denomination_id: { type: 'string', minLength: 1, maxLength: 64 },
          max_per_payment: { type: ['string', 'null'] },
          rolling_budget: { type: ['string', 'null'] },
          rolling_window_seconds: { type: ['integer', 'null'], minimum: 1 },
          transaction_count_cap: { type: ['integer', 'null'], minimum: 1 },
          approval_threshold: { type: ['string', 'null'] },
          version: { type: 'integer', minimum: 1 },
          rolling_budget_escalatable: { type: 'boolean' },
          transaction_count_escalatable: { type: 'boolean' },
        },
        required: ['denomination_id'],
      } as const

      app.get<{
        Params: { accountId: string }
        Querystring: { limit?: number; cursor?: string }
      }>(
        '/v2/accounts/:accountId',
        {
          preHandler: async (request) =>
            authenticateAgentWithScope(request, accountRepository, 'balance:read'),
          schema: {
            params: accountParams,
            response: { 200: v2AccountResponseSchema },
          },
        },
        async (request) => {
          const account = requireAgentAccount(request)
          if (account.account.id !== request.params.accountId) {
            throw new ValidationError('Account was not found')
          }
          return management.getAccount(request.params.accountId)
        },
      )

      app.get<{ Params: { accountId: string } }>(
        '/v2/accounts/:accountId/credentials',
        {
          schema: {
            params: accountParams,
            response: { 200: v2CredentialListResponseSchema },
          },
        },
        async (request) => {
          assertAdminApiKey(request, options.config.adminApiKey)
          return {
            credentials: await management.listCredentials(request.params.accountId),
          }
        },
      )

      app.post<{
        Params: { accountId: string }
        Body: { scopes: string[]; expires_at?: string }
      }>(
        '/v2/accounts/:accountId/credentials',
        {
          schema: {
            params: accountParams,
            headers: {
              type: 'object',
              properties: {
                'idempotency-key': { type: 'string', minLength: 1, maxLength: 255 },
              },
              required: ['idempotency-key'],
            },
            body: v2CredentialIssuanceRequestSchema,
            response: {
              200: v2CredentialIssuanceResponseSchema,
              201: v2CredentialIssuanceResponseSchema,
            },
          },
        },
        async (request, reply) => {
          const result = await management.createCredential({
            accountId: request.params.accountId,
            scopes: request.body.scopes,
            ...(request.body.expires_at === undefined
              ? {}
              : { expiresAt: request.body.expires_at }),
            idempotencyKey: getIdempotencyKey(request),
            actorId: getAdminOperatorId(request, options.config.adminApiKey),
          })
          const { created: _created, ...response } = result
          return reply.code(result.created ? 201 : 200).send(response)
        },
      )

      app.post<{ Params: { accountId: string } }>(
        '/v2/accounts/:accountId/credentials/recovery/acknowledge',
        {
          schema: {
            params: accountParams,
            headers: {
              type: 'object',
              properties: {
                'idempotency-key': { type: 'string', minLength: 1, maxLength: 255 },
              },
              required: ['idempotency-key'],
            },
            response: { 200: v2StatusResponseSchema },
          },
        },
        async (request) => {
          assertAdminApiKey(request, options.config.adminApiKey)
          await management.acknowledgeCredentialRecovery(
            request.params.accountId,
            getIdempotencyKey(request),
          )
          return { status: 'ACKNOWLEDGED' }
        },
      )

      app.post<{
        Params: { accountId: string }
        Body: {
          current_status: 'PROVISIONING' | 'ACTIVE' | 'DISABLED' | 'PROVISIONING_FAILED'
          next_status: 'PROVISIONING' | 'ACTIVE' | 'DISABLED' | 'PROVISIONING_FAILED'
          row_version: number
          reason?: string
        }
      }>(
        '/v2/accounts/:accountId/lifecycle',
        {
          schema: {
            params: accountParams,
            body: {
              type: 'object',
              additionalProperties: false,
              properties: {
                current_status: { type: 'string' },
                next_status: { type: 'string' },
                row_version: { type: 'integer', minimum: 1 },
                reason: { type: 'string', minLength: 1, maxLength: 500 },
              },
              required: ['current_status', 'next_status', 'row_version'],
            },
            response: { 200: v2LifecycleResponseSchema },
          },
        },
        async (request) => {
          const operatorId = getAdminOperatorId(request, options.config.adminApiKey)
          return management.transitionAccount({
            accountId: request.params.accountId,
            currentStatus: request.body.current_status,
            nextStatus: request.body.next_status,
            rowVersion: request.body.row_version,
            actorId: operatorId,
            ...(request.body.reason === undefined
              ? {}
              : { reason: request.body.reason }),
          })
        },
      )

      app.post<{
        Params: { accountId: string; credentialId: string }
      }>(
        '/v2/accounts/:accountId/credentials/:credentialId/revoke',
        {
          schema: {
            params: {
              ...accountParams,
              properties: {
                ...accountParams.properties,
                credentialId: { type: 'string', minLength: 1, maxLength: 64 },
              },
              required: ['accountId', 'credentialId'],
            },
            response: { 200: v2StatusResponseSchema },
          },
        },
        async (request) => {
          assertAdminApiKey(request, options.config.adminApiKey)
          await management.revokeCredential(
            request.params.accountId,
            request.params.credentialId,
          )
          return { status: 'REVOKED' }
        },
      )

      app.post<{
        Params: { accountId: string; credentialId: string }
      }>(
        '/v2/accounts/:accountId/credentials/:credentialId/rotate',
        {
          schema: {
            params: {
              ...accountParams,
              properties: {
                ...accountParams.properties,
                credentialId: { type: 'string', minLength: 1, maxLength: 64 },
              },
              required: ['accountId', 'credentialId'],
            },
            headers: {
              type: 'object',
              properties: {
                'idempotency-key': { type: 'string', minLength: 1, maxLength: 255 },
              },
              required: ['idempotency-key'],
            },
            response: { 200: v2RotatedCredentialResponseSchema },
          },
        },
        async (request) => {
          assertAdminApiKey(request, options.config.adminApiKey)
          return management.rotateCredential(
            request.params.accountId,
            request.params.credentialId,
            getIdempotencyKey(request),
          )
        },
      )

      app.get<{ Params: { accountId: string } }>(
        '/v2/accounts/:accountId/policies',
        {
          schema: {
            params: accountParams,
            response: { 200: v2PolicyListResponseSchema },
          },
        },
        async (request) => {
          assertAdminApiKey(request, options.config.adminApiKey)
          return { policies: await management.listPolicies(request.params.accountId) }
        },
      )
      app.get<{ Params: { accountId: string } }>(
        '/v2/accounts/:accountId/policy',
        {
          schema: {
            params: accountParams,
            response: { 200: v2PolicyResponseSchema },
          },
        },
        async (request) => {
          assertAdminApiKey(request, options.config.adminApiKey)
          return management.getPolicy(request.params.accountId)
        },
      )
      app.put<{
        Params: { accountId: string }
        Body: {
          denomination_id: string
          max_per_payment?: string | null
          rolling_budget?: string | null
          rolling_window_seconds?: number | null
          transaction_count_cap?: number | null
          approval_threshold?: string | null
          version?: number
          rolling_budget_escalatable?: boolean
          transaction_count_escalatable?: boolean
        }
      }>(
        '/v2/accounts/:accountId/policy',
        {
          schema: {
            params: accountParams,
            body: policyBody,
            response: { 200: v2PolicyResponseSchema },
          },
        },
        async (request) => {
          const operatorId = getAdminOperatorId(request, options.config.adminApiKey)
          return management.replacePolicy({
            accountId: request.params.accountId,
            denominationId: request.body.denomination_id,
            ...(request.body.max_per_payment === undefined
              ? {}
              : { maxPerPayment: request.body.max_per_payment }),
            ...(request.body.rolling_budget === undefined
              ? {}
              : { rollingBudget: request.body.rolling_budget }),
            ...(request.body.rolling_window_seconds === undefined
              ? {}
              : { rollingWindowSeconds: request.body.rolling_window_seconds }),
            ...(request.body.transaction_count_cap === undefined
              ? {}
              : { transactionCountCap: request.body.transaction_count_cap }),
            ...(request.body.approval_threshold === undefined
              ? {}
              : { approvalThreshold: request.body.approval_threshold }),
            ...(request.body.version === undefined
              ? {}
              : { expectedVersion: request.body.version }),
            ...(request.body.rolling_budget_escalatable === undefined
              ? {}
              : {
                  rollingBudgetEscalatable: request.body.rolling_budget_escalatable,
                }),
            ...(request.body.transaction_count_escalatable === undefined
              ? {}
              : {
                  transactionCountEscalatable:
                    request.body.transaction_count_escalatable,
                }),
            actorId: operatorId,
          })
        },
      )
      app.post<{
        Params: { accountId: string }
        Body: {
          denomination_id: string
          max_per_payment?: string | null
          rolling_budget?: string | null
          rolling_window_seconds?: number | null
          transaction_count_cap?: number | null
          approval_threshold?: string | null
          rolling_budget_escalatable?: boolean
          transaction_count_escalatable?: boolean
        }
      }>(
        '/v2/accounts/:accountId/policies',
        {
          schema: {
            params: accountParams,
            body: policyBody,
            response: { 201: v2PolicyResponseSchema },
          },
        },
        async (request, reply) => {
          assertAdminApiKey(request, options.config.adminApiKey)
          const policy = await management.createPolicy({
            accountId: request.params.accountId,
            denominationId: request.body.denomination_id,
            ...(request.body.max_per_payment === undefined
              ? {}
              : { maxPerPayment: request.body.max_per_payment }),
            ...(request.body.rolling_budget === undefined
              ? {}
              : { rollingBudget: request.body.rolling_budget }),
            ...(request.body.rolling_window_seconds === undefined
              ? {}
              : { rollingWindowSeconds: request.body.rolling_window_seconds }),
            ...(request.body.transaction_count_cap === undefined
              ? {}
              : { transactionCountCap: request.body.transaction_count_cap }),
            ...(request.body.approval_threshold === undefined
              ? {}
              : { approvalThreshold: request.body.approval_threshold }),
            ...(request.body.rolling_budget_escalatable === undefined
              ? {}
              : { rollingBudgetEscalatable: request.body.rolling_budget_escalatable }),
            ...(request.body.transaction_count_escalatable === undefined
              ? {}
              : {
                  transactionCountEscalatable:
                    request.body.transaction_count_escalatable,
                }),
          })
          return reply.code(201).send(policy)
        },
      )
      app.post<{
        Params: { policyId: string }
        Body: { account_id: string; version?: number }
      }>(
        '/v2/policies/:policyId/activate',
        {
          schema: {
            params: {
              type: 'object',
              additionalProperties: false,
              properties: { policyId: { type: 'string', minLength: 1, maxLength: 64 } },
              required: ['policyId'],
            },
            body: {
              type: 'object',
              additionalProperties: false,
              properties: {
                account_id: { type: 'string', minLength: 1, maxLength: 64 },
                version: { type: 'integer', minimum: 1 },
              },
              required: ['account_id'],
            },
            response: { 200: v2PolicyResponseSchema },
          },
        },
        async (request) => {
          const operatorId = getAdminOperatorId(request, options.config.adminApiKey)
          return management.activatePolicy(
            request.body.account_id,
            request.params.policyId,
            request.body.version,
            operatorId,
          )
        },
      )

      app.get<{ Params: { accountId: string } }>(
        '/v2/accounts/:accountId/approvals',
        {
          schema: {
            params: accountParams,
            response: { 200: v2ApprovalListResponseSchema },
          },
        },
        async (request) => {
          assertAdminApiKey(request, options.config.adminApiKey)
          return { approvals: await management.listApprovals(request.params.accountId) }
        },
      )
      app.post<{
        Params: { accountId: string; approvalId: string }
        Body: {
          action: 'APPROVE' | 'REJECT' | 'EXPIRE'
          actor_id?: string
          comment?: string
          row_version: number
        }
      }>(
        '/v2/accounts/:accountId/approvals/:approvalId/decision',
        {
          schema: {
            params: {
              ...accountParams,
              properties: {
                ...accountParams.properties,
                approvalId: { type: 'string', minLength: 1, maxLength: 64 },
              },
              required: ['accountId', 'approvalId'],
            },
            body: {
              type: 'object',
              additionalProperties: false,
              properties: {
                action: { type: 'string', enum: ['APPROVE', 'REJECT', 'EXPIRE'] },
                actor_id: { type: 'string', minLength: 1, maxLength: 255 },
                comment: { type: 'string', maxLength: 500 },
                row_version: { type: 'integer', minimum: 1 },
              },
              required: ['action', 'row_version'],
            },
            response: { 200: v2ApprovalResponseSchema },
          },
        },
        async (request) => {
          const operatorId = getAdminOperatorId(request, options.config.adminApiKey)
          return management.decideApproval({
            accountId: request.params.accountId,
            approvalId: request.params.approvalId,
            action: request.body.action,
            actorId: operatorId,
            rowVersion: request.body.row_version,
            ...(request.body.comment === undefined
              ? {}
              : { comment: request.body.comment }),
          })
        },
      )

      app.get<{ Params: { accountId: string } }>(
        '/v2/accounts/:accountId/approved-destinations',
        {
          schema: {
            params: accountParams,
            response: { 200: v2ApprovedDestinationListResponseSchema },
          },
        },
        async (request) => {
          assertAdminApiKey(request, options.config.adminApiKey)
          return {
            approved_destinations: await management.listApprovedDestinations(
              request.params.accountId,
            ),
          }
        },
      )
      app.post<{
        Params: { accountId: string }
        Body: {
          fingerprint: string
          rail: string
          network: string
          asset_reference: string
          destination: string
          actor_id?: string
          reason?: string
        }
      }>(
        '/v2/accounts/:accountId/approved-destinations',
        {
          schema: {
            params: accountParams,
            response: { 201: v2ApprovedDestinationResponseSchema },
            body: {
              type: 'object',
              additionalProperties: false,
              properties: {
                fingerprint: { type: 'string', minLength: 1, maxLength: 64 },
                rail: { type: 'string', minLength: 1, maxLength: 64 },
                network: { type: 'string', minLength: 1, maxLength: 64 },
                asset_reference: { type: 'string', minLength: 1, maxLength: 255 },
                destination: { type: 'string', minLength: 1, maxLength: 255 },
                actor_id: { type: 'string', minLength: 1, maxLength: 255 },
                reason: { type: 'string', maxLength: 500 },
              },
              required: [
                'fingerprint',
                'rail',
                'network',
                'asset_reference',
                'destination',
              ],
            },
          },
        },
        async (request, reply) => {
          const operatorId = getAdminOperatorId(request, options.config.adminApiKey)
          const destination = await management.createApprovedDestination({
            accountId: request.params.accountId,
            fingerprint: request.body.fingerprint,
            rail: request.body.rail,
            network: request.body.network,
            assetReference: request.body.asset_reference,
            destination: request.body.destination,
            actorId: operatorId,
            ...(request.body.reason === undefined
              ? {}
              : { reason: request.body.reason }),
          })
          return reply.code(201).send(destination)
        },
      )
      app.post<{
        Params: { accountId: string; destinationId: string }
        Body: { actor_id?: string; reason: string }
      }>(
        '/v2/accounts/:accountId/approved-destinations/:destinationId/revoke',
        {
          schema: {
            params: {
              ...accountParams,
              properties: {
                ...accountParams.properties,
                destinationId: { type: 'string', minLength: 1, maxLength: 64 },
              },
              required: ['accountId', 'destinationId'],
            },
            response: { 200: v2StatusResponseSchema },
            body: {
              type: 'object',
              additionalProperties: false,
              properties: {
                actor_id: { type: 'string', minLength: 1, maxLength: 255 },
                reason: { type: 'string', minLength: 1, maxLength: 500 },
              },
              required: ['reason'],
            },
          },
        },
        async (request) => {
          const operatorId = getAdminOperatorId(request, options.config.adminApiKey)
          await management.revokeApprovedDestination({
            accountId: request.params.accountId,
            id: request.params.destinationId,
            actorId: operatorId,
            reason: request.body.reason,
          })
          return { status: 'REVOKED' }
        },
      )

      app.get<{ Params: { accountId: string }; Querystring: { route_id?: string } }>(
        '/v2/accounts/:accountId/funding-destination',
        {
          preHandler: async (request) =>
            authenticateAgentWithScope(request, accountRepository, 'receive:manage'),
          schema: {
            params: accountParams,
            response: { 200: v2FundingDestinationResponseSchema },
            querystring: {
              type: 'object',
              additionalProperties: false,
              properties: { route_id: { type: 'string', minLength: 1, maxLength: 64 } },
            },
          },
        },
        async (request) => {
          const account = requireAgentAccount(request)
          if (account.account.id !== request.params.accountId)
            throw new ValidationError('Funding destination was not found')
          return management.getFundingDestination(
            request.params.accountId,
            request.query.route_id,
          )
        },
      )

      app.get<{
        Params: { accountId: string }
        Querystring: { denomination_id: string }
      }>(
        '/v2/accounts/:accountId/balance',
        {
          preHandler: async (request) =>
            authenticateAgentWithScope(request, accountRepository, 'balance:read'),
          schema: {
            params: accountParams,
            response: { 200: v2BalanceResponseSchema },
            querystring: {
              type: 'object',
              additionalProperties: false,
              properties: {
                denomination_id: { type: 'string', minLength: 1, maxLength: 64 },
              },
              required: ['denomination_id'],
            },
          },
        },
        async (request) => {
          const account = requireAgentAccount(request)
          if (account.account.id !== request.params.accountId)
            throw new ValidationError('Account was not found')
          return management.getBalance(
            request.params.accountId,
            request.query.denomination_id,
          )
        },
      )
      app.get<{ Querystring: { denomination_id: string } }>(
        '/v2/balance',
        {
          preHandler: async (request) =>
            authenticateAgentWithScope(request, accountRepository, 'balance:read'),
          schema: {
            response: { 200: v2BalanceResponseSchema },
            querystring: {
              type: 'object',
              additionalProperties: false,
              properties: {
                denomination_id: { type: 'string', minLength: 1, maxLength: 64 },
              },
              required: ['denomination_id'],
            },
          },
        },
        async (request) => {
          const account = requireAgentAccount(request)
          return management.getBalance(
            account.account.id,
            request.query.denomination_id,
          )
        },
      )
      app.get<{ Querystring: { route_id?: string } }>(
        '/v2/funding-destination',
        {
          preHandler: async (request) =>
            authenticateAgentWithScope(request, accountRepository, 'receive:manage'),
          schema: {
            response: { 200: v2FundingDestinationResponseSchema },
            querystring: {
              type: 'object',
              additionalProperties: false,
              properties: { route_id: { type: 'string', minLength: 1, maxLength: 64 } },
            },
          },
        },
        async (request) => {
          const account = requireAgentAccount(request)
          return management.getFundingDestination(
            account.account.id,
            request.query.route_id,
          )
        },
      )
      app.get<{ Querystring: { limit?: number; cursor?: string } }>(
        '/v2/history',
        {
          preHandler: async (request) =>
            authenticateAgentWithScope(request, accountRepository, 'history:read'),
          schema: {
            response: { 200: v2HistoryResponseSchema },
            querystring: {
              type: 'object',
              additionalProperties: false,
              properties: {
                limit: {
                  type: 'integer',
                  minimum: 1,
                  maximum: runtimeLimits.maxPageSize,
                  default: 50,
                },
                cursor: { type: 'string', minLength: 1 },
              },
            },
          },
        },
        async (request) =>
          management.listHistory(
            requireAgentAccount(request).account.id,
            request.query,
          ),
      )

      app.get<{
        Params: { accountId: string }
        Querystring: { limit?: number; cursor?: string }
      }>(
        '/v2/accounts/:accountId/history',
        {
          preHandler: async (request) =>
            authenticateAgentWithScope(request, accountRepository, 'history:read'),
          schema: {
            params: accountParams,
            response: { 200: v2HistoryResponseSchema },
            querystring: {
              type: 'object',
              additionalProperties: false,
              properties: {
                limit: {
                  type: 'integer',
                  minimum: 1,
                  maximum: runtimeLimits.maxPageSize,
                  default: 50,
                },
                cursor: { type: 'string', minLength: 1 },
              },
            },
          },
        },
        async (request) => {
          const account = requireAgentAccount(request)
          if (account.account.id !== request.params.accountId)
            throw new ValidationError('Account was not found')
          return management.listHistory(request.params.accountId, request.query)
        },
      )
    }

    if (options.v2ReceiveService !== undefined) {
      const receive = options.v2ReceiveService
      const receiveParams = {
        type: 'object',
        additionalProperties: false,
        properties: { accountId: { type: 'string', minLength: 1, maxLength: 64 } },
        required: ['accountId'],
      } as const
      app.post<{
        Params: { accountId: string }
        Body: {
          amount?: string
          denomination_id: string
          reference?: string
          expires_at?: string
        }
      }>(
        '/v2/accounts/:accountId/receive-requests',
        {
          preHandler: async (request) => {
            await authenticateAgentWithScope(
              request,
              accountRepository,
              'receive:manage',
            )
            await enforceRateLimit(
              options.v2AdminRepository,
              request,
              'receive:create',
              runtimeLimits.receiveRateLimitPerWindow,
              runtimeLimits.requestRateLimitWindowSeconds,
            )
          },
          schema: {
            response: { 201: v2ReceiveResponseSchema },
            params: receiveParams,
            headers: {
              type: 'object',
              properties: {
                'idempotency-key': { type: 'string', minLength: 1, maxLength: 255 },
              },
              required: ['idempotency-key'],
            },
            body: {
              type: 'object',
              additionalProperties: false,
              properties: {
                amount: { type: 'string', minLength: 1, maxLength: 256 },
                denomination_id: { type: 'string', minLength: 1, maxLength: 64 },
                reference: { type: 'string', minLength: 1, maxLength: 255 },
                expires_at: { type: 'string', minLength: 1 },
              },
              required: ['denomination_id'],
            },
          },
        },
        async (request, reply) => {
          const account = requireAgentAccount(request)
          if (account.account.id !== request.params.accountId)
            throw new ValidationError('Account was not found')
          const result = await receive.createReceiveRequest(
            account.account.id,
            account.account.solanaPublicKey,
            {
              denominationId: request.body.denomination_id,
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
            getIdempotencyKey(request),
          )
          return reply.code(201).send(result)
        },
      )
      app.post<{
        Body: {
          amount?: string
          denomination_id: string
          reference?: string
          expires_at?: string
        }
      }>(
        '/v2/receive-requests',
        {
          preHandler: async (request) => {
            await authenticateAgentWithScope(
              request,
              accountRepository,
              'receive:manage',
            )
            await enforceRateLimit(
              options.v2AdminRepository,
              request,
              'receive:create',
              runtimeLimits.receiveRateLimitPerWindow,
              runtimeLimits.requestRateLimitWindowSeconds,
            )
          },
          schema: {
            response: { 201: v2ReceiveResponseSchema },
            headers: {
              type: 'object',
              properties: {
                'idempotency-key': { type: 'string', minLength: 1, maxLength: 255 },
              },
              required: ['idempotency-key'],
            },
            body: {
              type: 'object',
              additionalProperties: false,
              properties: {
                amount: { type: 'string', minLength: 1, maxLength: 256 },
                denomination_id: { type: 'string', minLength: 1, maxLength: 64 },
                reference: { type: 'string', minLength: 1, maxLength: 255 },
                expires_at: { type: 'string', minLength: 1 },
              },
              required: ['denomination_id'],
            },
          },
        },
        async (request, reply) => {
          const account = requireAgentAccount(request)
          const result = await receive.createReceiveRequest(
            account.account.id,
            account.account.solanaPublicKey,
            {
              denominationId: request.body.denomination_id,
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
            getIdempotencyKey(request),
          )
          return reply.code(201).send(result)
        },
      )
      app.get<{
        Params: { accountId: string }
        Querystring: { limit?: number; cursor?: string }
      }>(
        '/v2/accounts/:accountId/receive-requests',
        {
          preHandler: async (request) =>
            authenticateAgentWithScope(request, accountRepository, 'receive:manage'),
          schema: {
            params: receiveParams,
            response: { 200: v2ReceiveListResponseSchema },
            querystring: {
              type: 'object',
              additionalProperties: false,
              properties: {
                limit: {
                  type: 'integer',
                  minimum: 1,
                  maximum: runtimeLimits.maxPageSize,
                  default: 50,
                },
                cursor: { type: 'string', minLength: 1 },
              },
            },
          },
        },
        async (request) => {
          const account = requireAgentAccount(request)
          if (account.account.id !== request.params.accountId)
            throw new ValidationError('Account was not found')
          return receive.listReceiveRequestsPage(
            account.account.id,
            account.account.solanaPublicKey,
            request.query,
          )
        },
      )
      app.get<{ Params: { accountId: string; receiveId: string } }>(
        '/v2/accounts/:accountId/receive-requests/:receiveId',
        {
          preHandler: async (request) =>
            authenticateAgentWithScope(request, accountRepository, 'receive:manage'),
          schema: {
            params: {
              ...receiveParams,
              properties: {
                ...receiveParams.properties,
                receiveId: { type: 'string', minLength: 1, maxLength: 64 },
              },
              required: ['accountId', 'receiveId'],
            },
            response: { 200: v2ReceiveResponseSchema },
          },
        },
        async (request) => {
          const account = requireAgentAccount(request)
          if (account.account.id !== request.params.accountId)
            throw new ValidationError('Account was not found')
          return receive.getReceiveRequest(
            account.account.id,
            account.account.solanaPublicKey,
            request.params.receiveId,
          )
        },
      )
      app.post<{ Params: { accountId: string; receiveId: string } }>(
        '/v2/accounts/:accountId/receive-requests/:receiveId/cancel',
        {
          preHandler: async (request) =>
            authenticateAgentWithScope(request, accountRepository, 'receive:manage'),
          schema: {
            params: {
              ...receiveParams,
              properties: {
                ...receiveParams.properties,
                receiveId: { type: 'string', minLength: 1, maxLength: 64 },
              },
              required: ['accountId', 'receiveId'],
            },
            response: { 200: v2ReceiveResponseSchema },
          },
        },
        async (request) => {
          const account = requireAgentAccount(request)
          if (account.account.id !== request.params.accountId)
            throw new ValidationError('Account was not found')
          return receive.cancelReceiveRequest(
            account.account.id,
            account.account.solanaPublicKey,
            request.params.receiveId,
          )
        },
      )
      app.get<{ Querystring: { limit?: number; cursor?: string } }>(
        '/v2/receive-requests',
        {
          preHandler: async (request) =>
            authenticateAgentWithScope(request, accountRepository, 'receive:manage'),
          schema: {
            response: { 200: v2ReceiveListResponseSchema },
            querystring: {
              type: 'object',
              additionalProperties: false,
              properties: {
                limit: {
                  type: 'integer',
                  minimum: 1,
                  maximum: runtimeLimits.maxPageSize,
                  default: 50,
                },
                cursor: { type: 'string', minLength: 1 },
              },
            },
          },
        },
        async (request) => {
          const account = requireAgentAccount(request).account
          return receive.listReceiveRequestsPage(
            account.id,
            account.solanaPublicKey,
            request.query,
          )
        },
      )
      app.get<{ Params: { receiveId: string } }>(
        '/v2/receive-requests/:receiveId',
        {
          preHandler: async (request) =>
            authenticateAgentWithScope(request, accountRepository, 'receive:manage'),
          schema: {
            params: {
              type: 'object',
              additionalProperties: false,
              properties: {
                receiveId: { type: 'string', minLength: 1, maxLength: 64 },
              },
              required: ['receiveId'],
            },
            response: { 200: v2ReceiveResponseSchema },
          },
        },
        async (request) => {
          const account = requireAgentAccount(request)
          return receive.getReceiveRequest(
            account.account.id,
            account.account.solanaPublicKey,
            request.params.receiveId,
          )
        },
      )
      app.post<{ Params: { receiveId: string } }>(
        '/v2/receive-requests/:receiveId/cancel',
        {
          preHandler: async (request) =>
            authenticateAgentWithScope(request, accountRepository, 'receive:manage'),
          schema: {
            params: {
              type: 'object',
              additionalProperties: false,
              properties: {
                receiveId: { type: 'string', minLength: 1, maxLength: 64 },
              },
              required: ['receiveId'],
            },
            response: { 200: v2ReceiveResponseSchema },
          },
        },
        async (request) => {
          const account = requireAgentAccount(request)
          return receive.cancelReceiveRequest(
            account.account.id,
            account.account.solanaPublicKey,
            request.params.receiveId,
          )
        },
      )
    }

    if (options.v2OperationsService !== undefined) {
      registerV2OperationsRoutes(app, {
        config: options.config,
        accountRepository,
        service: options.v2OperationsService,
      })
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

  app.get(
    '/health/ready',
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
    const isV2 = request.url.startsWith('/v2/')
    return reply
      .code(statusCode)
      .send(getErrorResponse(error, statusCode, request.id, isV2))
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

async function enforceRateLimit(
  repository: Pick<V2AdminRepository, 'consumeRateLimit'> | undefined,
  request: Parameters<typeof authenticateAgent>[0],
  bucket: string,
  limit: number,
  windowSeconds: number,
): Promise<void> {
  if (repository === undefined) return
  const account = requireAgentAccount(request)
  const result = await repository.consumeRateLimit({
    subjectType: 'AGENT_ACCOUNT',
    subjectId: account.account.id,
    bucket,
    windowSeconds,
    limit,
  })
  if (!result.allowed) throw new RateLimitedError()
}

async function enforceRequestRateLimits(
  repository: Pick<V2AdminRepository, 'consumeRateLimit'>,
  request: Parameters<typeof authenticateAgent>[0],
  limits: ReturnType<typeof getRuntimeLimits>,
): Promise<void> {
  const subjectId = getRequestRateLimitSubject(request)
  const requestLimit = await repository.consumeRateLimit({
    subjectType: 'HTTP_CLIENT',
    subjectId,
    bucket: REQUEST_RATE_LIMIT_BUCKET,
    windowSeconds: limits.requestRateLimitWindowSeconds,
    limit: limits.requestRateLimitPerWindow,
  })
  if (!requestLimit.allowed) throw new RateLimitedError()

  const burstLimit = await repository.consumeRateLimit({
    subjectType: 'HTTP_CLIENT',
    subjectId,
    bucket: REQUEST_BURST_LIMIT_BUCKET,
    windowSeconds: limits.requestBurstWindowSeconds,
    limit: limits.requestBurstLimit,
  })
  if (!burstLimit.allowed) throw new RateLimitedError()
}

function getRequestRateLimitSubject(
  request: Parameters<typeof authenticateAgent>[0],
): string {
  const authorization = request.headers.authorization
  if (typeof authorization === 'string' && authorization.startsWith('Bearer ')) {
    const apiKey = authorization.slice('Bearer '.length).trim()
    if (apiKey.length > 0) return `credential:${hashApiKey(apiKey)}`
  }
  const adminApiKey = request.headers[ADMIN_API_KEY_HEADER]
  const adminValue = Array.isArray(adminApiKey) ? adminApiKey[0] : adminApiKey
  if (typeof adminValue === 'string' && adminValue.length > 0) {
    return `admin:${hashApiKey(adminValue)}`
  }
  return `ip:${request.ip}`
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
