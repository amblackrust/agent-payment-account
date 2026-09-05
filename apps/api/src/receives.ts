import {
  createPositiveMoney,
  createReceiveId,
  formatMoney,
  moneyFromAtomicUnits,
  ValidationError,
} from '@agent-payment/core'
import { MAX_REFERENCE_BYTES } from '@agent-payment/contracts'
import type { ReceiveRepository, ReceiveRequestRecord } from '@agent-payment/db'
import type { ReceiveDestination, SolanaRail } from '@agent-payment/solana-rail'

export interface CreateReceiveRequest {
  readonly amount?: string
  readonly currency: string
  readonly reference?: string
  readonly expiresAt?: string
}

export class ReceiveService {
  public constructor(
    private readonly repository: ReceiveRepository,
    private readonly rail: SolanaRail,
    private readonly now: () => number = Date.now,
  ) {}

  public async createReceiveRequest(
    accountId: string,
    owner: string,
    input: CreateReceiveRequest,
  ) {
    const amount =
      input.amount === undefined
        ? undefined
        : createPositiveMoney(input.amount, input.currency)
    const id = createReceiveId()
    const reference = input.reference === undefined ? id : input.reference.trim()
    if (reference.length === 0) {
      throw new ValidationError('Receive reference must not be blank')
    }
    if (Buffer.byteLength(reference, 'utf8') > MAX_REFERENCE_BYTES) {
      throw new ValidationError(
        `Receive reference must contain at most ${MAX_REFERENCE_BYTES} UTF-8 bytes`,
      )
    }
    const expiresAt =
      input.expiresAt === undefined ? undefined : new Date(input.expiresAt)
    if (
      expiresAt !== undefined &&
      (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= this.now())
    ) {
      throw new ValidationError('Receive expiration must be a valid date')
    }
    const destination = await this.rail.getReceiveDestination(owner)
    const request = await this.repository.createReceiveRequest({
      id,
      accountId,
      ...(amount === undefined ? {} : { amountAtomic: amount.atomicUnits }),
      currency: 'USD',
      reference,
      ...(expiresAt === undefined ? {} : { expiresAt }),
    })
    return serializeReceiveRequest(request, destination)
  }

  public async getReceiveRequest(accountId: string, owner: string, receiveId: string) {
    await this.repository.expireOpenReceiveRequests(accountId, new Date(this.now()))
    const request = await this.repository.findReceiveRequestForOwner(
      accountId,
      receiveId,
    )
    if (request === null) {
      const error = new Error('Receive request not found')
      Object.assign(error, { statusCode: 404 })
      throw error
    }
    return serializeReceiveRequest(
      request,
      await this.rail.getReceiveDestination(owner),
    )
  }
}

function serializeReceiveRequest(
  request: ReceiveRequestRecord,
  destination: ReceiveDestination,
) {
  return {
    id: request.id,
    account_id: request.accountId,
    amount:
      request.amountAtomic === null
        ? null
        : formatMoney(moneyFromAtomicUnits(request.amountAtomic)),
    currency: request.currency,
    reference: request.reference,
    status: request.status,
    created_at: request.createdAt.toISOString(),
    expires_at: request.expiresAt?.toISOString() ?? null,
    paid_at: request.paidAt?.toISOString() ?? null,
    destination: {
      type: 'external_transfer_target' as const,
      reference: destination.tokenAccount,
    },
    settlement: {
      owner: destination.owner,
      token_account: destination.tokenAccount,
      mint: destination.settlementMint,
    },
  }
}
