# Changelog

All notable changes to `@jecpdev/sdk` are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.8.3] - 2026-05-15

audit-A residual sweep — additive, backward-compatible.

Closes audit findings:
- **A-L3** (LOW): `X402NotAcceptedError` typed accessors `accepted` and
  `received` reading from `details.{accepted, received}` (which the Hub
  emits per spec §3.5 since the Critical sweep). DX gap closed.
- **A-L4** (LOW): `packSignature` JSDoc enriched with EIP-2 + JECP §3 +
  x402 v1 §4 citations explaining `v < 27 ? v + 27 : v` normalization.

Tests: 175 passed (was 172, +3 new).
Build: clean (CJS+ESM+DTS).
No new package.json dependencies.

## [0.8.2] - 2026-05-13

UX P0 + SDK safety caps. Backward-compatible — all additions are additive.

Closes audit findings:
- **H-4** (audit-D §A.3 P0-1, P0-2, P0-3, P0-4): `walletFromEnv()` helper,
  `docs/x402-quickstart.md`, `examples/05-x402-invoke.ts`, error `nextAction`
  enrichment.
- **H-6** (panel-4 §A.3 + audit-B cross-finding): `maxPerCallUsdc`,
  `maxPerHourUsdc`, `maxGasRatio` SDK safety caps with 3 typed error classes.

### Added

#### Signer helpers (H-4.1)
- `walletFromEnv({ envVar?, rpcUrl? })` — reads a 0x-prefixed 64-hex-char
  private key from `process.env[envVar || 'AGENT_BASE_KEY']`, validates it,
  returns a `Signer` that produces canonical USDC EIP-712 signatures on Base.
- `walletFromPrivateKey(privateKeyHex, rpcUrl?)` — direct programmatic form.
- Both lazy-load `ethers` v6 via `require()`; the SDK does NOT declare ethers
  as a dependency. Missing peer dep throws an actionable install hint.
- Exported from `@jecpdev/sdk` (Node entry) and `@jecpdev/sdk/x402/signers`.
- Not exported from `@jecpdev/sdk/browser` (process.env is Node-only).

#### Safety caps (H-6)
- `PaymentConfig.maxPerCallUsdc?: bigint` — per-invoke spend ceiling (USDC micros).
  Throws `X402AmountCapExceededError` before signing.
- `PaymentConfig.maxPerHourUsdc?: bigint` — rolling 1h spend ceiling, scoped
  to the `JecpClient` instance. Throws `X402HourlyCapExceededError` before
  signing. Window GC happens at check time; failed settlements don't count.
- `PaymentConfig.maxGasRatio?: number` — refuse if `gasEstimateUsd / amountUsd`
  exceeds this ratio (defense against fee-malleability under congestion).
  Throws `X402GasRatioExceededError` before signing. Prefers Hub-supplied
  `x402Req.extra.gas_estimate_usd` over the SDK heuristic ($0.004).

#### Error classes (3 new + 5 enriched)
- `X402AmountCapExceededError` — carries `requestedUsdc`, `capUsdc`,
  `nextAction.type = 'raise_cap'`.
- `X402HourlyCapExceededError` — carries `requestedUsdc`, `cumulativeUsdc`,
  `capUsdc`, `nextAction.type = 'review_intent'`.
- `X402GasRatioExceededError` — carries `gasUsd`, `amountUsd`,
  `observedRatio`, `capRatio`, `nextAction.type = 'check_gas'`.

#### Error `nextAction` enrichment (H-4.4)
All 5 wire `X402_*` error classes now synthesize a default `nextAction`
when the Hub did not supply one. The Hub's value still wins when present.

| Error | Subcause | Default `nextAction.type` |
|---|---|---|
| `X402PaymentInvalidError` | `signature_invalid` | `check_signer` |
| `X402PaymentInvalidError` | other | `resign` |
| `X402NotAcceptedError` | — | `switch_to_wallet` |
| `X402SettlementTimeoutError` | — | `retry_after` |
| `X402FacilitatorUnreachableError` | `*_pin_mismatch` | `upgrade_client` |
| `X402FacilitatorUnreachableError` | other | `retry_after` |
| `X402SettlementReusedError` | — | `resign` |
| `InsufficientPaymentOptionsError` | `signerMissing` | `link_wallet` |
| `InsufficientPaymentOptionsError` | `capabilityRejectedX402` | `switch_to_wallet` |

