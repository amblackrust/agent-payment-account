import { AgentPaymentAccount, type PaymentStatus } from '@agent-payment/sdk'

const account = new AgentPaymentAccount({
  baseUrl: process.env.AGENT_PAYMENT_BASE_URL ?? 'http://localhost:3000',
  apiKey: process.env.AGENT_PAYMENT_API_KEY ?? '',
})

const balance = await account.getBalance()
console.log('available USD:', balance.available)

const payment = await account.pay(
  {
    recipientId: 'rcpt_preconfigured',
    amount: '0.50',
    description: 'scheduled transfer',
  },
  { idempotencyKey: 'example-payment-001' },
)

let current = payment
const pendingStatuses: readonly PaymentStatus[] = [
  'CREATED',
  'ROUTING',
  'SUBMITTED',
  'RECONCILING',
]
while (pendingStatuses.includes(current.status)) {
  await new Promise((resolve) => setTimeout(resolve, 500))
  current = await account.getPayment(current.id)
}

const transactions = await account.listTransactions()
console.log('payment status:', current.status)
console.log('transaction count:', transactions.length)
