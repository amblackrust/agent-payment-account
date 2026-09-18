import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import {
  AgentPaymentAccount,
  AuthenticationError,
  ConflictError,
  ExternalServiceError,
  InsufficientFundsError,
  PaymentPendingError,
  PolicyDeniedError,
  RecipientError,
  RefundNotSupportedError,
  UnsupportedRailError,
  ValidationError,
  type Payment,
} from './index.js'

const payment: Record<string, unknown> = {
  id: 'pay_test',
  recipient_id: 'rcpt_test',
  kind: 'PAY',
  amount: '1.20',
  currency: 'USD',
  status: 'CONFIRMED',
  description: 'dataset access',
  external_reference: 'order-1',
  route: 'SOLANA_SPL',
  created_at: '2026-09-06T00:00:00.000Z',
  updated_at: '2026-09-06T00:00:01.000Z',
  confirmed_at: '2026-09-06T00:00:01.000Z',
  failed_at: null,
  failure_code: null,
  failure_message: null,
  original_payment_id: null,
}

const receive = {
  id: 'recv_test',
  account_id: 'acct_test',
  amount: null,
  currency: 'USD',
  reference: 'receive-reference',
  status: 'OPEN',
  created_at: '2026-09-06T00:00:00.000Z',
  expires_at: null,
  paid_at: null,
  destination: {
    type: 'external_transfer_target',
    reference: 'token-account',
  },
  settlement: {
    owner: 'owner-address',
    token_account: 'token-account',
    mint: 'mint-address',
  },
}

