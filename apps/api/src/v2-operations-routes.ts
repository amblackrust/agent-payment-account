import type { FastifyInstance } from 'fastify'
import { AuthenticationError } from '@agent-payment/core'
import type { AccountRepository, AuthenticatedAccount } from '@agent-payment/db'
import { getRuntimeLimits, type AppConfig } from './config.js'
import { authenticateAgentWithScope, getAdminOperatorId } from './auth.js'
import type { V2OperationsService } from './v2-operations.js'
import {
  v2ExceptionListResponseSchema,
  v2ExceptionResponseSchema,
  v2StatusResponseSchema,
  v2TimelineResponseSchema,
  v2WebhookSubscriptionListResponseSchema,
  v2WebhookSubscriptionResponseSchema,
} from './v2-response-schemas.js'

const exceptionParams = {
  type: 'object',
  additionalProperties: false,
  properties: { exceptionId: { type: 'string', minLength: 1, maxLength: 64 } },
  required: ['exceptionId'],
} as const

const operatorActionBody = {
  type: 'object',
  additionalProperties: false,
  properties: {
    operator_id: { type: 'string', minLength: 1, maxLength: 255 },
    row_version: { type: 'integer', minimum: 1 },
  },
  required: ['row_version'],
} as const

const operatorResolutionBody = {
  ...operatorActionBody,
  properties: {
    ...operatorActionBody.properties,
    evidence_id: { type: 'string', minLength: 1, maxLength: 64 },
  },
} as const

