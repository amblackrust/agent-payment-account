# Basic SDK usage

This technical example uses a preconfigured recipient and the agent-facing SDK.
Set `AGENT_PAYMENT_BASE_URL` and `AGENT_PAYMENT_API_KEY`, then run the TypeScript
file with a Node.js TypeScript runner such as `tsx`.

The SDK owns HTTP authentication, response validation, and idempotency headers.
The example uses an explicit polling loop for pending payments. The integration
does not require a Solana package.
