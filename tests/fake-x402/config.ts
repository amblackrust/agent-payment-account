import { address } from '@solana/kit'

export const DEVNET_NETWORK = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'
export const MAINNET_NETWORK = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'
export const MAINNET_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
export const DEFAULT_HOST = '127.0.0.1'
export const DEFAULT_PORT = 4542
export const DEFAULT_RPC_URL = 'https://api.devnet.solana.com'
export const DEFAULT_AMOUNT_ATOMIC = 1_000n
export const DEFAULT_TOKEN_DECIMALS = 6
export const DEFAULT_MAX_TIMEOUT_SECONDS = 300
export const RESOURCE_PATH = '/api/crypto/price?ids=bitcoin'

export interface FakeX402Config {
  readonly host: string
  readonly port: number
  readonly rpcUrl: string
  readonly network: typeof DEVNET_NETWORK
  readonly settlementMint: string
  readonly destination: string
  readonly facilitatorFeePayer: string
  readonly amountAtomic: bigint
  readonly tokenDecimals: number
  readonly maxTimeoutSeconds: number
  readonly resourceUrl: string
}

export function loadFakeX402Config(
  environment: NodeJS.ProcessEnv = process.env,
): FakeX402Config {
  const host = environment.FAKE_X402_HOST?.trim() || DEFAULT_HOST
  const port = parsePositiveInteger(
    environment.FAKE_X402_PORT,
    DEFAULT_PORT,
    'FAKE_X402_PORT',
  )
  const rpcUrl = environment.FAKE_X402_RPC_URL?.trim() || DEFAULT_RPC_URL
  assertDevnetRpcUrl(rpcUrl)

  const network = environment.FAKE_X402_NETWORK?.trim() || DEVNET_NETWORK
  if (network !== DEVNET_NETWORK) {
    throw new Error('FAKE_X402_NETWORK must be the Solana devnet CAIP-2 network')
  }

  const settlementMint = requireSolanaAddress(
    environment.FAKE_X402_TEST_USDC_MINT,
    'FAKE_X402_TEST_USDC_MINT',
  )
  if (settlementMint === MAINNET_USDC_MINT) {
    throw new Error('The fake x402 service cannot use the mainnet USDC mint')
  }

  const destination = requireSolanaAddress(
    environment.FAKE_X402_DESTINATION,
    'FAKE_X402_DESTINATION',
  )
  const facilitatorFeePayer = requireSolanaAddress(
    environment.FAKE_X402_FEE_PAYER,
    'FAKE_X402_FEE_PAYER',
  )
  if (destination === facilitatorFeePayer) {
    throw new Error('Fake x402 destination and facilitator fee payer must differ')
  }

  const amountAtomic = parsePositiveBigInt(
    environment.FAKE_X402_AMOUNT_ATOMIC,
    DEFAULT_AMOUNT_ATOMIC,
    'FAKE_X402_AMOUNT_ATOMIC',
  )
  const tokenDecimals = parseBoundedInteger(
    environment.FAKE_X402_TOKEN_DECIMALS,
    DEFAULT_TOKEN_DECIMALS,
    'FAKE_X402_TOKEN_DECIMALS',
    0,
    18,
  )
  const maxTimeoutSeconds = parseBoundedInteger(
    environment.FAKE_X402_MAX_TIMEOUT_SECONDS,
    DEFAULT_MAX_TIMEOUT_SECONDS,
    'FAKE_X402_MAX_TIMEOUT_SECONDS',
    1,
    3_600,
  )
  const resourceUrl =
    environment.FAKE_X402_RESOURCE_URL?.trim() ||
    `http://${host}:${port}${RESOURCE_PATH}`
  assertResourceUrl(resourceUrl)

  return {
    host,
    port,
    rpcUrl,
    network,
    settlementMint,
    destination,
    facilitatorFeePayer,
    amountAtomic,
    tokenDecimals,
    maxTimeoutSeconds,
    resourceUrl,
  }
}

function requireSolanaAddress(value: string | undefined, name: string): string {
  const candidate = value?.trim()
  if (candidate === undefined || candidate.length === 0) {
    throw new Error(`${name} is required`)
  }
  try {
    return address(candidate)
  } catch {
    throw new Error(`${name} must be a valid Solana address`)
  }
}

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  return parseBoundedInteger(value, fallback, name, 1, 65_535)
}

function parseBoundedInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const candidate =
    value === undefined || value.trim() === '' ? fallback : Number(value)
  if (!Number.isInteger(candidate) || candidate < minimum || candidate > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`)
  }
  return candidate
}

function parsePositiveBigInt(
  value: string | undefined,
  fallback: bigint,
  name: string,
): bigint {
  const candidate =
    value === undefined || value.trim() === '' ? fallback.toString() : value.trim()
  if (!/^\d+$/u.test(candidate) || BigInt(candidate) <= 0n) {
    throw new Error(`${name} must be a positive integer amount in atomic units`)
  }
  return BigInt(candidate)
}

function assertDevnetRpcUrl(rpcUrl: string): void {
  let parsed: URL
  try {
    parsed = new URL(rpcUrl)
  } catch {
    throw new Error('FAKE_X402_RPC_URL must be an absolute URL')
  }
  if (
    /mainnet|testnet|localhost|127\.0\.0\.1|0\.0\.0\.0/iu.test(parsed.hostname) ||
    /mainnet|testnet/iu.test(parsed.pathname)
  ) {
    throw new Error('The fake x402 service requires a public Solana devnet RPC URL')
  }
}

function assertResourceUrl(resourceUrl: string): void {
  let parsed: URL
  try {
    parsed = new URL(resourceUrl)
  } catch {
    throw new Error('FAKE_X402_RESOURCE_URL must be an absolute URL')
  }
  if (parsed.pathname !== '/api/crypto/price' || parsed.search !== '?ids=bitcoin') {
    throw new Error('FAKE_X402_RESOURCE_URL must target the bitcoin price resource')
  }
}