export function registerV2OperationsRoutes(
  app: FastifyInstance,
  options: {
    readonly config: AppConfig
    readonly accountRepository: AccountRepository
    readonly service: V2OperationsService
  },
): void {
  const maxPageSize = getRuntimeLimits(options.config).maxPageSize
  app.get<{
    Querystring: {
      limit?: number
      cursor?: string
      resource_type?: string
      resource_id?: string
    }
  }>(
    '/v2/timeline',
    {
      preHandler: async (request) =>
        authenticateAgentWithScope(request, options.accountRepository, 'history:read'),
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: maxPageSize },
            cursor: { type: 'string', minLength: 1 },
            resource_type: { type: 'string', minLength: 1, maxLength: 64 },
            resource_id: { type: 'string', minLength: 1, maxLength: 64 },
          },
        },
        response: { 200: v2TimelineResponseSchema },
      },
    },
    async (request) => {
      const account = requireAccount(request)
      return options.service.listTimeline(account.account.id, {
        ...(request.query.limit === undefined ? {} : { limit: request.query.limit }),
        ...(request.query.cursor === undefined ? {} : { cursor: request.query.cursor }),
        ...(request.query.resource_type === undefined
          ? {}
          : { resourceType: request.query.resource_type }),
        ...(request.query.resource_id === undefined
          ? {}
          : { resourceId: request.query.resource_id }),
      })
    },
  )

  app.get(
    '/v2/webhooks',
    {
      preHandler: async (request) =>
        authenticateAgentWithScope(
          request,
          options.accountRepository,
          'webhooks:manage',
        ),
      schema: { response: { 200: v2WebhookSubscriptionListResponseSchema } },
    },
    async (request) => ({
      subscriptions: await options.service.listWebhooks(
        requireAccount(request).account.id,
      ),
    }),
  )

  app.post<{
    Body: {
      endpoint: string
      event_types: string[]
      signing_key_ref: string
      signing_key_version: number
    }
  }>(
    '/v2/webhooks',
    {
      preHandler: async (request) =>
        authenticateAgentWithScope(
          request,
          options.accountRepository,
          'webhooks:manage',
        ),
      schema: {
        response: { 201: v2WebhookSubscriptionResponseSchema },
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            endpoint: { type: 'string', minLength: 1, maxLength: 2048 },
            event_types: {
              type: 'array',
              minItems: 1,
              items: { type: 'string', minLength: 1 },
            },
            signing_key_ref: { type: 'string', minLength: 1, maxLength: 255 },
            signing_key_version: { type: 'integer', minimum: 1 },
          },
          required: [
            'endpoint',
            'event_types',
            'signing_key_ref',
            'signing_key_version',
          ],
        },
      },
    },
    async (request, reply) => {
      const account = requireAccount(request)
      const subscription = await options.service.createWebhook({
        accountId: account.account.id,
        endpoint: request.body.endpoint,
        eventTypes: request.body.event_types,
        signingKeyRef: request.body.signing_key_ref,
        signingKeyVersion: request.body.signing_key_version,
      })
      return reply.code(201).send(subscription)
    },
  )

  app.post<{ Params: { webhookId: string } }>(
    '/v2/webhooks/:webhookId/archive',
    {
      preHandler: async (request) =>
        authenticateAgentWithScope(
          request,
          options.accountRepository,
          'webhooks:manage',
        ),
      schema: {
        params: {
          type: 'object',
          additionalProperties: false,
          properties: { webhookId: { type: 'string', minLength: 1, maxLength: 64 } },
          required: ['webhookId'],
        },
        response: { 200: v2StatusResponseSchema },
      },
    },
    async (request) => {
      await options.service.archiveWebhook(
        requireAccount(request).account.id,
        request.params.webhookId,
      )
      return { status: 'ARCHIVED' }
    },
  )

  app.get<{ Querystring: { status?: string; limit?: number } }>(
    '/v2/operator/exceptions',
    {
      schema: {
        response: { 200: v2ExceptionListResponseSchema },
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            status: { type: 'string', minLength: 1, maxLength: 32 },
            limit: { type: 'integer', minimum: 1, maximum: maxPageSize },
          },
        },
      },
    },
    async (request) => {
      getAdminOperatorId(request, options.config.adminApiKey)
      return {
        exceptions: await options.service.listExceptions({
          ...(request.query.status === undefined
            ? {}
            : { status: request.query.status }),
          ...(request.query.limit === undefined ? {} : { limit: request.query.limit }),
        }),
      }
    },
  )

  app.get<{ Params: { exceptionId: string } }>(
    '/v2/operator/exceptions/:exceptionId',
    {
      schema: {
        params: exceptionParams,
        response: { 200: v2ExceptionResponseSchema },
      },
    },
    async (request) => {
      getAdminOperatorId(request, options.config.adminApiKey)
      return options.service.getException(request.params.exceptionId)
    },
  )

  app.post<{
    Params: { exceptionId: string }
    Body: { operator_id?: string; row_version: number }
  }>(
    '/v2/operator/exceptions/:exceptionId/acknowledge',
    {
      schema: {
        params: exceptionParams,
        body: operatorActionBody,
        response: { 200: v2ExceptionResponseSchema },
      },
    },
    async (request) => {
      const operatorId = getAdminOperatorId(request, options.config.adminApiKey)
      return options.service.acknowledgeException({
        id: request.params.exceptionId,
        operatorId,
        rowVersion: request.body.row_version,
      })
    },
  )

  app.post<{
    Params: { exceptionId: string }
    Body: { operator_id?: string; row_version: number; evidence_id?: string }
  }>(
    '/v2/operator/exceptions/:exceptionId/resolve-confirmed',
    {
      schema: {
        params: exceptionParams,
        body: operatorResolutionBody,
        response: { 200: v2ExceptionResponseSchema },
      },
    },
    async (request) => {
      const operatorId = getAdminOperatorId(request, options.config.adminApiKey)
      return options.service.resolveConfirmedException({
        id: request.params.exceptionId,
        operatorId,
        rowVersion: request.body.row_version,
        ...(request.body.evidence_id === undefined
          ? {}
          : { evidenceId: request.body.evidence_id }),
      })
    },
  )

  app.post<{
    Params: { exceptionId: string }
    Body: { operator_id?: string; row_version: number; evidence_id?: string }
  }>(
    '/v2/operator/exceptions/:exceptionId/resolve-proved-no-effect',
    {
      schema: {
        params: exceptionParams,
        body: operatorResolutionBody,
        response: { 200: v2ExceptionResponseSchema },
      },
    },
    async (request) => {
      const operatorId = getAdminOperatorId(request, options.config.adminApiKey)
      return options.service.resolveProvedNoEffectException({
        id: request.params.exceptionId,
        operatorId,
        rowVersion: request.body.row_version,
        ...(request.body.evidence_id === undefined
          ? {}
          : { evidenceId: request.body.evidence_id }),
      })
    },
  )

  app.post<{
    Params: { exceptionId: string }
    Body: { operator_id?: string; row_version: number }
  }>(
    '/v2/operator/exceptions/:exceptionId/close-unresolved',
    {
      schema: {
        params: exceptionParams,
        body: operatorActionBody,
        response: { 200: v2ExceptionResponseSchema },
      },
    },
    async (request) => {
      const operatorId = getAdminOperatorId(request, options.config.adminApiKey)
      return options.service.closeUnresolvedException({
        id: request.params.exceptionId,
        operatorId,
        rowVersion: request.body.row_version,
      })
    },
  )
}

function requireAccount(request: {
  readonly agentAccount: AuthenticatedAccount | null
}) {
  if (request.agentAccount === null) throw new AuthenticationError()
  return request.agentAccount
}
