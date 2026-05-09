# Changelog

All notable changes to `@jecpdev/sdk` are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-05-08

Initial public release.

### Added

- `JecpClient` — agent client
  - `invoke<T>(capability, action, input, options?)` with typed result
  - `catalog()` to list live capabilities
  - `topup(amount)` to mint Stripe Checkout URLs
  - `shareKit()` to fetch the auth'd referral kit
  - Static `JecpClient.register(...)` for first-time agent registration
  - Static `JecpClient.agentGuide(...)` to fetch `/.well-known/agent-guide.json`
- `JecpProvider` — Provider helper
  - `verifySignature({ signature, timestamp, body })` with HMAC-SHA256 + ±5min replay window
  - `createHandler(processFn)` returning a fetch-API `(Request) => Promise<Response>` compatible with Bun, Cloudflare Workers, and Next.js Route Handlers
- 9 typed error classes derived from server response codes:
  `InsufficientBalanceError`, `InsufficientBudgetError`, `MandateExpiredError`,
  `AuthError`, `RateLimitError`, `CapabilityNotFoundError`, `ActionNotFoundError`,
  `InsufficientTrustError`, `ProviderError`. All carry `.code`, `.status`, `.nextAction`, `.raw`.
- Discriminated union for `NextAction` enabling typed branching on `e.nextAction?.type`.
- Mandate normalization: passing `{ budget_usdc: 5.0 }` automatically merges the agent's credentials.
- 13 unit tests (vitest) covering both client and provider paths.
- Apache 2.0 license.
- Dual CJS + ESM build via tsup; full TypeScript declarations.

### Notes

- Built and tested on Node ≥18. Browser-only environments are not supported in 0.1 (`JecpProvider` uses `node:crypto`); a webcrypto fork is planned for 0.2.
- Default base URL: `https://jecp.dev`. Override via `new JecpClient({ baseUrl })` for self-hosted Hubs.