`NextAction` discriminated union extended with 8 new variants:
`topup_url`, `check_signer`, `resign`, `switch_to_wallet`, `check_gas`,
`raise_cap`, `review_intent`, `link_wallet`. All carry an optional `hint`.

#### `JecpErrorCode` enum
Added 3 SDK-only codes: `X402_AMOUNT_CAP_EXCEEDED`,
`X402_HOURLY_CAP_EXCEEDED`, `X402_GAS_RATIO_EXCEEDED`.

#### Docs + examples
- `docs/x402-quickstart.md` — 4-command path (60s read, 3min to first paid
  invoke). Cites Coinbase Onramp + CDP for wallet funding.
- `examples/05-x402-invoke.ts` — runnable end-to-end x402 invoke with all
  three safety caps configured, full error-class handling.
- README.md x402 section: condensed from 35 lines of boilerplate to a
  10-line example using `walletFromEnv()`.

### Build
- `tsup --external ethers` keeps ethers out of the SDK bundle (was inlining
  to 1.23 MB; now 14 KB ESM / 71 KB CJS as before).

### Tests
- `test/x402-safety-caps.test.ts` — 20 cases: cap arithmetic, signer-not-called
  on rejection, rolling window GC, ledger-only-on-success, gas estimate
  source preference, `nextAction` synthesis on all 5 wire errors +
  `InsufficientPaymentOptionsError`.
- `test/x402-signer-env.test.ts` — 12 cases: env-var validation, malformed
  key rejection, no key leakage in error messages, default env-var name,
  ethers-installed happy path (deterministic Hardhat addr + signature).
- Total suite: 172/172 PASS (was 140) with ethers installed; 168/168 with
  ethers absent (4 signing tests gracefully skipped via `it.skip` + early
  return).

### Behavior unchanged
- Wallet path: zero behavior change.
- mode='auto' without caps: zero behavior change.
- mode='x402' without caps: zero behavior change.
- mode='wallet': always ignores caps (they only apply on the x402 path).
- Failed settlements (4xx/5xx after X-Payment retry) do NOT advance the
  hourly ledger — only confirmed 200 OK settlements count.

### Versioning
- 0.8.0 → 0.8.2 (skipping 0.8.1, which was reserved for the X-Payment-Response
  spec-canonical-keys wire fix that already landed in audit-A close).

## [0.8.0] - 2026-05-11

Aligns with `jecp-spec` v1.1.0 (x402 integration). Backward-compatible —
all additions are additive; the wallet path is unchanged.

Cites the **x402 Integration Locked Design v1.1.1** (`docs/jecp/x402-integration-locked-design.md`)
§3 (Wire format), §6.1 (Agent UX), §6.3 (Developer UX). Agents now have two
payment rails on `/v1/invoke`:
- `wallet`: Stripe top-up (existing path, unchanged)
- `x402`: USDC on Base via EIP-3009 + JECP Splitter contract — agent-native,
  no human top-up, on-chain 85/10/5 single-block atomic revenue split

The SDK never holds private keys. A `Signer` adapter (your `ethers.Wallet`,
`viem` WalletClient, AWS KMS, etc.) handles the EIP-712 typed-data signing;
the SDK assembles the X402 v1 PaymentPayload and the `X-Payment` header.

### Added

#### Client surface

- `JecpClientOptions.payment` — new optional config:
  ```typescript
  new JecpClient({
    agentId, apiKey,
    payment: {
      mode: 'auto',                 // 'wallet' | 'x402' | 'auto' (default 'auto')
      signer: myEthersWallet,       // any Signer-conforming adapter
      facilitatorTimeoutMs: 30_000, // tighter timeout for x402 retry
    },
  });
  ```
- `JecpClient.invoke()` transparently handles 402 → X-Payment retry when
  mode allows. Idempotency: same `X-Request-Id` on both attempts.
- `JecpClient.estimateCost(capabilityId)` — Promise<CostEstimate> with
  `{ usd, usdc, gasEstimateUsd }`. Pulls from catalog manifest.
