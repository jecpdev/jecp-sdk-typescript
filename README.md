# @jecpdev/sdk

> Official TypeScript SDK for **JECP — Joint Execution & Commerce Protocol**.
> The open protocol for agent-to-service commerce.

[![npm](https://img.shields.io/npm/v/@jecpdev/sdk.svg)](https://npmjs.com/package/@jecpdev/sdk)
[![CI](https://github.com/jecpdev/jecp-sdk-typescript/actions/workflows/ci.yml/badge.svg)](https://github.com/jecpdev/jecp-sdk-typescript/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Spec](https://img.shields.io/badge/spec-v1.0--draft-blue.svg)](https://github.com/jecpdev/jecp-spec)

```bash
npm install @jecpdev/sdk
```

JECP serves two opposite intents through one protocol:

- **Sell to agents** — earn revenue from AI agent traffic on your service
- **Build with agents** — give your agent its own wallet and budget cap

Both share the same SDK.

---

## Quick start: your agent invokes a capability

```typescript
import { JecpClient, InsufficientBalanceError } from '@jecpdev/sdk';

const jecp = new JecpClient({
  agentId: process.env.AGENT_ID!,   // jdb_ag_*
  apiKey:  process.env.AGENT_KEY!,  // jdb_ak_*
});

try {
  const { output, billing, wallet_balance_after } = await jecp.invoke(
    'jobdonebot/content-factory',
    'translate',
    { text: 'Hello, world!', target_lang: 'JA' },
    { mandate: { budget_usdc: 1.00 } },  // pre-auth budget cap
  );

  console.log(output);                  // { translated: 'こんにちは、世界!' }
  console.log('charged:', billing.charged);
  console.log('balance after:', wallet_balance_after);
} catch (e) {
  if (e instanceof InsufficientBalanceError) {
    // Auto-recovery — open the topup URL
    console.log('Top up here:', e.nextAction?.api);
  } else {
    throw e;
  }
}
```

---

## Quick start: register a new agent

```typescript
import { JecpClient } from '@jecpdev/sdk';

const { agent_id, api_key, free_calls_remaining } = await JecpClient.register({
  name: 'MyResearchAgent',
  agent_type: 'research',
  description: 'Reads PDFs, writes summaries',
});

console.log('Save these forever:');
console.log('AGENT_ID =', agent_id);
console.log('AGENT_KEY =', api_key);
console.log('Free calls:', free_calls_remaining);
```

---

## Quick start: top up the agent's wallet

```typescript
const { url } = await jecp.topup(20);
// open `url` in browser → pay via Stripe → balance += $20
```

---

## Quick start: pay agents in USDC on Base (x402 mode) — v0.8+

Skip Stripe entirely: pay each invoke from a Base wallet in USDC. No top-ups,
no human-in-the-loop, settled in seconds via the [x402 protocol](https://x402.org).
Spec: [Locked Design v1.1.1 §3 + §6](https://github.com/jecpdev/jecp-spec).

**Full 4-command setup**: see [`docs/x402-quickstart.md`](./docs/x402-quickstart.md).

```typescript
import { JecpClient, walletFromEnv } from '@jecpdev/sdk';
// peer dep: npm install ethers

const jecp = new JecpClient({
  agentId: process.env.JECP_AGENT_ID!,
  apiKey:  process.env.JECP_API_KEY!,
  payment: {
    mode: 'auto',                  // 'wallet' | 'x402' | 'auto' (default)
    signer: walletFromEnv(),       // reads AGENT_BASE_KEY env var
    maxPerCallUsdc: 1_000_000n,    // safety cap: $1 max per invoke
    maxPerHourUsdc: 10_000_000n,   // safety cap: $10 rolling 1h budget
    maxGasRatio: 0.05,             // safety cap: gas <= 5% of invoke amount
  },
});

const r = await jecp.invoke('jobdonebot/bg-remover-pro', 'remove', {
  image_url: 'https://example.com/cat.png',
});

console.log(r.output);              // capability result
console.log(r.payment?.txHash);     // 0x... — settlement tx on Base
console.log(r.payment?.amount_usd); // 0.20

// Estimate cost before invoking
const cost = await jecp.estimateCost('jobdonebot/bg-remover-pro');
// → { usd: 0.20, usdc: 200000n, gasEstimateUsd: 0.004 }
```

### Safety caps (v0.8.2)

Three SDK-side caps refuse to sign EIP-3009 authorizations that exceed
budget. Each throws a typed error with a `nextAction` hint:

| Cap | Error class | `nextAction.type` |
|---|---|---|
| `maxPerCallUsdc` | `X402AmountCapExceededError` | `raise_cap` |
| `maxPerHourUsdc` | `X402HourlyCapExceededError` | `review_intent` |
| `maxGasRatio` | `X402GasRatioExceededError` | `check_gas` |

Defense-in-depth: an autonomous agent that can be tricked into draining
its wallet is a CVE. SDK caps run **before** signing so a compromised
facilitator cannot extract a too-large signature.

### Roll your own Signer

`walletFromEnv()` is convenience; `JecpClient` accepts any `Signer`:

```typescript
import type { Signer } from '@jecpdev/sdk';

const mySigner: Signer = {
  async getAddress() { /* ... */ },
  async signEIP3009(params) { /* returns { v, r, s } */ },
};
```

Common patterns: viem `WalletClient`, AWS KMS Ethereum signer, hardware
wallets. The SDK never holds private keys.

**Modes**:
- `'auto'` (default): try x402 first when capability accepts it; otherwise
  surface the typed 402 error so the caller can drive Stripe Checkout via
  `err.nextAction`.
- `'wallet'`: identical to pre-0.8 behavior. Never attempts x402.
- `'x402'`: refuse to pay via wallet. Throws `InsufficientPaymentOptionsError`
  if the capability is wallet-only or no signer is configured.

**Typed errors** (Locked Design §3.5):
`X402PaymentInvalidError`, `X402NotAcceptedError`, `X402SettlementTimeoutError`,
`X402FacilitatorUnreachableError`, `X402SettlementReusedError`,
`InsufficientPaymentOptionsError`. All extend `JecpError`; each exposes
`.subcause` and `.retryable`.

---

## Quick start: become a Provider (server side)

If you're a service provider receiving JECP invocations:

```typescript
import { JecpProvider } from '@jecpdev/sdk';

const provider = new JecpProvider({
  hmacSecret: process.env.JECP_HMAC_SECRET!, // from /v1/providers/register
});

// Works with Bun.serve, Cloudflare Workers, Next.js Route Handlers, Hono...
const handler = provider.createHandler(async (req) => {
  // req.capability, req.action, req.input are validated and parsed
  switch (req.action) {
    case 'translate':
      return { translated: await myTranslate(req.input) };
    default:
      throw new Error(`unknown action: ${req.action}`);
  }
});

// Express:
app.post('/jecp', async (req, res) => {
  const fetchReq = new Request(`https://${req.hostname}${req.url}`, {
    method: 'POST',
    headers: req.headers as any,
    body: JSON.stringify(req.body),
  });
  const fetchRes = await handler(fetchReq);
  res.status(fetchRes.status).json(await fetchRes.json());
});

// Bun.serve:
Bun.serve({ port: 3000, fetch: handler });
```

---

## Error handling with `next_action`

Every JECP error includes a machine-readable `next_action` so agents can recover automatically:

```typescript
try {
  await jecp.invoke('any/cap', 'action', {});
} catch (e) {
  if (e instanceof JecpError) {
    switch (e.nextAction?.type) {
      case 'topup':         // open Stripe checkout
        await jecp.topup(20);
        break;
      case 'register':      // agent not authenticated
        await JecpClient.register({ name: 'NewAgent' });
        break;
      case 'discover':      // capability typo
        const cat = await jecp.catalog();
        // pick a real one
        break;
      case 'retry_after':   // rate limited
        await sleep(60_000);
        break;
      // ...
    }
  }
}
```

### Typed error classes

| Class | Code | When |
|-------|------|------|
| `InsufficientBalanceError` | `INSUFFICIENT_BALANCE` | Wallet too low for action |
| `InsufficientBudgetError` | `INSUFFICIENT_BUDGET` | Mandate budget < action price |
| `MandateExpiredError` | `MANDATE_EXPIRED` | `expires_at` in the past |
| `AuthError` | `AUTH_REQUIRED` / `INVALID_AGENT` | Missing or wrong credentials |
| `RateLimitError` | `RATE_LIMITED` | 60 RPM/agent default cap |
| `CapabilityNotFoundError` | `CAPABILITY_NOT_FOUND` | Unknown `namespace/capability` |
| `ActionNotFoundError` | `ACTION_NOT_FOUND` | Action not in manifest |
| `InsufficientTrustError` | `INSUFFICIENT_TRUST` | Action requires higher Trust Tier |
| `ProviderError` | `PROVIDER_ERROR` / `PROVIDER_UNREACHABLE` | Provider endpoint failure |
| `JecpError` | (anything else) | Generic |

All errors carry `.code`, `.status`, `.message`, `.nextAction`, `.raw`.

---

## Agent guide JSON

For machine-readable explanation of JECP (used by AI agents to understand the protocol):

```typescript
const guide = await JecpClient.agentGuide();
// or fetch directly: https://jecp.dev/.well-known/agent-guide.json
```

---

## Production-grade defaults (v0.2)

```typescript
const jecp = new JecpClient({
  agentId, apiKey,
  // All optional, sensible defaults:
  timeoutMs: 30_000,                  // per-call default
  retryConfig: { maxRetries: 3 },     // exp backoff + jitter on 5xx/408/429/network
  logger: console,                    // observe retries/timeouts/errors
});

// AbortSignal + per-call timeout supported on every method
const ctl = new AbortController();
const r = await jecp.invoke('a/b', 'c', input, {
  signal: ctl.signal,
  timeoutMs: 60_000,
});
console.log('attempts taken:', r.attempts);
console.log('idempotency key:', r.request_id);
```

Auto-retry preserves the same `request_id` across attempts so the Hub's idempotency
cache prevents double-charging.

## Browser / edge runtime

For Cloudflare Workers, Deno, Vite/webpack browser builds, or any runtime without
`node:crypto`:

```typescript
import { JecpClient, JecpProvider } from '@jecpdev/sdk/browser';
```

The browser entry uses Web Crypto API exclusively. Same public API, different
HMAC backend. Build output is split (`dist/index.js` for Node,
`dist/index-browser.js` for edge).

## Webhook verification

When the Hub posts asynchronous events (`invocation.completed`,
`wallet.low_balance`, `provider.kyc_status_changed`):

```typescript
import { verifyWebhook } from '@jecpdev/sdk';

app.post('/jecp/webhook', async (req) => {
  try {
    const event = await verifyWebhook({
      body: req.rawBody,                                // raw bytes
      signature: req.headers['x-jecp-webhook-signature'],
      timestamp: req.headers['x-jecp-webhook-timestamp'],
      secret: process.env.JECP_WEBHOOK_SECRET!,
    });
    // event.type, event.data
  } catch (e) {
    return new Response('invalid signature', { status: 401 });
  }
});
```

Replay window defaults to ±5 min. Configurable via `replayWindowSec`.

## Examples

Runnable examples in [`examples/`](./examples):

- [`01-register-and-invoke.ts`](./examples/01-register-and-invoke.ts) — register + first call
- [`02-error-recovery.ts`](./examples/02-error-recovery.ts) — `next_action` discriminated-union recovery
- [`03-mandate-budget-cap.ts`](./examples/03-mandate-budget-cap.ts) — pre-authorized spend cap
- [`04-provider-server.ts`](./examples/04-provider-server.ts) — Provider endpoint with HMAC
- [`05-x402-invoke.ts`](./examples/05-x402-invoke.ts) — pay each invoke in USDC on Base (v0.8.2)

## Reference

- **Spec**: <https://github.com/jecpdev/jecp-spec>
- **Live catalog**: <https://jecp.dev/v1/capabilities>
- **Health**: <https://jecp.dev/health>
- **Discussions**: <https://github.com/jecpdev/jecp-spec/discussions>
- **Changelog**: [CHANGELOG.md](./CHANGELOG.md)
- **Email**: hello@jecp.dev

## License

Apache License 2.0 · Maintained by Tufe Company Inc.
