# Roadmap

Mux is developing one product: the Agent Payment Account. The current system is a working crypto-native financial account; the long-term direction is a universal account through which an AI agent can pay, receive, hold, and spend value without operating the underlying financial infrastructure.

The phases below describe product direction, not committed dates, releases, integrations, or partnerships. Only **Current Foundation** is implemented today.

| Stage | Product reach |
| --- | --- |
| Current Foundation | Agent → stablecoin / Solana → recipient |
| Machine Economy | Agent → APIs / digital services / agents |
| Real-World Money | Agent → fiat funding / payouts / cards |
| Universal Account | Agent → pay anyone, anywhere |

## Current Foundation

Mux v1 provides persistent custodial Agent Payment Accounts with normalized balances and money operations: `pay`, `send`, `receive`, supported managed-account refunds, and payment and transaction history.

```text
Agent
  ↓
Agent Payment Account
  ↓
stablecoin / Solana
  ↓
recipient
```

The current API already works with `amount`, `currency`, `recipient`, `payment`, and `balance` while hiding transaction construction, associated-token-account derivation, mint decimals, and signing. Settlement uses real classic SPL transfers through one configured Solana rail. External recipients, managed Agent Account recipients, agent-to-agent transfers, an HTTP API, and a TypeScript SDK are implemented. An agent can also pay a service today when that service is represented by a supported external recipient destination.

This foundation is the starting point for every later phase; new protocols and payment rails extend the same Agent Payment Account rather than becoming separate products.

## Phase 1 — Machine Economy

### 1. Machine Payments

Extend the Agent Payment Account from payment and transfer primitives into machine-native commerce.

Planned capabilities include:

- x402, MPP, and other suitable machine-payment protocols;
- automatic handling of payment-required responses;
- payment for APIs and services;
- automatic continuation of an agent task after payment confirmation.

Target resources include API calls, inference, compute, search, datasets, storage, and other digital services. The objective is for an agent to acquire a required digital resource through its existing Mux account and then continue its task.

### 2. Deeper Crypto Abstraction / Unified Money UX

Mux already hides chain mechanics behind a normalized `USD` interface. This milestone completes that abstraction as more assets, currencies, rails, FX paths, and fiat capabilities are introduced.

Unless an operator is debugging settlement, the agent should not need to understand USDC, SPL Token, associated token accounts, mints, gas, or Solana. Its interface remains:

```text
money
currency
recipient
payment
balance
```

The external experience should express `$8.30`; the stablecoin and settlement network should be implementation details selected beneath the account abstraction.

### 3. Rich Recipient Directory

Expand the existing recipient model from a stored destination into an identity and capability directory. A recipient could be addressed as a person, service, email, Agent Account, business, or saved contact.

```text
recipient
 ├─ internal Agent Account
 ├─ Solana
 ├─ bank payout
 └─ card-compatible / other rail
```

One recipient may have several payment destinations, capabilities, and preferences. Mux would use that information to select a suitable destination. This multi-destination model and automatic selection are future capabilities, not part of the current recipient implementation.

## Phase 2 — Real-World Money

### 4. First Fiat Payout Rail

Add the first rail through which an Agent Payment Account can send ordinary money to a person or business.

For an initial Kazakhstan-focused deployment, possible integration targets include FreedomPay, a banking payout provider, or another suitable local payment partner. No partnership or integration is currently claimed.

Target experience:

```text
send 500 KZT to Egor
```

The recipient receives familiar fiat money even if Mux uses stablecoin or Solana infrastructure internally. The milestone tests a central product premise: underlying crypto can support delivery without requiring crypto adoption from the recipient.

### 5. Fiat Funding

Add the reverse flow: fund an Agent Payment Account through a payment card, bank transfer, or local payment method. Mux would convert that funding into available account liquidity, so the user would not need to acquire stablecoin or operate a blockchain wallet.

### 6. Card Rail

Add virtual-card capability as another rail beneath the Agent Payment Account. It would let an agent pay merchants that do not support AI-agent protocols, crypto, or Solana.

Target use cases include ecommerce, SaaS, tickets, hosting, and ordinary online checkout. The card remains a delivery rail inside Mux, not a separate product.

## Phase 3 — Universal Account

### 7. Multi-Rail Payment Routing

As the account gains rails, routing becomes a central capability:

```text
paid API                 → x402 / MPP
another Agent Account    → internal / managed account path
Solana destination       → stablecoin rail
ordinary online merchant → card
person or business       → fiat payout
```

The public interface remains `pay()` and `send()`. The agent expresses financial intent; Mux selects the delivery and settlement path. Specific routing policies have not yet been defined.

### 8. FX and Multi-Currency

Extend normal money semantics beyond the current `USD` contract:

```text
pay $20
send 5000 KZT
pay €15
```

Mux would determine the source value or asset, whether conversion is needed, the FX route, settlement rail, and payout form. At this stage the account should feel closer to a programmable multi-currency financial account than a crypto wallet, without claiming to be a bank or to provide the services of any named financial institution.

### 9. Recurring Commerce

Add subscriptions, recurring payments, automatic renewals, usage-based billing, and recurring service expenses for inference, compute, storage, SaaS, and premium APIs.

This expands the Agent Payment Account from one-time transfers into persistent economic relationships.

### 10. Agent-to-Agent Economy

Mux already supports value transfer between managed Agent Accounts. This milestone extends that primitive into an economic loop in which an agent can:

- set a price for a service;
- accept an order;
- receive payment;
- hold the earned balance;
- buy services or resources from other agents;
- fund purchases with prior earnings.

```text
earn
 ↓
hold
 ↓
spend
 ↓
earn
```

Marketplace implementation, discovery protocols, and order schemas are intentionally unspecified.

### 11. Universal Financial Account

The long-term Agent Payment Account interface remains compact:

```text
balance
pay
send
receive
refund
subscribe
```

Beneath it, Mux may coordinate Solana, stablecoins, x402 or MPP, internal transfers, cards, bank rails, local payouts, and FX. The agent states who should be paid, how much, in which currency, and for what purpose. Mux determines the payment route, settlement rail, conversion, and delivery method.

> One financial account for AI agents — pay anyone, anywhere, without the agent needing to understand the underlying financial infrastructure.

This is the long-term product vision, not a description of the current v1 capability set.
