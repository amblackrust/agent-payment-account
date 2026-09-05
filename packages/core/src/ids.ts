import { randomUUID } from 'node:crypto'

import { ValidationError } from './errors.js'

export type OpaqueId<Prefix extends string> = string & {
  readonly __prefix: Prefix
}

export type AccountId = OpaqueId<'acct'>
export type RecipientId = OpaqueId<'rcpt'>
export type PaymentId = OpaqueId<'pay'>
export type PaymentAttemptId = OpaqueId<'att'>
export type ReceiveId = OpaqueId<'recv'>
export type CredentialId = OpaqueId<'cred'>

function createOpaqueId<Prefix extends string>(prefix: Prefix): OpaqueId<Prefix> {
  return `${prefix}_${randomUUID().replaceAll('-', '')}` as OpaqueId<Prefix>
}

function parseOpaqueId<Prefix extends string>(
  value: string,
  prefix: Prefix,
): OpaqueId<Prefix> {
  const expectedPrefix = `${prefix}_`
  if (
    typeof value !== 'string' ||
    !value.startsWith(expectedPrefix) ||
    value.length <= expectedPrefix.length
  ) {
    throw new ValidationError(`Invalid ${prefix} identifier`)
  }
  return value as OpaqueId<Prefix>
}

export const createAccountId = (): AccountId => createOpaqueId('acct')
export const createRecipientId = (): RecipientId => createOpaqueId('rcpt')
export const createPaymentId = (): PaymentId => createOpaqueId('pay')
export const createPaymentAttemptId = (): PaymentAttemptId => createOpaqueId('att')
export const createReceiveId = (): ReceiveId => createOpaqueId('recv')
export const createCredentialId = (): CredentialId => createOpaqueId('cred')

export const parseAccountId = (value: string): AccountId => parseOpaqueId(value, 'acct')
export const parseRecipientId = (value: string): RecipientId =>
  parseOpaqueId(value, 'rcpt')
export const parsePaymentId = (value: string): PaymentId => parseOpaqueId(value, 'pay')
export const parsePaymentAttemptId = (value: string): PaymentAttemptId =>
  parseOpaqueId(value, 'att')
export const parseReceiveId = (value: string): ReceiveId => parseOpaqueId(value, 'recv')
export const parseCredentialId = (value: string): CredentialId =>
  parseOpaqueId(value, 'cred')
