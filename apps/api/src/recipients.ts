import { ValidationError, createRecipientId } from '@agent-payment/core'
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
}

export interface UpdateRecipientRequest {
  readonly displayName?: string
  readonly type?: string
  readonly destination?: {
    readonly id: string
    readonly type: string
    readonly walletAddress: string
  }
}

export class RecipientService {
  public constructor(private readonly repository: RecipientRepository) {}

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
      destination,
    }
    return this.repository.createRecipient(createInput)
  }

  public async updateRecipient(
    ownerAccountId: string,
    recipientId: string,
    input: UpdateRecipientRequest,
  ): Promise<RecipientRecord> {
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
    }
    if (
      input.destination?.type !== undefined &&
      input.destination.type !== SOLANA_SPL_DESTINATION
    ) {
      throw new ValidationError('Only SOLANA_SPL recipient destinations are supported')
    }
    const recipient = await this.repository.updateRecipient(updateInput)
    if (recipient === null) {
      throw new ErrorWithStatus('Recipient not found', 404)
    }
    return recipient
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
}

export function serializeRecipient(recipient: RecipientRecord) {
  return {
    id: recipient.id,
    display_name: recipient.displayName,
    type: recipient.type,
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

class ErrorWithStatus extends Error {
  public readonly statusCode: number

  public constructor(message: string, statusCode: number) {
    super(message)
    this.name = 'ErrorWithStatus'
    this.statusCode = statusCode
  }
}
