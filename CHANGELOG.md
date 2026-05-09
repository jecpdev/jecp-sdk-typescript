# Changelog

All notable changes to `@jecpdev/sdk` are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
