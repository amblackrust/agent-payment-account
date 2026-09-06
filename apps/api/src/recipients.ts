import { ValidationError, createRecipientId } from '@agent-payment/core'
import { address } from '@solana/kit'
import type {
  CreateRecipientInput,
  RecipientRecord,
  RecipientRepository,
  UpdateRecipientInput,
} from '@agent-payment/db'

const SOLANA_SPL_DESTINATION = 'SOLANA_SPL'

export interface CreateRecipientRequest {
  readonly displayName: string
  readonly type: string
  readonly destination: {
    readonly type: string
    readonly walletAddress: string
  }
  readonly managedAccountId?: string
}

export interface UpdateRecipientRequest {
  readonly displayName?: string
  readonly type?: string
  readonly destination?: {
    readonly id: string
    readonly type: string
    readonly walletAddress: string
  }
  readonly managedAccountId?: string | null
}

export class RecipientService {
  public constructor(
    private readonly repository: RecipientRepository & {
      readonly findAccountPublicKey: (accountId: string) => Promise<string | null>
    },
  ) {}

  public async createRecipient(
    ownerAccountId: string,
    input: CreateRecipientRequest,
  ): Promise<RecipientRecord> {
    const displayName = validateText(input.displayName, 'Recipient display name', 120)
    const type = validateText(input.type, 'Recipient type', 64)
    const walletAddress = validateText(
      input.destination.walletAddress,
      'Recipient wallet address',
      128,
    )
    if (input.destination.type !== SOLANA_SPL_DESTINATION) {
      throw new ValidationError('Only SOLANA_SPL recipient destinations are supported')
    }
    validateSolanaAddress(walletAddress)
    const ownerPublicKey = await this.resolveOwnerPublicKey(ownerAccountId)
    if (walletAddress === ownerPublicKey) {
      throw new ValidationError(
        'Recipient destination must differ from the payer account',
      )
    }

    const managedAccountId =
      input.managedAccountId === undefined
        ? undefined
        : validateText(input.managedAccountId, 'Managed account id', 64)
    if (managedAccountId === ownerAccountId) {
      throw new ValidationError(
        'Recipient destination must differ from the payer account',
      )
    }
    const managedPublicKey =
      managedAccountId === undefined
        ? undefined
        : await this.resolveManagedPublicKey(managedAccountId)
    if (managedPublicKey !== undefined && walletAddress !== managedPublicKey) {
      throw new ValidationError(
        'Managed recipient wallet does not match the managed account',
      )
    }
    const destination = {
      id: `dest_${createRecipientId().slice('rcpt_'.length)}`,
      rail: SOLANA_SPL_DESTINATION,
      type: SOLANA_SPL_DESTINATION,
      walletAddress,
    }
    const createInput: CreateRecipientInput = {
      id: createRecipientId(),
      ownerAccountId,
      displayName,
      type,
      ...(managedAccountId === undefined ? {} : { managedAccountId }),
      destination,
    }
    return this.repository.createRecipient(createInput)
  }

  public async updateRecipient(
    ownerAccountId: string,
    recipientId: string,
    input: UpdateRecipientRequest,
  ): Promise<RecipientRecord> {
    const current = await this.repository.findRecipientForOwner(
      ownerAccountId,
      recipientId,
    )
    if (current === null) {
      throw new ErrorWithStatus('Recipient not found', 404)
    }
    const ownerPublicKey = await this.resolveOwnerPublicKey(ownerAccountId)
    const managedAccountId =
      input.managedAccountId === undefined
        ? current.managedAccountId
        : input.managedAccountId
    const currentDestination = current.destinations[0]
    const walletAddress =
      input.destination?.walletAddress ?? currentDestination?.walletAddress
    if (managedAccountId === ownerAccountId || walletAddress === ownerPublicKey) {
      throw new ValidationError(
        'Recipient destination must differ from the payer account',
      )
    }
    if (managedAccountId !== null && managedAccountId !== undefined) {
      const managedPublicKey = await this.resolveManagedPublicKey(managedAccountId)
      if (walletAddress !== managedPublicKey) {
        throw new ValidationError(
          'Managed recipient wallet does not match the managed account',
        )
      }
    }
    const updateInput: UpdateRecipientInput = {
      id: recipientId,
      ownerAccountId,
      ...(input.displayName === undefined
        ? {}
        : {
            displayName: validateText(input.displayName, 'Recipient display name', 120),
          }),
      ...(input.type === undefined
        ? {}
        : { type: validateText(input.type, 'Recipient type', 64) }),
      ...(input.destination === undefined
        ? {}
        : {
            destination: {
              id: validateText(input.destination.id, 'Destination id', 64),
              rail: SOLANA_SPL_DESTINATION,
              type: SOLANA_SPL_DESTINATION,
              walletAddress: validateText(
                input.destination.walletAddress,
                'Recipient wallet address',
                128,
              ),
            },
          }),
      ...(input.managedAccountId === undefined
        ? {}
        : {
            managedAccountId:
              input.managedAccountId === null
                ? null
                : validateText(input.managedAccountId, 'Managed account id', 64),
          }),
    }
    if (
      input.destination?.type !== undefined &&
      input.destination.type !== SOLANA_SPL_DESTINATION
    ) {
      throw new ValidationError('Only SOLANA_SPL recipient destinations are supported')
    }
    if (walletAddress !== undefined) validateSolanaAddress(walletAddress)
    const recipient = await this.repository.updateRecipient(updateInput)
    if (recipient === null) {
      throw new ErrorWithStatus('Recipient not found', 404)
    }
    return recipient
  }

