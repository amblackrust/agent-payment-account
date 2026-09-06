# Roadmap

This document separates the implemented repository from possible future work. It contains no delivery dates or post-v1 commitments.

## Current: v1

The current implementation includes:

- custodial Agent Accounts with encrypted per-account Solana signers;
- one-time, hashed, revocable agent credentials and admin-managed account creation;
- normalized `USD` balances over one configured classic SPL settlement mint;
- account-owned external and managed recipients;
- idempotent `pay`, `send`, and managed-account refund operations;
- outgoing reservations, durable attempts, confirmation, reconciliation, and recovery;
- receive requests, incoming SPL transfer discovery, and normalized transaction history;
- a Fastify HTTP API and agent-facing TypeScript SDK;
- localnet, devnet, testnet, and guarded mainnet-beta configuration;
- automated local PostgreSQL and Solana development setup.

The precise v1 boundaries are documented in [Product](product.md) and [Architecture](architecture.md).

## Post-v1 Status

No post-v1 milestone is committed in this repository. The codebase does not define dates, release targets, or an ordered feature backlog.

## Potential Directions — Not Committed

The following are natural extensions of current limitations, but they are not implemented and should not be read as promises:

- stronger custody isolation such as HSM- or MPC-backed signing;
- more settlement assets or rails with explicit routing and accounting semantics;
- operational tooling for custody, reconciliation, and sponsorship monitoring;
- broader refund support where a safe and verifiable reverse destination exists;
- fiat, FX, compliance, or off-ramp integrations;
- packaged SDK distribution and additional language clients.

Any such work would need explicit product scope, trust-boundary analysis, and compatibility decisions before implementation.
