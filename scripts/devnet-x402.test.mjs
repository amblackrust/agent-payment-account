import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  DEVNET_X402_DEVNET_GENESIS_HASH,
  amountToTopUp,
  formatAtomicAmount,
  parseSolAmount,
  parseTestUsdcAmount,
  resolveDevnetX402Config,
  resolveDevnetX402Paths,
  statusDevnetX402,
  setupDevnetX402,
} from './devnet-x402.mjs'

const temporaryDirectories = []

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop()
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true })
  }
})

function createTemporaryHome() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'mux-devnet-x402-'))
  temporaryDirectories.push(directory)
  return path.join(directory, 'devnet-x402')
}

function createFakeDevnet({
  failAirdrop = false,
  uncertainAirdrop = false,
  uncertainMintCreation = false,
  uncertainMint = false,
} = {}) {
  const addresses = {
    'platform-fee-payer.json': '11111111111111111111111111111111',
    'fake-service-destination.json': 'SysvarRent111111111111111111111111111111111',
    'test-usdc-mint.json': 'Vote111111111111111111111111111111111111111',
  }
  const balances = new Map()
  const tokenBalances = new Map()
  const tokenAccounts = new Map()
  let mintReady = false
  const commands = []

  const runCommand = (command, args) => {
    commands.push({ command, args: [...args] })
    if (command === 'solana-keygen' && args[0] === 'new') {
      const filePath = args[args.indexOf('--outfile') + 1]
      writeFileSync(filePath, JSON.stringify(Array.from({ length: 64 }, () => 1)))
      return ''
    }
    if (command === 'solana-keygen' && args[0] === 'pubkey') {
      return addresses[path.basename(args[1])]
    }
    if (command === 'solana' && args[0] === 'airdrop') {
      if (failAirdrop) {
        throw new Error('airdrop request failed: faucet rate limit')
      }
      const amount = parseSolAmount(args[1], 'fake airdrop')
      const address = args[2]
      balances.set(address, (balances.get(address) ?? 0n) + amount)
      if (uncertainAirdrop) {
        uncertainAirdrop = false
        throw new Error('unable to confirm transaction')
      }
      return ''
    }
    if (command === 'spl-token' && args[0] === 'address') {
      const owner = args[args.indexOf('--owner') + 1]
      return JSON.stringify({
        associatedTokenAddress:
          `Ata${owner.slice(3)}1111111111111111111111111111111`.slice(0, 44),
        walletAddress: owner,
      })
    }
    if (command === 'spl-token' && args[0] === 'create-token') {
      mintReady = true
      if (uncertainMintCreation) {
        uncertainMintCreation = false
        throw new Error('unable to confirm transaction')
      }
      return ''
    }
    if (command === 'spl-token' && args[0] === 'create-account') {
      const mint = args[1]
      const owner = args[args.indexOf('--owner') + 1]
      const ata = `Ata${owner.slice(3)}1111111111111111111111111111111`.slice(0, 44)
      tokenAccounts.set(ata, { mint, owner })
      tokenBalances.set(ata, 0n)
      return ''
    }
    if (command === 'spl-token' && args[0] === 'mint') {
      const amount = parseTestUsdcAmount(args[2], 'fake mint')
      const ata = args[3]
      tokenBalances.set(ata, (tokenBalances.get(ata) ?? 0n) + amount)
      if (uncertainMint) {
        uncertainMint = false
        throw new Error('transaction confirmation timed out')
      }
      return ''
    }
    throw new Error(`Unexpected fake command: ${command} ${args.join(' ')}`)
  }

  const rpcClient = {
    async request(method, params) {
      if (method === 'getGenesisHash') return DEVNET_X402_DEVNET_GENESIS_HASH
      if (method === 'getBalance') {
        return { value: Number(balances.get(params[0]) ?? 0n) }
      }
      if (method === 'getAccountInfo') {
        const account = params[0]
        if (account === addresses['test-usdc-mint.json'] && mintReady) {
          const data = Buffer.alloc(82)
          data[44] = 6
          data[45] = 1
          return {
            value: {
              owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
              data: [data.toString('base64'), 'base64'],
            },
          }
        }
        const tokenAccount = tokenAccounts.get(account)
        if (tokenAccount !== undefined) {
          return {
            value: {
              owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
              data: {
                parsed: {
                  type: 'account',
                  info: tokenAccount,
                },
              },
            },
          }
        }
        return { value: null }
      }
      if (method === 'getTokenAccountBalance') {
        return { value: { amount: (tokenBalances.get(params[0]) ?? 0n).toString() } }
      }
      throw new Error(`Unexpected fake RPC method: ${method}`)
    },
  }

  return { addresses, balances, commands, runCommand, rpcClient, tokenAccounts }
}