- `InvokeResult.payment?: X402Receipt` — populated on successful x402 path
  with `{ method, txHash, networkId, amount_usd, amount_usdc }` (parsed from
  the `X-Payment-Response` header).

#### Types

- `PaymentMode` (`'wallet' | 'x402' | 'auto'`)
- `PaymentMethod` (`'wallet' | 'x402'`)
- `PaymentConfig`, `Signer`, `EIP3009AuthorizationParams`
- `PaymentRequirement` (= `StripeWalletRequirement | X402ExactRequirement`)
- `PaymentChallenge`, `X402PaymentPayload`, `X402PaymentResponse`
- `X402Receipt`, `CostEstimate`

#### Error classes (5 wire + 1 SDK-composite per Locked Design §3.5 + §6.3)

- `X402PaymentInvalidError` (HTTP 422) — facilitator rejected payload;
  `subcause` ∈ {signature_invalid, amount_mismatch, nonce_reused, expired}
- `X402NotAcceptedError` (HTTP 422) — capability is wallet-only
- `X402SettlementTimeoutError` (HTTP 504) — retryable
- `X402FacilitatorUnreachableError` (HTTP 502) — retryable for transport
  transients; non-retryable for cert/signature pin mismatches
- `X402SettlementReusedError` (HTTP 409) — tx_hash or nonce replay
- `InsufficientPaymentOptionsError` — SDK composite; thrown when mode='x402'
  but the 402 had no x402 entry, or when no signer is configured and no
  wallet path is viable

All carry `subcause` accessor + `retryable` boolean. `JecpErrorCode` enum
extended with the 5 new wire codes + `INSUFFICIENT_PAYMENT_OPTIONS`.

#### x402 helpers (low-level, exported from root)

- `buildX402Payload(req, signer)` — signs via Signer + assembles X402 v1
  payload
- `buildEIP3009Params(req, from, nowSec?)` — pure constructor (no I/O)
- `encodeXPaymentHeader(payload)` — base64 + 8KB cap enforcement
- `decodeXPaymentResponseHeader(value)` — parse `X-Payment-Response`
- `findX402Requirement(accepts)` — find the `scheme:'exact'` entry
- `networkToChainId('base'|'base-sepolia')` — 8453 / 84532
- `freshNonce()` — 32-byte cryptographic random for EIP-3009 nonce
- `packSignature(v, r, s)` — concatenate to 65-byte hex (normalizes v=0/1→27/28)

### Behavior

- **Mode='auto' (default)**: on 402, if a Signer is set AND the 402's
  `accepts[]` includes an x402 entry, SDK signs + retries with X-Payment.
  Otherwise propagates the original 402 as a typed JecpError carrying
  `next_action: { type: 'topup' }` so the caller can drive Stripe Checkout.
- **Mode='wallet'**: never attempts x402, even when 402 advertises it.
  Identical to pre-0.8.0 behavior.
- **Mode='x402'**: constructor throws if no signer; SDK refuses to fall
  back to wallet (intentional — caller wants strict x402).
- **Idempotency**: `X-Request-Id` (= JECP `body.id`) is preserved between
  the initial 402 and the X-Payment retry. The Hub's idempotency cache
  treats them as one logical request.
- **Wallet path unchanged**: agents not opting into payment config see
  zero behavior change. v0.7.x code keeps working.

### Tests

- `test/x402.test.ts` — 19 cases: helper unit tests (encoder, signature
  packing, nonce generation, network mapping), constructor validation,
  auto-mode happy path with receipt assertion, wallet-only mode safety,
  x402-only mode + composite error, 422 error parsing, estimateCost path.
- Total suite: 139/139 PASS (was 120).

### Out of scope (deferred to v0.9 / v1.0)

- Auto-fallback from x402 failure → wallet top-up flow (locked design §6.1
  notes this requires UX coordination with the caller; v0.8 surfaces
  typed errors instead)
- Auto-retry on `X402_SETTLEMENT_TIMEOUT` (would need fresh nonce + re-sign)
- Coinbase Onramp helper (`@jecpdev/sdk/x402/onramp`) — locked design
  §6.1 / Panel 4 §A.4 (deferred; planned for v0.8.1)
