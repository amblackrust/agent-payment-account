import { describe, expect, it } from 'vitest'
import { AuthenticationError } from '@agent-payment/core'
import { getAdminOperatorId, hashApiKey } from './auth.js'

describe('admin operator identity', () => {
  it('derives a stable non-secret identity from the authenticated admin credential', () => {
    const adminApiKey = 'admin-test-key'
    const request = {
      headers: { 'x-admin-api-key': adminApiKey },
    }

    expect(getAdminOperatorId(request as never, adminApiKey)).toBe(
      `platform-operator:${hashApiKey(adminApiKey).slice(0, 24)}`,
    )
    expect(getAdminOperatorId(request as never, adminApiKey)).not.toContain(adminApiKey)
  })

  it('does not derive an identity for an invalid admin credential', () => {
    const request = {
      headers: { 'x-admin-api-key': 'wrong-key' },
    }

    expect(() => getAdminOperatorId(request as never, 'admin-test-key')).toThrow(
      AuthenticationError,
    )
  })
})