const transaction = {
  id: 'in_test',
  direction: 'INCOMING',
  kind: 'RECEIVE',
  amount: '1.20',
  currency: 'USD',
  status: 'CONFIRMED',
  counterparty: {
    recipient_id: null,
    display_name: null,
    account_id: null,
    address: 'source-address',
  },
  created_at: '2026-09-06T00:00:00.000Z',
  updated_at: '2026-09-06T00:00:01.000Z',
  confirmed_at: '2026-09-06T00:00:01.000Z',
  signature: 'signature',
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

async function fastifyFetch(
  app: ReturnType<typeof Fastify>,
  input: URL | RequestInfo,
  init?: RequestInit,
): Promise<Response> {
  const headers = new Headers(init?.headers)
  const inputUrl =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url
  const response = await app.inject({
    method: (init?.method ?? 'GET') as 'GET' | 'POST' | 'PATCH',
    url: `${new URL(inputUrl).pathname}${new URL(inputUrl).search}`,
    headers: Object.fromEntries(headers.entries()),
    ...(init?.body === undefined ? {} : { payload: JSON.parse(String(init.body)) }),
  })
  return new Response(response.body, {
    status: response.statusCode,
    headers: { 'content-type': 'application/json' },
  })
}

async function createLocalApi() {
  const app = Fastify()
  const requests: {
    method: string
    url: string
    idempotencyKey: string | undefined
  }[] = []
  app.addHook('onRequest', async (request, reply) => {
    if (request.headers.authorization !== 'Bearer agent-secret') {
      return reply
        .code(401)
        .send({ error: 'AUTHENTICATION_ERROR', message: 'Authentication failed' })
    }
  })
  app.get('/v1/balance', async () => ({
    currency: 'USD',
    settled: '10.00',
    pending_outgoing: '1.20',
    available: '8.80',
  }))
  app.post('/v1/pay', async (request) => {
    requests.push({
      method: request.method,
      url: request.url,
      idempotencyKey: Array.isArray(request.headers['idempotency-key'])
        ? request.headers['idempotency-key'][0]
        : request.headers['idempotency-key'],
    })
    return payment
  })
  app.post('/v1/send', async () => ({ ...payment, kind: 'SEND' }))
  app.post('/v1/refunds', async () => ({
    ...payment,
    id: 'pay_refund',
    kind: 'REFUND',
    recipient_id: null,
    original_payment_id: 'pay_original',
  }))
  app.post('/v1/receives', async () => receive)
  app.get('/v1/receives/:receiveId', async () => receive)
  app.get('/v1/payments/:paymentId', async () => payment)
  app.get('/v1/transactions', async () => ({
    transactions: [transaction],
    next_cursor: null,
  }))
  return { app, requests }
}

const v2Account = {
  id: 'acct_test',
  name: 'Test account',
  status: 'ACTIVE',
  solana_public_key: 'owner-address',
  workspace_id: null,
  runtime_version: 'v2',
  provisioning_failure_code: null,
  disabled_at: null,
  disabled_reason: null,
  row_version: 1,
  created_at: '2026-09-06T00:00:00.000Z',
  updated_at: '2026-09-06T00:00:00.000Z',
}

const v2Recipient = {
  id: 'rcpt_test',
  display_name: 'Test recipient',
  type: 'SOLANA_SPL',
  managed_account_id: null,
  destinations: [
    {
      id: 'dest_test',
      rail: 'SOLANA_SPL',
      type: 'SOLANA_SPL',
      wallet_address: 'recipient-address',
    },
  ],
  created_at: '2026-09-06T00:00:00.000Z',
  updated_at: '2026-09-06T00:00:00.000Z',
}

const v2Receive = {
  id: 'recv_v2_test',
  account_id: 'acct_test',
  amount: '1.250',
  denomination_id: 'usd',
  currency: 'USD',
  reference: 'receive-v2-reference',
  status: 'OPEN',
  created_at: '2026-09-06T00:00:00.000Z',
  expires_at: null,
  paid_at: null,
  destination: {
    type: 'external_transfer_target',
    reference: 'token-account',
  },
  settlement: {
    owner: 'owner-address',
    token_account: 'token-account',
    mint: 'mint-address',
  },
}

const v2Balance = {
  account_id: 'acct_test',
  denomination_id: 'usd',
  settled: '10.00',
  reserved: '1.20',
  spendable: '8.80',
  observed_at: '2026-09-06T00:00:00.000Z',
  degraded: false,
}

async function createLocalV2Api(balance = v2Balance) {
  const app = Fastify()
  app.get('/v2/accounts/:accountId', async () => v2Account)
  app.get('/v2/balance', async () => balance)
  app.post('/v2/recipients', async () => v2Recipient)
  app.get('/v2/recipients', async () => ({
    recipients: [v2Recipient],
    next_cursor: null,
  }))
  app.get('/v2/recipients/:recipientId', async () => v2Recipient)
  app.patch('/v2/recipients/:recipientId', async () => v2Recipient)
  app.post('/v2/recipients/:recipientId/archive', async () => ({ status: 'ARCHIVED' }))
  app.post('/v2/receive-requests', async () => v2Receive)
  app.get('/v2/receive-requests/:receiveId', async () => v2Receive)
  app.get('/v2/receive-requests', async () => ({
    receive_requests: [v2Receive],
    next_cursor: null,
  }))
  app.post('/v2/receive-requests/:receiveId/cancel', async () => ({
    ...v2Receive,
    status: 'CANCELLED',
  }))
  return app
}

describe('AgentPaymentAccount SDK', () => {
  it('keeps V2 account, recipient, and receive contracts in parity with HTTP', async () => {
    const app = await createLocalV2Api()
    const account = new AgentPaymentAccount({
      baseUrl: 'http://localhost:3000/',
      apiKey: 'agent-secret',
      fetch: fastifyFetch.bind(undefined, app),
    })

    try {
      await expect(account.getAccount('acct_test')).resolves.toMatchObject({
        id: 'acct_test',
        name: 'Test account',
        rowVersion: 1,
      })
      await expect(account.getBalanceV2('usd')).resolves.toMatchObject({
        accountId: 'acct_test',
        settled: '10.00',
        spendable: '8.80',
      })
      await expect(
        account.createRecipientV2({
          displayName: 'Test recipient',
          type: 'SOLANA_SPL',
          destination: { type: 'SOLANA_SPL', walletAddress: 'recipient-address' },
        }),
      ).resolves.toMatchObject({
        id: 'rcpt_test',
        destinations: [{ walletAddress: 'recipient-address' }],
      })
      await expect(account.listRecipientsV2Page({ limit: 1 })).resolves.toMatchObject({
        recipients: [{ id: 'rcpt_test' }],
        nextCursor: null,
      })
      await expect(account.getRecipientV2('rcpt_test')).resolves.toMatchObject({
        displayName: 'Test recipient',
      })
      await expect(
        account.updateRecipientV2('rcpt_test', {
          rowVersion: 1,
          displayName: 'Renamed',
        }),
      ).resolves.toMatchObject({ id: 'rcpt_test' })
      await expect(account.archiveRecipientV2('rcpt_test', 2)).resolves.toBeUndefined()
      await expect(
        account.createReceiveV2(
          { denominationId: 'usd', amount: '1.250' },
          { idempotencyKey: 'receive-v2-key' },
        ),
      ).resolves.toMatchObject({ denominationId: 'usd', amount: '1.250' })
      await expect(account.getReceiveV2('recv_v2_test')).resolves.toMatchObject({
        id: 'recv_v2_test',
      })
      await expect(account.listReceiveV2Page({ limit: 1 })).resolves.toMatchObject({
        receiveRequests: [{ id: 'recv_v2_test' }],
        nextCursor: null,
      })
      await expect(account.cancelReceiveV2('recv_v2_test')).resolves.toMatchObject({
        status: 'CANCELLED',
      })
    } finally {
      await app.close()
    }
  })

  it('rejects V2 balance responses outside the canonical exact-money contract', async () => {
    const app = await createLocalV2Api({ ...v2Balance, settled: '1e-2' })
    const account = new AgentPaymentAccount({
      baseUrl: 'http://localhost:3000/',
      apiKey: 'agent-secret',
      fetch: fastifyFetch.bind(undefined, app),
    })

    try {
      await expect(account.getBalanceV2('usd')).rejects.toThrow(
        'API returned an invalid V2 balance response',
      )
    } finally {
      await app.close()
    }
  })

  it('preserves policy-denial recovery fields from the V2 error envelope', async () => {
    const account = new AgentPaymentAccount({
      baseUrl: 'https://payments.example.test',
      apiKey: 'agent-secret',
      fetch: async () =>
        jsonResponse(
          {
            code: 'POLICY_DENIED',
            message: 'Payment was denied by policy',
            request_id: 'req_policy_denied',
            payment_id: 'pay_policy_denied',
            payment_status: 'REJECTED_BY_POLICY',
            reason_codes: ['PER_PAYMENT_LIMIT'],
          },
          403,
        ),
    })

    const error = await account
      .createPaymentV2(
        {
          recipientId: 'rcpt_test',
          amount: '1.20',
          denominationId: 'usd',
        },
        'policy-denied-key',
      )
      .catch((value: unknown) => value)

    expect(error).toBeInstanceOf(PolicyDeniedError)
    expect(error).toMatchObject({
      paymentId: 'pay_policy_denied',
      paymentStatus: 'REJECTED_BY_POLICY',
      reasonCodes: ['PER_PAYMENT_LIMIT'],
      requestId: 'req_policy_denied',
    })
  })

  it('uses the local Fastify HTTP contract for the basic financial flow', async () => {
    const { app, requests } = await createLocalApi()
    const account = new AgentPaymentAccount({
      baseUrl: 'http://localhost:3000/',
      apiKey: 'agent-secret',
      fetch: fastifyFetch.bind(undefined, app),
    })

    try {
      await expect(account.getBalance()).resolves.toEqual({
        currency: 'USD',
        settled: '10.00',
        pendingOutgoing: '1.20',
        available: '8.80',
      })
      await expect(account.receive()).resolves.toMatchObject({
        id: 'recv_test',
        destination: { reference: 'token-account' },
      })
      await expect(account.getReceive('recv_test')).resolves.toMatchObject({
        id: 'recv_test',
        status: 'OPEN',
      })
      await expect(
        account.pay(
          {
            recipientId: 'rcpt_test',
            amount: '1.2',
            description: 'dataset access',
            externalReference: 'order-1',
          },
          { idempotencyKey: 'pay-key' },
        ),
      ).resolves.toMatchObject({
        id: 'pay_test',
        amount: '1.20',
      })
      await expect(
        account.send({ recipientId: 'rcpt_test', amount: '0.50' }, 'send-key'),
      ).resolves.toMatchObject({ kind: 'SEND' })
      await expect(
        account.refund(
          { originalPaymentId: 'pay_original', amount: '0.50' },
          'refund-key',
        ),
      ).resolves.toMatchObject({ kind: 'REFUND', recipientId: null })
      await expect(account.getPayment('pay_test')).resolves.toMatchObject({
        id: 'pay_test',
      })
      await expect(account.listTransactions()).resolves.toHaveLength(1)
      expect(requests).toEqual([
        { method: 'POST', url: '/v1/pay', idempotencyKey: 'pay-key' },
      ])
    } finally {
      await app.close()
    }
  })

  it('retries a timed out money request with the same generated idempotency key', async () => {
    let calls = 0
    const keys: (string | null)[] = []
    const account = new AgentPaymentAccount({
      baseUrl: 'https://payments.example.test',
      apiKey: 'agent-secret',
      retryCount: 1,
      fetch: async (_input, init) => {
        calls += 1
        keys.push(new Headers(init?.headers).get('idempotency-key'))
        if (calls === 1) throw new Error('network timeout')
        return jsonResponse(payment)
      },
    })

    await expect(
      account.pay({ recipientId: 'rcpt_test', amount: '1.20' }),
    ).resolves.toMatchObject({ id: 'pay_test' })
    expect(calls).toBe(2)
    expect(keys[0]).toBeTruthy()
    expect(keys[0]).toBe(keys[1])
  })

  it('surfaces an unknown POST outcome as pending after bounded retries', async () => {
    let calls = 0
    const account = new AgentPaymentAccount({
      baseUrl: 'https://payments.example.test',
      apiKey: 'agent-secret',
      retryCount: 1,
      fetch: async () => {
        calls += 1
        throw new Error('network timeout')
      },
    })

    await expect(
      account.send({ recipientId: 'rcpt_test', amount: '1.20' }, 'same-key'),
    ).rejects.toMatchObject({ code: 'PAYMENT_PENDING', idempotencyKey: 'same-key' })
    expect(calls).toBe(2)
  })

  it('normalizes API errors and rejects response contract drift', async () => {
    const response = (error: string, status: number) => async () =>
      jsonResponse({ error, message: 'safe message' }, status)
    await expect(
      new AgentPaymentAccount({
        baseUrl: 'https://payments.example.test',
        apiKey: 'bad',
        fetch: response('AUTHENTICATION_ERROR', 401),
      }).getBalance(),
    ).rejects.toBeInstanceOf(AuthenticationError)
    await expect(
      new AgentPaymentAccount({
        baseUrl: 'https://payments.example.test',
        apiKey: 'key',
        fetch: response('INSUFFICIENT_FUNDS', 409),
      }).pay({ recipientId: 'rcpt_test', amount: '1.20' }, 'funds-key'),
    ).rejects.toBeInstanceOf(InsufficientFundsError)
    await expect(
      new AgentPaymentAccount({
        baseUrl: 'https://payments.example.test',
        apiKey: 'key',
        fetch: response('RECIPIENT_RESOLUTION_FAILURE', 422),
      }).pay({ recipientId: 'missing', amount: '1.20' }, 'recipient-key'),
    ).rejects.toBeInstanceOf(RecipientError)
    await expect(
      new AgentPaymentAccount({
        baseUrl: 'https://payments.example.test',
        apiKey: 'key',
        fetch: response('CONFLICT', 409),
      }).pay({ recipientId: 'rcpt_test', amount: '1.20' }, 'conflict-key'),
    ).rejects.toBeInstanceOf(ConflictError)
    await expect(
      new AgentPaymentAccount({
        baseUrl: 'https://payments.example.test',
        apiKey: 'key',
        fetch: response('INTERNAL_ERROR', 500),
      }).getBalance(),
    ).rejects.toBeInstanceOf(ExternalServiceError)

    await expect(
      new AgentPaymentAccount({
        baseUrl: 'https://payments.example.test',
        apiKey: 'key',
        fetch: response('UNSUPPORTED_RAIL', 422),
      }).pay({ recipientId: 'rcpt_test', amount: '1.20' }, 'rail-key'),
    ).rejects.toBeInstanceOf(UnsupportedRailError)
    await expect(
      new AgentPaymentAccount({
        baseUrl: 'https://payments.example.test',
        apiKey: 'key',
        fetch: response('REFUND_NOT_SUPPORTED', 422),
      }).refund({ originalPaymentId: 'pay_external', amount: '1.20' }, 'refund-key'),
    ).rejects.toBeInstanceOf(RefundNotSupportedError)
    await expect(
      new AgentPaymentAccount({
        baseUrl: 'https://payments.example.test',
        apiKey: 'key',
        fetch: response('EXTERNAL_RAIL_FAILURE', 502),
      }).pay({ recipientId: 'rcpt_test', amount: '1.20' }, 'rail-failure-key'),
    ).rejects.toMatchObject({
      code: 'PAYMENT_PENDING',
      idempotencyKey: 'rail-failure-key',
    })
    await expect(
      new AgentPaymentAccount({
        baseUrl: 'https://payments.example.test',
        apiKey: 'key',
        fetch: async () =>
          jsonResponse(
            {
              error: 'EXTERNAL_RAIL_FAILURE',
              message: 'Recipient token account must already exist',
              details: { payment_id: 'pay_failed' },
            },
            422,
          ),
      }).pay({ recipientId: 'rcpt_test', amount: '1.20' }, 'deterministic-key'),
    ).rejects.toMatchObject({
      code: 'EXTERNAL_SERVICE_ERROR',
      statusCode: 422,
    })
    await expect(
      new AgentPaymentAccount({
        baseUrl: 'https://payments.example.test',
        apiKey: 'key',
        fetch: response('FST_ERR_VALIDATION', 400),
      }).pay({ recipientId: 'rcpt_test', amount: '1.20' }, 'validation-key'),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 })

    await expect(
      new AgentPaymentAccount({
        baseUrl: 'https://payments.example.test',
        apiKey: 'key',
        fetch: async () => jsonResponse({ settled: '1.2' }),
      }).getBalance(),
    ).rejects.toBeInstanceOf(ExternalServiceError)
    expect(
      () => new AgentPaymentAccount({ baseUrl: 'not a url', apiKey: 'key' }),
    ).toThrow(ValidationError)
  })

  it('preserves the idempotency key and payment id for an ambiguous rail failure', async () => {
    let paymentLookup = 0
    const account = new AgentPaymentAccount({
      baseUrl: 'https://payments.example.test',
      apiKey: 'agent-secret',
      fetch: async (input) => {
        const path = new URL(String(input)).pathname
        if (path === '/v1/payments/pay_reconciling') {
          paymentLookup += 1
          return jsonResponse({
            ...payment,
            id: 'pay_reconciling',
            status: 'RECONCILING',
          })
        }
        return jsonResponse(
          {
            error: 'EXTERNAL_RAIL_FAILURE',
            message: 'Payment outcome is unknown',
            details: { payment_id: 'pay_reconciling' },
          },
          502,
        )
      },
    })

    const error = await account
      .pay({ recipientId: 'rcpt_test', amount: '1.20' }, 'ambiguous-key')
      .catch((value: unknown) => value)
    expect(error).toBeInstanceOf(PaymentPendingError)
    expect(error).toMatchObject({
      idempotencyKey: 'ambiguous-key',
      paymentId: 'pay_reconciling',
    })
    await expect(account.getPayment('pay_reconciling')).resolves.toMatchObject({
      id: 'pay_reconciling',
      status: 'RECONCILING',
    })
    expect(paymentLookup).toBe(1)
  })

  it('treats invalid money POST responses and unknown 5xx responses as pending', async () => {
    let invalidJsonCalls = 0
    await expect(
      new AgentPaymentAccount({
        baseUrl: 'https://payments.example.test',
        apiKey: 'agent-secret',
        fetch: async () => {
          invalidJsonCalls += 1
          return new Response('{not-json', { status: 201 })
        },
      }).send({ recipientId: 'rcpt_test', amount: '1.20' }, 'invalid-json-key'),
    ).rejects.toMatchObject({
      code: 'PAYMENT_PENDING',
      idempotencyKey: 'invalid-json-key',
    })
    expect(invalidJsonCalls).toBe(1)
    await expect(
      new AgentPaymentAccount({
        baseUrl: 'https://payments.example.test',
        apiKey: 'agent-secret',
        fetch: async () => jsonResponse({ error: 'INTERNAL_ERROR' }, 500),
      }).send({ recipientId: 'rcpt_test', amount: '1.20' }, 'unknown-5xx-key'),
    ).rejects.toMatchObject({
      code: 'PAYMENT_PENDING',
      idempotencyKey: 'unknown-5xx-key',
    })
  })

  it('does not retry receive without an idempotency contract', async () => {
    let calls = 0
    const account = new AgentPaymentAccount({
      baseUrl: 'https://payments.example.test',
      apiKey: 'agent-secret',
      retryCount: 3,
      fetch: async () => {
        calls += 1
        throw new Error('network timeout')
      },
    })
    await expect(account.receive()).rejects.toBeInstanceOf(ExternalServiceError)
    expect(calls).toBe(1)
  })

  it('keeps a pending payment response observable instead of converting it to failure', async () => {
    const pending: Payment = {
      ...(await new AgentPaymentAccount({
        baseUrl: 'https://payments.example.test',
        apiKey: 'agent-secret',
        fetch: async () => jsonResponse({ ...payment, status: 'RECONCILING' }),
      }).getPayment('pay_test')),
      status: 'RECONCILING',
    }
    expect(pending.status).toBe('RECONCILING')
    expect(new PaymentPendingError('key').code).toBe('PAYMENT_PENDING')
  })
})
