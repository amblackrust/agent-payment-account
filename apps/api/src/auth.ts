import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { FastifyRequest } from 'fastify'
import { AuthenticationError } from '@agent-payment/core'
import type { AccountRepository, AuthenticatedAccount } from '@agent-payment/db'

export const ADMIN_API_KEY_HEADER = 'x-admin-api-key'
const AGENT_API_KEY_PREFIX = 'apa_'

export interface GeneratedApiCredential {
  readonly rawKey: string
  readonly keyHash: string
  readonly keyPrefix: string
}

export function generateApiCredential(): GeneratedApiCredential {
  const rawKey = `${AGENT_API_KEY_PREFIX}${randomBytes(32).toString('base64url')}`
  return {
    rawKey,
    keyHash: hashApiKey(rawKey),
    keyPrefix: rawKey.slice(0, 12),
  }
}

export function hashApiKey(rawKey: string): string {
  return createHash('sha256').update(rawKey, 'utf8').digest('hex')
}

export function isApiKeyMatch(provided: string | undefined, expected: string): boolean {
  if (provided === undefined) {
    return false
  }
  const providedBytes = Buffer.from(provided, 'utf8')
  const expectedBytes = Buffer.from(expected, 'utf8')
  return (
    providedBytes.length === expectedBytes.length &&
    timingSafeEqual(providedBytes, expectedBytes)
  )
}

function getAgentApiKey(request: FastifyRequest): string {
  const authorization = request.headers.authorization
  if (authorization === undefined || !authorization.startsWith('Bearer ')) {
    throw new AuthenticationError()
  }
  const apiKey = authorization.slice('Bearer '.length).trim()
  if (apiKey.length === 0) {
    throw new AuthenticationError()
  }
  return apiKey
}

export async function authenticateAgent(
  request: FastifyRequest,
  repository: AccountRepository,
): Promise<AuthenticatedAccount> {
  const account = await repository.findAccountByCredentialHash(
    hashApiKey(getAgentApiKey(request)),
  )
  if (account === null || account.credential.revokedAt !== null) {
    throw new AuthenticationError()
  }
  if (account.account.status !== 'ACTIVE') {
    throw new AuthenticationError('Account is disabled')
  }

  await repository.markCredentialUsed(account.credential.id)
  request.agentAccount = account
  return account
}

export function assertAdminApiKey(request: FastifyRequest, expected: string): void {
  const provided = request.headers[ADMIN_API_KEY_HEADER]
  const value = Array.isArray(provided) ? provided[0] : provided
  if (!isApiKeyMatch(value, expected)) {
    throw new AuthenticationError()
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    agentAccount: AuthenticatedAccount | null
  }
}
