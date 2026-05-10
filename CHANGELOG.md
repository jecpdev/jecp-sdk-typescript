# Changelog

All notable changes to `@jecpdev/sdk` are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.0] - 2026-05-10

Provenance v2 verifier + replay cache (R2 + R3 + H3 from JECP v1.0.1).
Aligns with `jecp-spec` v1.0.1.

### Added
- `verifyProvenanceV2(input)` returning a discriminated union
  `{ ok: true, timestamp, nonce } | { ok: false, subcause, detail }`.
  Sync, never throws on verification failure (Stripe webhook pattern).
  Constant-time HMAC compare via `node:crypto.timingSafeEqual`.
  Configurable `clockSkewSec` (default 300s) + injectable `now()` for tests.
- `createReplayCache({ ttlSec, now })` — companion in-memory LRU for
  Provider-side replay defense. Lowercase nonce normalisation.
- Public types: `ProvenanceSubcause`, `VerifyProvenanceV2Input`,
  `VerifyProvenanceResult`, `ReplayCache`, `ReplayCacheOptions`.

### Changed
- Wire-format ordering: tag length validation now fires BEFORE clock-skew,
  matching Hub Rust impl and the cross-stack fixture (closes a divergence
  surfaced by qa-pro panel review).

### Tests
- `test/fixtures/provenance-v2-vectors.json` vendored from
  `jecp-spec/fixtures/` (sha256 544a4901...).
- `test/fixture.test.ts` consumes the fixture: 14 new tests.
- Total suite: 104/104 PASS (was 90/90).

## [0.6.0] - 2026-05-10

Provenance v2 (HMAC-SHA256). Aligns with `jecp-spec` v1.0.0-stable.

### Added
- `computeProvenanceV2({ apiKey, agentId, timestamp?, nonce? })` — returns
  the `"v2:<unix_seconds>:<nonce_hex>:<hmac_hex>"` wire string for
  `mandate.provenance_hash`. Defaults: `timestamp = floor(Date.now()/1000)`,
  `nonce = randomBytes(16).toString('hex')`. Validates nonce ≥ 16 hex chars.
- `computeProvenanceV1({ apiKey, agentId, totalCalls })` — `@deprecated`
  helper for emitting legacy SHA-256 hashes. Sunset 2026-11-01.
- Type export: `ComputeProvenanceV2Input`.

### Changed
- README + JSDoc: v1 sunset wording aligned with spec §5.7 (verifier removal
  2026-11-01; `Deprecation` / `Sunset` response headers from 2026-08-01).

### Tests
- 9 new vitest cases (round-trip, key isolation, default ts/nonce,
  malformed input, v1 reference, v1 prefix-collision demonstration).
- Full suite: 77/77 PASS.

## [0.5.0] - 2026-05-09

API key rotation (M2). Aligns with Hub `/v1/agents/me/rotate-key` and
`/v1/providers/me/rotate-key` endpoints.

### Added
- `JecpClient.rotateKey({ graceSeconds?, revokeOld? })` returning the new
  api_key plus a `previous_key_valid_until` timestamp.
- `JecpProvider.rotateKey(...)` mirror for Provider key rotation.

### Changed
- Internal request retries treat HTTP 401 from a rotated key as a
  one-shot retry with `previous_api_key` (within grace window).

## [0.4.0] - 2026-05-09

Streaming responses (W5).

### Added
- `JecpStream` — AsyncIterable for SSE event streams. Yields parsed
  `chunk` / `meter` / `completed` / `error` / `cancelled` events.
- `JecpClient.invokeStream(capability, action, input, options?)` —
  initiates a streaming invocation. Returns `JecpStream`.
- `JecpStream.toArray()` — drain all events into an array.
- `JecpStream.toText()` — concatenate `chunk` deltas as text (LLM-friendly).
- `JecpStream.final()` — wait for terminal event, return billing/result.
- AbortSignal propagation through stream — abort closes upstream cleanly.
- 8 new tests (66 total) covering parsing, terminal events, abort.

### Spec
- See `jobdonebot:docs/jecp/world-no1-roadmap/05-streaming-deep-design.md`
  for full protocol details (backpressure, cancellation, pricing models,
  idempotency, mid-stream Mandate enforcement).

### Notes
- Hub-side SSE pass-through implementation pending — invokeStream() will
  return a meaningful response once Hub W5 lands. SDK is forward-compatible
  with future Hub releases.

## [0.3.0] - 2026-05-09

Refunds + Webhook subscriptions (matches Hub W2 + W4).

### Added
- `requestRefund({ transaction_id, reason, evidence_url? })` — request a refund within
  30 days of the original charge. Returns refund_id + estimated_resolution time.
