import { createHash } from 'node:crypto'
import {
  createDenomination,
  createReceiveId,
  createPositiveMoney,
  DependencyUnavailableError,
  exactMoneyFromAtomicUnits,
  formatMoney,
  moneyFromAtomicUnits,
  ValidationError,
  MAX_REFERENCE_BYTES,
  formatExactMoney,
  parseExactMoney,
  NotFoundError,
} from '@agent-payment/core'
import type {
  ReceiveRepository,
  ReceiveRequestRecord,
  V2AdminRepository,
  V2DatabaseRepository,
} from '@agent-payment/db'
import type { ReceiveDestination, SolanaRail } from '@agent-payment/solana-rail'

const DEFAULT_MAX_PAGE_SIZE = 100

export interface CreateReceiveRequest {
  readonly amount?: string
  readonly currency: string
  readonly reference?: string
  readonly expiresAt?: string
}

export interface CreateV2ReceiveRequest {
  readonly amount?: string
  readonly denominationId: string
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
      (!isCanonicalRfc3339Instant(input.expiresAt!) ||
        Number.isNaN(expiresAt.getTime()) ||
        expiresAt.getTime() <= this.now())
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
      createdAt: new Date(this.now()),
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

  public async listReceiveRequests(accountId: string, owner: string) {
    await this.repository.expireOpenReceiveRequests(accountId, new Date(this.now()))
    const destination = await this.rail.getReceiveDestination(owner)
    const requests = await this.repository.listReceiveRequests(accountId)
    return requests.map((request) => serializeReceiveRequest(request, destination))
  }

  public async cancelReceiveRequest(
    accountId: string,
    owner: string,
    receiveId: string,
  ) {
    if (this.repository.cancelReceiveRequest === undefined) {
      throw new ValidationError('Receive cancellation is unavailable')
    }
    const request = await this.repository.cancelReceiveRequest(
      accountId,
      receiveId,
      new Date(this.now()),
    )
    return serializeReceiveRequest(
      request,
      await this.rail.getReceiveDestination(owner),
    )
  }
}

export class V2ReceiveService {
  private readonly maxPageSize: number

  public constructor(
    private readonly repository: ReceiveRepository,
    private readonly v2Repository: V2DatabaseRepository,
    private readonly adminRepository: V2AdminRepository,
    private readonly rail: SolanaRail,
    private readonly now: () => Date = () => new Date(),
    options: { readonly maxPageSize?: number } = {},
  ) {
    this.maxPageSize = options.maxPageSize ?? DEFAULT_MAX_PAGE_SIZE
    if (!Number.isInteger(this.maxPageSize) || this.maxPageSize < 1) {
      throw new ValidationError('Maximum page size must be a positive integer')
    }
  }

  public async createReceiveRequest(
    accountId: string,
    owner: string,
    input: CreateV2ReceiveRequest,
    idempotencyKey?: string,
  ) {
    const denominationRecord = await this.v2Repository.findDenomination(
      input.denominationId,
    )
    if (denominationRecord === null)
      throw new NotFoundError('Denomination was not found')
    const denomination = createDenomination({
      id: denominationRecord.id,
      symbol: denominationRecord.symbol,
      maxScale: denominationRecord.maxScale,
      status: denominationRecord.status as 'ACTIVE' | 'RETIRED',
      version: denominationRecord.version,
    })
    const amount =
      input.amount === undefined
        ? undefined
        : parseExactMoney(input.amount, denomination)
    const reference = input.reference?.trim() || createReceiveId()
    if (Buffer.byteLength(reference, 'utf8') > MAX_REFERENCE_BYTES) {
      throw new ValidationError(
        `Receive reference must contain at most ${MAX_REFERENCE_BYTES} UTF-8 bytes`,
      )
    }
    const expiresAt =
      input.expiresAt === undefined ? undefined : new Date(input.expiresAt)
    if (
      expiresAt !== undefined &&
      (Number.isNaN(expiresAt.getTime()) || expiresAt <= this.now())
    ) {
      throw new ValidationError('Receive expiration must be a valid date')
    }
    const requestInput = {
      id: createReceiveId(),
      accountId,
      ...(amount === undefined ? {} : { amountAtomic: amount.atomicUnits }),
      denominationId: denomination.id,
      ...(amount === undefined ? {} : { amountScale: amount.scale }),
      currency: denomination.symbol,
      reference,
      createdAt: this.now(),
      ...(expiresAt === undefined ? {} : { expiresAt }),
    }
    const request =
      idempotencyKey === undefined
        ? await this.repository.createReceiveRequest(requestInput)
        : await this.adminRepository.createReceiveRequestIdempotent({
            ...requestInput,
            idempotencyKey,
            requestHash: hashJson({
              denomination_id: input.denominationId,
              amount: input.amount ?? null,
              reference,
              expires_at: input.expiresAt ?? null,
            }),
          })
    return serializeV2ReceiveRequest(
      request,
      await this.rail.getReceiveDestination(owner),
      denomination,
    )
  }