- Hub-side x402 implementation lands separately (jecp-spec v1.1.0 + Hub
  Fly v##)

## [0.7.2] - 2026-05-11

Aligns with `jecp-spec` v1.1.0 (Phase 1, Composite SSRF defense). Backward-
compatible — adds one new error class + one enum constant.

Cites ADR-0002 (`jecp-spec/adr/0002-ssrf-defense-architecture.md`): the
Hub's 5-layer outbound URL pipeline (parse / scheme / host normalization /
DNS resolve / IP pin). The Hub now refuses to dereference Agent-controlled
URLs that hit the JECP deny-list (loopback / link-local / RFC 1918 / RFC
4193 / IPv4-mapped IPv6 / `0.0.0.0/8`) — including hostnames that resolve
into deny ranges.

### Added
- `JecpErrorCode.URL_BLOCKED_SSRF` constant for type-safe code comparison.
- `UrlBlockedSsrfError` class (HTTP 422) with `field` / `blockedUrl` /
  `reason` accessors. The `reason` enum is documented at
  `https://jecp.dev/errors/url_blocked_ssrf` and includes:
  `parse_error`, `scheme`, `host_syntax`, `resolved_to_deny_cidr`,
  `dns_resolve_failed`, `connect_pin_violation`.

### Behavior
- For asynchronous deref paths (webhook delivery), Hubs do not return this
  error envelope to the caller — the originating subscribe call already
  returned 200. Hubs mark the outbox row abandoned with
  `last_error = "SSRF_DENIED: <reason>"` and stop retrying. Subscribers
  observing missing webhook deliveries should check Hub-side audit
  dashboards for `URL_BLOCKED_SSRF` entries.

### Tests
- 4 cases in `test/errors-v1.0.2.test.ts` (factory dispatch + every
  documented subcause + missing-details graceful).
- Total suite: 120/120 PASS (was 116).

## [0.7.1] - 2026-05-10

Aligns with `jecp-spec` v1.0.2 (Phase 0 errata: K1 endpoint reconciliation +
K2 wire-format MUSTs + K3 bulkhead + K4 discovery). Backward-compatible —
all additions are additive.

Cites ADR-0001 (`jecp-spec/adr/0001-idempotency-provenance-interaction.md`):
the Hub's idempotency cache key MUST include `mandate.provenance_hash`.
SDK consumers seeing 409 `DUPLICATE_REQUEST` unexpectedly should check
that the same `request_id` is not being reused under two distinct mandates
(typical cause: rotated keys with the same prepared request).

### Added
- `JecpErrorCode` constants object (string-literal type) for type-safe
  comparisons: `if (err.code === JecpErrorCode.RATE_LIMITED) {…}`.
  Exports all v1.0.2 codes including the 5 new K2 errors.
- `JecpError.details` field — structured `error.details` from the wire
  envelope (per spec 03-errors §3.2). Replaces the need to dip into
  `err.raw` for documentation URLs / retry hints / sunset metadata.
- `JecpError.documentationUrl` getter — returns `details.documentation_url`
  when the Hub supplied one (all v1.0.2 errors do).
- `UnsupportedMediaTypeError` (HTTP 415, K2.1) with
  `receivedContentType` / `expectedContentType` accessors.
- `DuplicateRequestError` (HTTP 409, K2.2) — see ADR-0001 cite above
  for cache-key semantics under Provenance v2.
- `CapabilityDeprecatedError` (HTTP 410, K2.3) with `sunsetAt` and
  `successorVersion` accessors. Mirrors RFC 8594 `Sunset` / `Deprecation`
  / `Link` response headers into typed fields.
- `InputSchemaViolationError` (HTTP 400, K2.5) with `errors: InputSchemaViolation[]`
  accessor. Filters malformed entries from arbitrary servers.
- `InputSchemaViolation` interface ({ instance_path, schema_path, reason }).
- `RateLimitError.retryAfterSeconds` getter (HTTP 429 + Retry-After, K2.4).
  Reads from `details.retry_after_seconds` set by the Hub to mirror the
  HTTP `Retry-After` header into the JECP envelope.

### Tests
- `test/errors-v1.0.2.test.ts` — 12 cases covering every K2 subclass:
  factory dispatch, accessor read paths, malformed-input resilience.
- Total suite: 116/116 PASS (was 104).

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