- `getRefund(refundId)` — read a refund's current state.
- `listRefunds({ limit? })` — list your own refund requests (agent side).
- `subscribe({ endpoint_url, events? })` — subscribe to async webhook events. Returns
  the subscription with `hmac_secret` (shown once — pair with `verifyWebhook()`).
- `listSubscriptions()` — list active webhook subscriptions.
- `testSubscription(id)` — fire a synthetic test event to verify your endpoint.

### Notes
- Refund auto-approves after 24h if Provider doesn't respond. 90% returns to agent
  (Hub keeps its 10% fee even on refund — processing cost). Provider's 85% share
  is debited from `pending` revenue split.
- Webhook events are HMAC-SHA256 signed. Verify with `verifyWebhook()` (already in v0.2).
- v1 event types: `invocation.completed`, `invocation.refunded`, `wallet.low_balance`,
  `provider.kyc_status_changed`, `test.synthetic`.

## [0.2.0] - 2026-05-09

Resilience, observability, and edge-runtime support.

### Added

- **Auto-retry** with exponential backoff + full jitter for transient errors
  (5xx, 408, 429, network failures). Tunable via `retryConfig` option.
  Idempotency-Key (the JECP `id` field) preserved across retries.
- **`Retry-After` header support** — server-instructed delay honored as a floor
  when retrying 429/503.
- **AbortSignal** — cancel in-flight calls and pending retries via standard
  `AbortController`. Propagates through every method.
- **Per-call timeout** — override the client's default timeout for individual
  `invoke()`/`topup()`/`catalog()`/`shareKit()` calls.
- **Browser/edge entry point** — `import { JecpClient, JecpProvider } from '@jecpdev/sdk/browser'`
  uses the Web Crypto API instead of `node:crypto`. Works on Cloudflare Workers,
  Deno, Vite/webpack browser builds, and modern browsers.
- **Webhook verifier** — `verifyWebhook()` validates inbound HMAC-signed
  webhook events from the Hub (`invocation.completed`, `wallet.low_balance`,
  etc.) with replay window enforcement.
- **Logger interface** — optional `logger` injected on the client surfaces
  retry attempts, timeouts, and terminal errors. `consoleLogger` and
  `noopLogger` provided.
- **`InvokeResult.attempts` and `InvokeResult.request_id`** — visible in every
  successful return so callers can observe retry behavior and idempotency keys.
- **Typed `RetryConfig`, `Logger`, `WebhookEvent`** exports for advanced use cases.
- **42 new tests** (55 total, up from 13). Coverage:
  - retry math (jitter range, exponential growth, cap)
  - retry behavior (5xx, 429, idempotency preserved, exhaustion)
  - abort/timeout (external signal, default timeout, per-call override)
  - webhook (valid sig, tampered body, stale timestamp, malformed JSON,
    missing fields, custom replay window)
  - browser provider (HMAC verify, tampered detection, key caching)
  - logger callbacks (warn on retry, error on terminal)

### Changed

- `JecpClient.topup()` signature: second arg is now an options object
  (`{ returnTo?, signal?, timeoutMs? }`) instead of a bare `returnTo` string.
  **This is a breaking change** but topup hasn't shipped at scale yet.
- **Minimum Node version: 20** (was 18). Node 18 reached EOL 2025-04, and the
  `/browser` entry uses global `crypto`, which is Node 19+ only. Rather than
  carry a Node-18 shim, we bumped `engines.node` to `>=20`.
- `JecpClient.catalog()` and `JecpClient.shareKit()` now accept
  `{ signal?, timeoutMs? }`.
- `topup()` now validates `amount` is one of 5/20/100 at the SDK level
  (server still validates as defense-in-depth).
- Build output: `dist/index.{cjs,js,d.ts}` (Node entry) +
  `dist/index-browser.{cjs,js,d.ts}` (Browser entry). CJS/ESM dual.
- Package size CJS: 13.6 KB → 20.1 KB (added webhook + retry + browser).
  ESM: 12.1 KB → 6.1 KB (better tree-shaking via shared chunk).

### Internal

- Refactored request path to a single `requestOnce()` + `requestWithRetry()`.
- Imported `node:crypto` only in the Node provider; browser provider uses
  `crypto.subtle` exclusively.

### Notes

- v0.2 is **mostly backward compatible** with v0.1 for the common path:
  `new JecpClient({ agentId, apiKey })` + `.invoke(...)` works identically.
  The breaking change is the second argument shape of `.topup()`.

## [0.1.0] - 2026-05-08

Initial public release.

### Added

- `JecpClient` (invoke / catalog / topup / shareKit / static register / static agentGuide)
- `JecpProvider` (HMAC verify + Bun/CF Workers/Next.js compatible handler)
- 9 typed error classes derived from server response codes
- `NextAction` discriminated union
- 13 unit tests (vitest)
- Apache 2.0
- CJS + ESM dual build via tsup, full TypeScript declarations