  public async listReceiveRequests(accountId: string, owner: string) {
    const destination = await this.rail.getReceiveDestination(owner)
    const requests = await this.repository.listReceiveRequests(accountId)
    return Promise.all(
      requests.map(async (request) =>
        serializeV2ReceiveRequest(
          request,
          destination,
          request.denominationId === null || request.denominationId === undefined
            ? null
            : await this.loadDenomination(request.denominationId),
        ),
      ),
    )
  }

  public async listReceiveRequestsPage(
    accountId: string,
    owner: string,
    input: { readonly limit?: number; readonly cursor?: string },
  ) {
    const limit = input.limit ?? 50
    if (!Number.isInteger(limit) || limit < 1 || limit > this.maxPageSize) {
      throw new ValidationError(
        `Receive request limit must be an integer from 1 to ${this.maxPageSize}`,
      )
    }
    const destination = await this.rail.getReceiveDestination(owner)
    const cursor = decodeReceiveCursor(input.cursor)
    const records =
      this.repository.listReceiveRequestsPage === undefined
        ? await this.repository.listReceiveRequests(accountId)
        : await this.repository.listReceiveRequestsPage(accountId, limit + 1, cursor)
    const ordered =
      this.repository.listReceiveRequestsPage === undefined
        ? records
            .filter(
              (request) =>
                cursor === undefined ||
                request.createdAt < cursor.createdAt ||
                (request.createdAt.getTime() === cursor.createdAt.getTime() &&
                  request.id < cursor.id),
            )
            .sort(compareReceiveRequests)
            .slice(0, limit + 1)
        : records
    const visible = ordered.slice(0, limit)
    const last = visible.at(-1)
    return {
      receive_requests: await Promise.all(
        visible.map(async (request) =>
          serializeV2ReceiveRequest(
            request,
            destination,
            request.denominationId === null || request.denominationId === undefined
              ? null
              : await this.loadDenomination(request.denominationId),
          ),
        ),
      ),
      next_cursor:
        ordered.length > limit && last !== undefined ? encodeReceiveCursor(last) : null,
    }
  }

  public async getReceiveRequest(accountId: string, owner: string, receiveId: string) {
    const request = await this.repository.findReceiveRequestForOwner(
      accountId,
      receiveId,
    )
    if (request === null) throw new NotFoundError('Receive request was not found')
    const denomination =
      request.denominationId === null || request.denominationId === undefined
        ? null
        : await this.loadDenomination(request.denominationId)
    return serializeV2ReceiveRequest(
      request,
      await this.rail.getReceiveDestination(owner),
      denomination,
    )
  }

  public async cancelReceiveRequest(
    accountId: string,
    owner: string,
    receiveId: string,
  ) {
    if (this.repository.cancelReceiveRequest === undefined) {
      throw new DependencyUnavailableError('Receive cancellation is unavailable')
    }
    const request = await this.repository.cancelReceiveRequest(
      accountId,
      receiveId,
      this.now(),
    )
    const denomination =
      request.denominationId === null || request.denominationId === undefined
        ? null
        : await this.loadDenomination(request.denominationId)
    return serializeV2ReceiveRequest(
      request,
      await this.rail.getReceiveDestination(owner),
      denomination,
    )
  }

  private async loadDenomination(id: string) {
    const record = await this.v2Repository.findDenomination(id)
    if (record === null) throw new NotFoundError('Denomination was not found')
    return createDenomination({
      id: record.id,
      symbol: record.symbol,
      maxScale: record.maxScale,
      status: record.status as 'ACTIVE' | 'RETIRED',
      version: record.version,
    })
  }
}

function isCanonicalRfc3339Instant(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(
    value,
  )
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')
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

function serializeV2ReceiveRequest(
  request: ReceiveRequestRecord,
  destination: ReceiveDestination,
  denomination: ReturnType<typeof createDenomination> | null,
) {
  return {
    id: request.id,
    account_id: request.accountId,
    amount:
      request.amountAtomic === null
        ? null
        : denomination === null
          ? request.amountAtomic.toString()
          : formatExactMoney(
              exactMoneyFromAtomicUnits(request.amountAtomic, denomination),
            ),
    denomination_id: request.denominationId ?? null,
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

function compareReceiveRequests(
  left: ReceiveRequestRecord,
  right: ReceiveRequestRecord,
): number {
  const time = right.createdAt.getTime() - left.createdAt.getTime()
  return time === 0 ? right.id.localeCompare(left.id) : time
}

function encodeReceiveCursor(request: ReceiveRequestRecord): string {
  return Buffer.from(
    JSON.stringify({ createdAt: request.createdAt.toISOString(), id: request.id }),
  ).toString('base64url')
}

function decodeReceiveCursor(
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
    ) {
      throw new Error('invalid cursor')
    }
    const createdAt = new Date((parsed as { createdAt: string }).createdAt)
    const id = (parsed as { id: string }).id
    if (Number.isNaN(createdAt.getTime()) || id.length === 0) {
      throw new Error('invalid cursor')
    }
    return { createdAt, id }
  } catch {
    throw new ValidationError('Receive request cursor is invalid')
  }
}
