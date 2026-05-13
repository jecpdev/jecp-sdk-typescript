# x402 Quickstart — pay each invoke from a Base USDC wallet

> Target reading time: **60 seconds**. Target time-to-first-paid-invoke: **3 minutes**.
> Spec: [Locked Design v1.1.1 §3 + §6](https://github.com/jecpdev/jecp-spec).

Four commands take you from `npm install` to your agent settling USDC on
Base for every paid capability invoke. No Stripe top-ups, no human in the
loop. The SDK never sees your private key.

---

## 1. Install

```bash
npm install @jecpdev/sdk ethers
```

`ethers` is a peer dependency — the SDK does not ship it (browser bundles
stay lean). v6 or newer is required.

## 2. Set the env var

```bash
export AGENT_BASE_KEY=0x...   # 32-byte private key for an EOA on Base
```

This is the wallet that will pay for invokes. Keep it isolated to your
agent — don't reuse a personal wallet.

## 3. Top up the wallet

Move USDC to that address on Base mainnet (chain id 8453) or Base Sepolia
(84532). Two paths:

- **Coinbase Onramp**: card or ACH → Base USDC. Open
  <https://pay.coinbase.com/buy/select-asset?assets=USDC>, paste the
  EOA address derived from `AGENT_BASE_KEY`.
- **Coinbase Developer Platform (CDP)**: programmatic wallet provisioning
  with treasury-funded transfers. See
  <https://portal.cdp.coinbase.com/products/wallet-api>.

A typical x402 invoke is $0.20-$1.00, so $5 of USDC is plenty for testing.

## 4. Code (10 lines)

```typescript
import { JecpClient, walletFromEnv } from '@jecpdev/sdk';

const jecp = new JecpClient({
  agentId: process.env.JECP_AGENT_ID!,
  apiKey:  process.env.JECP_API_KEY!,
  payment: {
    mode: 'x402',
    signer: walletFromEnv(),       // reads AGENT_BASE_KEY
    maxPerCallUsdc: 1_000_000n,    // safety cap: $1 max per invoke
  },
});

const r = await jecp.invoke('jobdonebot/bg-remover-pro', 'remove', {
  image_url: 'https://example.com/cat.png',
});
```

## Verify

```typescript
console.log(r.output);          // capability result
console.log(r.payment?.txHash); // 0x... — settlement tx on Base
console.log(r.payment?.amount_usd); // 0.20
```

Look up the tx on <https://basescan.org/tx/{txHash}> to confirm the
on-chain 85/10/5 revenue split landed in a single block.

---

## Safety caps (recommended in production)

An autonomous agent that can be tricked into draining its wallet is a CVE.
The SDK enforces three caps **before** signing, so a compromised facilitator
or prompt-injected agent cannot extract a signature for a too-large amount.

```typescript
payment: {
  mode: 'x402',
  signer: walletFromEnv(),
  maxPerCallUsdc: 1_000_000n,    // refuse to sign if 402 asks for > $1
  maxPerHourUsdc: 10_000_000n,   // refuse if rolling 1h sum + ask > $10
  maxGasRatio: 0.05,             // refuse if gas > 5% of invoke amount
}
```

Cap breaches throw typed errors with `nextAction` hints:

| Error | `nextAction.type` | What to do |
|---|---|---|
| `X402AmountCapExceededError` | `raise_cap` | The Hub asked for more than your per-call cap. Audit the capability's pricing or bump the cap. |
| `X402HourlyCapExceededError` | `review_intent` | Your agent ran hot — pause it and inspect call patterns. |
| `X402GasRatioExceededError` | `check_gas` | Base congested. Wait, or raise `maxGasRatio` if you accept higher overhead. |

These caps are **not** a substitute for Hub-side mandate budgets — they
are the inner-most ring of defense, paired with `mandate.budget_usdc`.

---

## Default mode is `auto` — backward compatible

`mode: 'x402'` strictly refuses to fall back to Stripe wallet path. If you
want both:

```typescript
payment: { mode: 'auto', signer: walletFromEnv() }
```

`auto` (default) tries x402 first when the capability supports it,
otherwise surfaces the typed 402 error so you can drive a Stripe Checkout
via `err.nextAction`.

---

## Error handling

Every x402-specific error class carries `subcause`, `retryable`, and
`nextAction`:

```typescript
import {
  X402PaymentInvalidError,
  X402SettlementTimeoutError,
  X402FacilitatorUnreachableError,
  X402SettlementReusedError,
  X402AmountCapExceededError,
} from '@jecpdev/sdk';

try {
  const r = await jecp.invoke(/* ... */);
} catch (e) {
  if (e instanceof X402PaymentInvalidError) {
    // subcause: signature_invalid | amount_mismatch | nonce_reused | expired
    console.log('facilitator rejected:', e.subcause, e.nextAction?.hint);
  } else if (e instanceof X402SettlementTimeoutError) {
    // retryable — wait, regenerate nonce, retry
  }
  // ... other branches
}
```

The full error catalog is in [`spec/03-error-catalog.md`](https://github.com/jecpdev/jecp-spec/blob/main/spec/03-error-catalog.md).

---

## Performance characteristics

The 402-then-X-Payment retry adds **200-300ms** to the first invoke wall
clock (one extra round-trip + EIP-712 signing). Subsequent invokes in the
same `JecpClient` re-use the signer adapter — there's no warm-up cost.

If you'd rather avoid the round-trip, the Hub publishes per-action pricing
in the catalog manifest; pre-sign by reading `JecpClient.estimateCost()`
and constructing your own EIP-3009 authorization (see
[`examples/05-x402-invoke.ts`](../examples/05-x402-invoke.ts) for the full
manual path).

---

## Running the live example

```bash
git clone https://github.com/jecpdev/jecp-sdk-typescript
cd jecp-sdk-typescript
npm install
export AGENT_BASE_KEY=0x...
export JECP_AGENT_ID=jdb_ag_...
export JECP_API_KEY=jdb_ak_...
npx tsx examples/05-x402-invoke.ts
```

---

## What's NOT in this quickstart

- **Coinbase Onramp deep-link helper** — deferred to v0.9 (`@jecpdev/sdk/x402/onramp`).
- **viem adapter** — bring-your-own; the `Signer` interface is 2 methods.
- **AWS KMS Ethereum signer** — see locked-design §H-3 for the production
  pattern; ships post-GA.

## Reference

- [Spec v1.1.0 — §4 x402 integration](https://github.com/jecpdev/jecp-spec/blob/main/spec/04-x402-integration.md)
- [Locked Design v1.1.1](https://github.com/tufedev/jobdonebot/blob/main/docs/jecp/x402-integration-locked-design.md) (project-internal)
- [Audit-D UX panel report](https://github.com/tufedev/jobdonebot/blob/main/docs/jecp/x402-design/postimpl/audit-D-ux.md) (project-internal)
- [README.md](../README.md) — full SDK surface
- [CHANGELOG.md](../CHANGELOG.md) — v0.8.2 release notes
