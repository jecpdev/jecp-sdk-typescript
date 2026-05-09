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

## Reference

- **Spec**: <https://github.com/jecpdev/jecp-spec>
- **Live catalog**: <https://jecp.dev/v1/capabilities>
- **Health**: <https://jecp.dev/health>
- **Discussions**: <https://github.com/jecpdev/jecp-spec/discussions>
- **Changelog**: [CHANGELOG.md](./CHANGELOG.md)
- **Email**: hello@jecp.dev

## License

Apache License 2.0 · Maintained by Tufe Company Inc.
