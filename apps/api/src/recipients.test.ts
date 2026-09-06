import { describe, expect, it } from 'vitest'
import { RecipientService } from './recipients.js'

const accountB = 'acct_b'
const walletB = 'So11111111111111111111111111111111111111112'
const walletC = 'SysvarRent111111111111111111111111111111111'
const walletA = 'Vote111111111111111111111111111111111111111'

function createService() {
  let current = {
    id: 'rcpt_1',
    ownerAccountId: 'acct_a',
    displayName: 'B',
    type: 'AGENT',
    managedAccountId: accountB,
    ownerStatus: 'ACTIVE' as const,
    destinations: [
      { id: 'dest_1', rail: 'SOLANA_SPL', type: 'SOLANA_SPL', walletAddress: walletB },
    ],
    createdAt: new Date(),
    updatedAt: new Date(),
  }
  const repository = {
    findAccountPublicKey: async (id: string) =>
      id === accountB ? walletB : id === 'acct_a' ? walletA : null,
    createRecipient: async (_input: never) => current,
    findRecipientForOwner: async () => current,
    updateRecipient: async (_input: never) => current,
    listRecipients: async () => [current],
  }
  return { service: new RecipientService(repository), repository }
}

describe('managed recipient verification', () => {
  it('accepts a managed account only with its canonical wallet', async () => {
    const { service } = createService()
    const recipient = await service.createRecipient('acct_a', {
      displayName: 'B',
      type: 'AGENT',
      managedAccountId: accountB,
      destination: { type: 'SOLANA_SPL', walletAddress: walletB },
    })
    expect(recipient.managedAccountId).toBe(accountB)
  })

  it('rejects unknown and mismatched managed destinations', async () => {
    const { service } = createService()
    await expect(
      service.createRecipient('acct_a', {
        displayName: 'unknown',
        type: 'AGENT',
        managedAccountId: 'acct_missing',
        destination: { type: 'SOLANA_SPL', walletAddress: walletC },
      }),
    ).rejects.toThrow('Managed account was not found')
    await expect(
      service.createRecipient('acct_a', {
        displayName: 'wrong wallet',
        type: 'AGENT',
        managedAccountId: accountB,
        destination: { type: 'SOLANA_SPL', walletAddress: walletC },
      }),
    ).rejects.toThrow('does not match')
  })

  it('rejects updates that change only one side of the managed linkage', async () => {
    const { service } = createService()
    await expect(
      service.updateRecipient('acct_a', 'rcpt_1', {
        destination: { id: 'dest_1', type: 'SOLANA_SPL', walletAddress: walletC },
      }),
    ).rejects.toThrow('does not match')
    await expect(
      service.updateRecipient('acct_a', 'rcpt_1', {
        managedAccountId: 'acct_missing',
      }),
    ).rejects.toThrow('Managed account was not found')
  })

  it('rejects direct and managed self recipients', async () => {
    const { service } = createService()
    await expect(
      service.createRecipient('acct_a', {
        displayName: 'self',
        type: 'AGENT',
        destination: { type: 'SOLANA_SPL', walletAddress: walletA },
      }),
    ).rejects.toThrow('must differ from the payer account')
    await expect(
      service.createRecipient('acct_a', {
        displayName: 'managed self',
        type: 'AGENT',
        managedAccountId: 'acct_a',
        destination: { type: 'SOLANA_SPL', walletAddress: walletA },
      }),
    ).rejects.toThrow('must differ from the payer account')
    await expect(
      service.updateRecipient('acct_a', 'rcpt_1', {
        destination: { id: 'dest_1', type: 'SOLANA_SPL', walletAddress: walletA },
        managedAccountId: null,
      }),
    ).rejects.toThrow('must differ from the payer account')
  })
})