describe('devnet x402 setup helpers', () => {
  it('resolves stable ignored paths and rejects non-devnet URLs', () => {
    const home = createTemporaryHome()
    const paths = resolveDevnetX402Paths(home)
    expect(paths.home).toBe(path.resolve(home))
    expect(paths.platformFeePayer).toContain('platform-fee-payer.json')
    expect(paths.fakeService).toContain('fake-service-destination.json')
    expect(() =>
      resolveDevnetX402Config({ rpcUrl: 'https://api.mainnet-beta.solana.com' }),
    ).toThrow('non-devnet endpoint')
  })

  it('keeps decimal conversion exact and makes top-up idempotent', () => {
    expect(parseSolAmount('1.25')).toBe(1_250_000_000n)
    expect(parseTestUsdcAmount('0.001')).toBe(1_000n)
    expect(formatAtomicAmount(1_000n, 6)).toBe('0.001')
    expect(formatAtomicAmount(1_000_000n, 6)).toBe('1')
    expect(amountToTopUp(1_000n, 1_000n)).toBe(0n)
    expect(amountToTopUp(500n, 1_000n)).toBe(500n)
    expect(() => parseTestUsdcAmount('0.0000001')).toThrow('fractional digits')
  })

  it('reuses all identities and does not repeat faucet, ATA, or mint operations', async () => {
    const home = createTemporaryHome()
    const fake = createFakeDevnet()
    const options = {
      homeDirectory: home,
      agentAddress: 'So11111111111111111111111111111111111111112',
      solTargetLamports: 1_000_000_000n,
      tokenTargetAtomic: 1_000_000n,
      pollIntervalMs: 1,
      pollTimeoutMs: 100,
      runCommand: fake.runCommand,
      rpcClient: fake.rpcClient,
    }

    const first = await setupDevnetX402(options)
    const second = await setupDevnetX402(options)

    expect(second).toEqual(first)
    expect(
      fake.commands.filter(
        ({ command, args }) => command === 'solana-keygen' && args[0] === 'new',
      ),
    ).toHaveLength(3)
    expect(
      fake.commands.filter(
        ({ command, args }) => command === 'solana' && args[0] === 'airdrop',
      ),
    ).toHaveLength(1)
    expect(
      fake.commands.filter(
        ({ command, args }) => command === 'spl-token' && args[0] === 'create-account',
      ),
    ).toHaveLength(2)
    expect(
      fake.commands.filter(
        ({ command, args }) => command === 'spl-token' && args[0] === 'mint',
      ),
    ).toHaveLength(1)
    expect(
      readFileSync(path.join(home, 'platform-fee-payer.json'), 'utf8'),
    ).not.toContain(first.platformFeePayer.address)
  })

  it('does not report ready when the fake service token account is missing', async () => {
    const home = createTemporaryHome()
    const fake = createFakeDevnet()
    const options = {
      homeDirectory: home,
      agentAddress: 'So11111111111111111111111111111111111111112',
      solTargetLamports: 1_000_000_000n,
      tokenTargetAtomic: 1_000_000n,
      pollIntervalMs: 1,
      pollTimeoutMs: 100,
      runCommand: fake.runCommand,
      rpcClient: fake.rpcClient,
    }

    const setup = await setupDevnetX402(options)
    expect((await statusDevnetX402(options)).ready).toBe(true)

    fake.tokenAccounts.delete(setup.fakeService.tokenAccount)

    const status = await statusDevnetX402(options)
    expect(status.ready).toBe(false)
  })

  it('reports the public funding requirement when the devnet faucet is rate-limited', async () => {
    const home = createTemporaryHome()
    const fake = createFakeDevnet({ failAirdrop: true })

    await expect(
      setupDevnetX402({
        homeDirectory: home,
        solTargetLamports: 100_000_000n,
        tokenTargetAtomic: 1_000n,
        pollIntervalMs: 1,
        pollTimeoutMs: 100,
        runCommand: fake.runCommand,
        rpcClient: fake.rpcClient,
      }),
    ).rejects.toThrow(
      `Devnet SOL faucet could not fund ${fake.addresses['platform-fee-payer.json']} with 0.1 SOL`,
    )
  })

  it('does not repeat setup effects after an uncertain CLI confirmation', async () => {
    const home = createTemporaryHome()
    const fake = createFakeDevnet({
      uncertainAirdrop: true,
      uncertainMintCreation: true,
      uncertainMint: true,
    })

    await setupDevnetX402({
      homeDirectory: home,
      agentAddress: 'So11111111111111111111111111111111111111112',
      solTargetLamports: 1_000_000_000n,
      tokenTargetAtomic: 1_000_000n,
      pollIntervalMs: 1,
      pollTimeoutMs: 100,
      runCommand: fake.runCommand,
      rpcClient: fake.rpcClient,
    })

    expect(
      fake.commands.filter(
        ({ command, args }) => command === 'spl-token' && args[0] === 'create-token',
      ),
    ).toHaveLength(1)
    expect(
      fake.commands.filter(
        ({ command, args }) => command === 'solana' && args[0] === 'airdrop',
      ),
    ).toHaveLength(1)
    expect(
      fake.commands.filter(
        ({ command, args }) => command === 'spl-token' && args[0] === 'mint',
      ),
    ).toHaveLength(1)
  })
})
