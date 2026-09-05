import { address, generateKeyPairSigner } from '@solana/kit'
import {
  findAssociatedTokenPda,
  getMintEncoder,
  getTokenEncoder,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token'
import { describe, expect, it } from 'vitest'

import { createPositiveMoney, ExternalRailError } from '@agent-payment/core'
import {
  createSolanaPaymentPreparationRail,
  createSolanaPaymentRailWithRpc,
  SOLANA_SPL_RAIL,
} from './payment.js'

const mint = address('So11111111111111111111111111111111111111112')
const blockhash = '11111111111111111111111111111111'
const localnetGenesisHash = 'localnet-genesis'

type RpcAccount = {
  readonly owner: string
  readonly data: readonly [string, 'base64']
  readonly executable: boolean
  readonly lamports: bigint
  readonly space: bigint
}

function encodeAccount(owner: string, data: Uint8Array): RpcAccount {
  return {
    owner,
    data: [Buffer.from(data).toString('base64'), 'base64'],
    executable: false,
    lamports: 1_000_000n,
    space: BigInt(data.length),
  }
}

function createMockRpc(
  accounts: Map<string, RpcAccount>,
  feePayerBalance = 1_000_000_000n,
  onSend?: (transaction: string) => string | PromiseLike<string>,
  onSignatureStatus?: () => unknown,
  rpcOptions: { readonly blockHeight?: bigint; readonly latestBlockhash?: string } = {},
) {
  let latestBlockhashCalls = 0
  return {
    getGenesisHash: () => ({ send: async () => localnetGenesisHash }),
    getAccountInfo: (accountAddress: string) => ({
      send: async () => ({ value: accounts.get(accountAddress) ?? null }),
    }),
    getBalance: () => ({ send: async () => ({ value: feePayerBalance }) }),
    getFeeForMessage: () => ({ send: async () => ({ value: 5_000n }) }),
    getMinimumBalanceForRentExemption: () => ({ send: async () => 2_039_280n }),
    getLatestBlockhash: () => ({
      send: async () => ({
        value: {
          blockhash:
            latestBlockhashCalls++ === 0
              ? blockhash
              : (rpcOptions.latestBlockhash ?? blockhash),
          lastValidBlockHeight: 100n,
        },
      }),
    }),
    getSignatureStatuses: () => ({
      send: async () => onSignatureStatus?.() ?? { value: [null] },
    }),
    getBlockHeight: () => ({ send: async () => rpcOptions.blockHeight ?? 1n }),
    sendTransaction: (transaction: string) => ({
      send: async () => onSend?.(transaction) ?? '',
    }),
  } as never
}

function mintData(decimals: number): Uint8Array {
  return new Uint8Array(
    getMintEncoder().encode({
      mintAuthority: null,
      supply: 1_000_000_000n,
      decimals,
      isInitialized: true,
      freezeAuthority: null,
    }),
  )
}

function tokenData(owner: ReturnType<typeof address>, amount: bigint): Uint8Array {
  return new Uint8Array(
    getTokenEncoder().encode({
      mint,
      owner,
      amount,
      delegate: null,
      state: 1,
      isNative: null,
      delegatedAmount: 0n,
      closeAuthority: null,
    }),
  )
}

async function exportSecret(signer: Awaited<ReturnType<typeof generateKeyPairSigner>>) {
  const privateKey = await crypto.subtle.exportKey('pkcs8', signer.keyPair.privateKey)
  const publicKey = await crypto.subtle.exportKey('raw', signer.keyPair.publicKey)
  const secret = new Uint8Array(64)
  secret.set(new Uint8Array(privateKey).slice(16))
  secret.set(new Uint8Array(publicKey), 32)
  return secret
}

async function createPreparedRail(
  options: {
    readonly feePayerBalance?: bigint
    readonly includeRecipientAta?: boolean
    readonly sameSigner?: boolean
    readonly statusSequence?: readonly unknown[]
    readonly blockHeight?: bigint
    readonly latestBlockhash?: string
  } = {},
) {
  const payer = await generateKeyPairSigner(true)
  const feePayer = options.sameSigner ? payer : await generateKeyPairSigner(true)
  const recipient = await generateKeyPairSigner(true)
  const [payerAta] = await findAssociatedTokenPda({
    owner: payer.address,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
    mint,
  })
  const [recipientAta] = await findAssociatedTokenPda({
    owner: recipient.address,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
    mint,
  })
  const accounts = new Map<string, RpcAccount>([
    [mint, encodeAccount(TOKEN_PROGRAM_ADDRESS, mintData(6))],
    [
      payerAta,
      encodeAccount(TOKEN_PROGRAM_ADDRESS, tokenData(payer.address, 12_500_000n)),
    ],
    ...(options.includeRecipientAta
      ? [
          [
            recipientAta,
            encodeAccount(TOKEN_PROGRAM_ADDRESS, tokenData(recipient.address, 0n)),
          ] as const,
        ]
      : []),
  ])
  let sentTransaction = ''
  let signatureValue = ''
  let statusCalls = 0
  const rail = createSolanaPaymentRailWithRpc({
    rpc: createMockRpc(
      accounts,
      options.feePayerBalance ?? 1_000_000_000n,
      (transaction) => {
        sentTransaction = transaction
        return signatureValue
      },
      () => {
        statusCalls += 1
        const sequenceValue = options.statusSequence?.[statusCalls - 1]
        if (sequenceValue !== undefined) {
          return sequenceValue
        }
        return statusCalls === 1
          ? { value: [null] }
          : { value: [{ err: null, confirmationStatus: 'confirmed', slot: 42n }] }
      },
      options,
    ),
    expectedCluster: 'localnet',
    allowMainnet: false,
    settlementMint: mint,
    feePayerSecret: JSON.stringify(Array.from(await exportSecret(feePayer))),
  })
  const payerSecret = await exportSecret(payer)
  const prepared = await rail.prepare(
    {
      operation: 'SEND',
      currency: 'USD',
      amount: createPositiveMoney('12.50'),
      payerAccountId: 'acct_payer',
      recipientId: 'rcpt_recipient',
      destination: {
        rail: SOLANA_SPL_RAIL,
        type: SOLANA_SPL_RAIL,
        reference: recipient.address,
      },
    },
    {
      paymentId: 'pay_transfer',
      payerAccountId: 'acct_payer',
      payerPublicKey: payer.address,
      getPayerSecretKey: async () => payerSecret,
    },
  )
  signatureValue = prepared.durableExecution?.expectedExternalId ?? ''
  return {
    rail,
    prepared,
    payerSecret,
    payerAddress: payer.address,
    getSent: () => sentTransaction,
  }
}

describe('Solana payment rail', () => {
  it('rejects malformed fee-payer credentials during rail construction', () => {
    expect(() =>
      createSolanaPaymentRailWithRpc({
        rpc: createMockRpc(new Map()),
        expectedCluster: 'localnet',
        allowMainnet: false,
        settlementMint: mint,
        feePayerSecret: 'not-a-secret',
      }),
    ).toThrow('fee payer secret')
  })
  it('keeps the Task 03 preparation-only route free of execution', async () => {
    const rail = createSolanaPaymentPreparationRail()
    expect(rail.execute).toBeUndefined()
  })

  it('builds checked SPL transfer bytes with separate token authority and fee payer', async () => {
    const fixture = await createPreparedRail()
    const durable = fixture.prepared.durableExecution

    expect(durable).toBeDefined()
    expect(durable?.serializedPayload).toMatch(/^[A-Za-z0-9+/=]+$/)
    expect(durable?.expectedExternalId).toBeTruthy()
    expect(fixture.payerSecret.every((byte) => byte === 0)).toBe(true)
  })

  it('sends the durable signed bytes and confirms before returning success', async () => {
    const fixture = await createPreparedRail()
    const execution = await fixture.rail.execute?.(fixture.prepared)

    expect(execution?.status).toBe('CONFIRMED')
    expect(execution?.confirmationMetadata).toBe('{"slot":"42"}')
    expect(fixture.getSent()).toBe(fixture.prepared.durableExecution?.serializedPayload)
  })

  it('does not resend an already confirmed signature', async () => {
    const fixture = await createPreparedRail()
    await fixture.rail.execute?.(fixture.prepared)
    const sentBytes = fixture.getSent()

    const secondExecution = await fixture.rail.execute?.(fixture.prepared)

    expect(secondExecution?.status).toBe('CONFIRMED')
    expect(fixture.getSent()).toBe(sentBytes)
  })

  it('resends the exact durable bytes while the original blockhash is alive', async () => {
    const fixture = await createPreparedRail({
      statusSequence: [
        { value: [null] },
        { value: [null] },
        { value: [null] },
        { value: [{ err: null, confirmationStatus: 'confirmed', slot: 7n }] },
        { value: [null] },
        { value: [null] },
        { value: [null] },
        { value: [{ err: null, confirmationStatus: 'confirmed', slot: 8n }] },
      ],
    })

    await fixture.rail.recover?.(fixture.prepared)
    const firstBytes = fixture.getSent()
    await fixture.rail.recover?.(fixture.prepared)

    expect(firstBytes).toBe(fixture.prepared.durableExecution?.serializedPayload)
    expect(fixture.getSent()).toBe(firstBytes)
  })

  it('keeps an expired unknown transaction reconciling without replacement', async () => {
    const fixture = await createPreparedRail({
      statusSequence: [{ value: [null] }, { value: [null] }],
      blockHeight: 101n,
    })
    const expectedExternalId = fixture.prepared.durableExecution?.expectedExternalId
    const recovery = await fixture.rail.recover?.(fixture.prepared)

    expect(recovery?.status).toBe('RECONCILING')
    expect(recovery?.railTransactionId).toBe(expectedExternalId)
    expect(fixture.getSent()).toBe('')
  })

  it('classifies deterministic preflight rejection as failed execution', async () => {
    const fixture = await createPreparedRail()
    const rejectedRail = createSolanaPaymentRailWithRpc({
      rpc: createMockRpc(
        new Map([[mint, encodeAccount(TOKEN_PROGRAM_ADDRESS, mintData(6))]]),
        1_000_000_000n,
        () => {
          throw new ExternalRailError(
            'Solana transaction was rejected during preflight',
            undefined,
            'DETERMINISTIC',
          )
        },
      ),
      expectedCluster: 'localnet',
      allowMainnet: false,
      settlementMint: mint,
      feePayerSecret: JSON.stringify(Array.from(new Uint8Array(64).fill(1))),
    })

    await expect(rejectedRail.execute?.(fixture.prepared)).rejects.toMatchObject({
      code: 'EXTERNAL_RAIL_FAILURE',
      kind: 'DETERMINISTIC',
    })
    expect(fixture.getSent()).toBe('')
  })

  it('reports rejected signatures as deterministic failed execution', async () => {
    const fixture = await createPreparedRail()
    const rejectedRail = createSolanaPaymentRailWithRpc({
      rpc: createMockRpc(
        new Map([[mint, encodeAccount(TOKEN_PROGRAM_ADDRESS, mintData(6))]]),
        1_000_000_000n,
        () => fixture.prepared.durableExecution?.expectedExternalId ?? '',
        () => ({
          value: [
            { err: { InstructionError: [0, 'Custom'] }, confirmationStatus: null },
          ],
        }),
      ),
      expectedCluster: 'localnet',
      allowMainnet: false,
      settlementMint: mint,
      feePayerSecret: JSON.stringify(Array.from(new Uint8Array(64).fill(1))),
    })

    const result = await rejectedRail.execute?.(fixture.prepared)

    expect(result).toMatchObject({
      status: 'FAILED',
      railTransactionId: fixture.prepared.durableExecution?.expectedExternalId,
      failureCode: 'EXTERNAL_RAIL_FAILURE',
    })
    expect(fixture.getSent()).toBe('')
  })

  it('requires enough fee-payer SOL for network fee and ATA rent', async () => {
    await expect(createPreparedRail({ feePayerBalance: 0n })).rejects.toMatchObject({
      kind: 'DETERMINISTIC',
    })
    await expect(createPreparedRail({ feePayerBalance: 5_000n })).rejects.toMatchObject(
      { kind: 'DETERMINISTIC' },
    )

    await expect(
      createPreparedRail({ feePayerBalance: 5_000n, includeRecipientAta: true }),
    ).resolves.toBeDefined()
  })

  it('rejects using the payer signer as the platform fee payer', async () => {
    await expect(createPreparedRail({ sameSigner: true })).rejects.toThrow(
      'different from the payer account signer',
    )
  })

  it('classifies confirmation timeout after send as ambiguous', async () => {
    const fixture = await createPreparedRail()
    let statusCalls = 0
    const ambiguousRail = createSolanaPaymentRailWithRpc({
      rpc: createMockRpc(
        new Map([[mint, encodeAccount(TOKEN_PROGRAM_ADDRESS, mintData(6))]]),
        1_000_000_000n,
        () => fixture.prepared.durableExecution?.expectedExternalId ?? '',
        () => {
          statusCalls += 1
          return statusCalls === 1 ? { value: [null] } : new Promise(() => undefined)
        },
      ),
      expectedCluster: 'localnet',
      allowMainnet: false,
      settlementMint: mint,
      feePayerSecret: JSON.stringify(Array.from(new Uint8Array(64).fill(1))),
      rpcTimeoutMs: 5,
      confirmationTimeoutMs: 25,
      pollIntervalMs: 0,
    })

    await expect(ambiguousRail.execute?.(fixture.prepared)).rejects.toMatchObject({
      code: 'EXTERNAL_RAIL_FAILURE',
      kind: 'AMBIGUOUS',
    })
  })

  it('classifies a submission transport timeout as ambiguous', async () => {
    const fixture = await createPreparedRail()
    const ambiguousRail = createSolanaPaymentRailWithRpc({
      rpc: createMockRpc(
        new Map([[mint, encodeAccount(TOKEN_PROGRAM_ADDRESS, mintData(6))]]),
        1_000_000_000n,
        () => new Promise<never>(() => undefined),
      ),
      expectedCluster: 'localnet',
      allowMainnet: false,
      settlementMint: mint,
      feePayerSecret: JSON.stringify(Array.from(new Uint8Array(64).fill(1))),
      rpcTimeoutMs: 5,
    })

    await expect(ambiguousRail.execute?.(fixture.prepared)).rejects.toMatchObject({
      code: 'EXTERNAL_RAIL_FAILURE',
      kind: 'AMBIGUOUS',
    })
  })
})