  private async resolveManagedPublicKey(accountId: string): Promise<string> {
    const publicKey = await this.repository.findAccountPublicKey(accountId)
    if (publicKey === null) {
      throw new ValidationError('Managed account was not found or is disabled')
    }
    return publicKey
  }

  private async resolveOwnerPublicKey(accountId: string): Promise<string> {
    const publicKey = await this.repository.findAccountPublicKey(accountId)
    if (publicKey === null) {
      throw new ValidationError('Recipient owner account was not found or is disabled')
    }
    return publicKey
  }

  public async getRecipient(
    ownerAccountId: string,
    recipientId: string,
  ): Promise<RecipientRecord> {
    const recipient = await this.repository.findRecipientForOwner(
      ownerAccountId,
      recipientId,
    )
    if (recipient === null) {
      throw new ErrorWithStatus('Recipient not found', 404)
    }
    return recipient
  }

  public listRecipients(ownerAccountId: string): Promise<readonly RecipientRecord[]> {
    return this.repository.listRecipients(ownerAccountId)
  }

  public async listRecipientsPage(
    ownerAccountId: string,
    input: { readonly limit?: number; readonly cursor?: string },
  ) {
    const limit = input.limit ?? 50
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new ValidationError('Recipient limit must be an integer from 1 to 100')
    }
    const cursor = decodeRecipientCursor(input.cursor)
    const records =
      this.repository.listRecipientsPage === undefined
        ? await this.repository.listRecipients(ownerAccountId)
        : await this.repository.listRecipientsPage(ownerAccountId, limit + 1, cursor)
    const page =
      this.repository.listRecipientsPage === undefined
        ? records
            .filter(
              (recipient) =>
                cursor === undefined ||
                recipient.createdAt < cursor.createdAt ||
                (recipient.createdAt.getTime() === cursor.createdAt.getTime() &&
                  recipient.id < cursor.id),
            )
            .sort((left, right) => {
              const time = right.createdAt.getTime() - left.createdAt.getTime()
              return time === 0 ? right.id.localeCompare(left.id) : time
            })
            .slice(0, limit + 1)
        : records
    const visible = page.slice(0, limit)
    const last = visible.at(-1)
    return {
      recipients: visible,
      next_cursor:
        page.length > limit && last !== undefined
          ? Buffer.from(
              JSON.stringify({
                createdAt: last.createdAt.toISOString(),
                id: last.id,
              }),
            ).toString('base64url')
          : null,
    }
  }
}

export function serializeRecipient(recipient: RecipientRecord) {
  return {
    id: recipient.id,
    display_name: recipient.displayName,
    type: recipient.type,
    managed_account_id: recipient.managedAccountId,
    destinations: recipient.destinations.map((destination) => ({
      id: destination.id,
      rail: destination.rail,
      type: destination.type,
      wallet_address: destination.walletAddress,
    })),
    created_at: recipient.createdAt.toISOString(),
    updated_at: recipient.updatedAt.toISOString(),
  }
}

function validateText(value: string, field: string, maxLength: number): string {
  const normalized = value.trim()
  if (normalized.length === 0 || normalized.length > maxLength) {
    throw new ValidationError(`${field} must contain 1 to ${maxLength} characters`)
  }
  return normalized
}

function validateSolanaAddress(value: string): void {
  try {
    address(value)
  } catch {
    throw new ValidationError('Recipient Solana wallet address is invalid')
  }
}

function decodeRecipientCursor(
  value: string | undefined,
): { readonly createdAt: Date; readonly id: string } | undefined {
  if (value === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as { createdAt?: unknown }).createdAt !== 'string' ||
      typeof (parsed as { id?: unknown }).id !== 'string'
    )
      throw new Error('invalid cursor')
    const createdAt = new Date((parsed as { createdAt: string }).createdAt)
    if (Number.isNaN(createdAt.getTime())) throw new Error('invalid cursor')
    return { createdAt, id: (parsed as { id: string }).id }
  } catch {
    throw new ValidationError('Recipient cursor is invalid')
  }
}

class ErrorWithStatus extends Error {
  public readonly statusCode: number

  public constructor(message: string, statusCode: number) {
    super(message)
    this.name = 'ErrorWithStatus'
    this.statusCode = statusCode
  }
}
