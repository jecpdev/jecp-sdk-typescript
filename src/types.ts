/**
 * JECP type definitions — JSON shapes for the Joint Execution & Commerce Protocol.
 * Spec: https://github.com/jecpdev/jecp-spec
 */

import type { Logger } from './logger.js';
import type { RetryConfig } from './retry.js';
import type { PaymentConfig } from './x402/types.js';

// ─── Mandate (Spec §4) ───────────────────────────────────────

export interface Mandate {
  agent_id: string;
  api_key: string;
  /** Optional budget cap in USDC. If set, calls exceeding this fail with 402. */
  budget_usdc?: number;
  /** ISO 8601 expiry. Mandate ignored / rejected after this time. */
  expires_at?: string;
  /** Optional provenance hash for identity proof. */
  provenance_hash?: string;
}

// ─── Invoke ──────────────────────────────────────────────────

export interface InvokeRequest {
  jecp: '1.0';
  id: string;
  capability: string; // "namespace/capability"
  action: string;
  input: unknown;
  mandate?: Mandate;
}

export interface BillingSummary {
  charged: boolean;
  amount_usdc: number;
  transaction_id?: string;
  balance_after?: number;
  provider_share_usdc?: number;
  hub_fee_usdc?: number;
  payment_fee_usdc?: number;
}

export interface ProviderRef {
  namespace: string;
  capability: string;
  version: string;
}

export interface InvokeSuccess<T = unknown> {
  jecp: '1.0';
  id: string;
  status: 'success';
  result: T;
  provider: ProviderRef;
  billing: BillingSummary;
  wallet_balance_after?: number;
}

export interface JecpErrorBody {
  jecp: '1.0';
  status: 'failed';
  error: { code: string; message: string };
  next_action?: NextAction;
}

// ─── next_action (Spec §6 — machine-readable error recovery) ──

export type NextAction =
  | { type: 'topup';                 ui?: string; api?: string; hint?: string }
  | { type: 'register';              ui?: string; api?: string; hint?: string }
  | { type: 'increase_mandate';      hint?: string }
  | { type: 'refresh_mandate';       hint?: string }
  | { type: 'retry_after';           hint?: string }
  | { type: 'discover';              api?: string; hint?: string }
  | { type: 'see_manifest';          api?: string; hint?: string }
  | { type: 'earn_trust';            hint?: string }
  | { type: 'try_alternative_provider'; api?: string; hint?: string }
  | { type: 'upgrade_client';        spec?: string; hint?: string }
  // v0.8.2 — H-4.4 x402 error enrichment (audit-D §A.3 P0-3).
  // These map directly onto SDK-side recovery in `examples/05-x402-invoke.ts`.
  | { type: 'topup_url';             url: string; hint?: string }
  | { type: 'check_signer';          hint?: string }
  | { type: 'resign';                hint?: string }
  | { type: 'switch_to_wallet';      hint?: string }
  | { type: 'check_gas';             hint?: string }
  | { type: 'raise_cap';             hint?: string }
  | { type: 'review_intent';         hint?: string }
  | { type: 'link_wallet';           hint?: string };

// ─── Catalog ─────────────────────────────────────────────────

export interface CapabilityCatalogItem {
  id: string;
  namespace: string;
  name?: string;
  version: string;
  description?: string;
  tags?: string[];
  total_calls?: number;
  source?: 'core' | 'third_party';
  manifest?: ManifestData;
}

export interface ManifestData {
  namespace: string;
  capability: string;
  version: string;
  description: string;
  endpoint: string;
  actions: ManifestAction[];
  tags?: string[];
}

export interface ManifestAction {
  id: string;
  name?: string;
  description: string;
  pricing: { base: string | number; currency?: string; model?: string };
  rate_limit_rpm?: number;
  trust_tier_required?: 'bronze' | 'silver' | 'gold' | 'platinum';
  input_schema?: unknown;
  output_schema?: unknown;
  examples?: unknown[];
}

export interface CatalogResponse {
  jecp: string;
  engine: string;
  capabilities: unknown[];
  third_party_capabilities?: CapabilityCatalogItem[];
  third_party_count?: number;
  /** Cursor for the next page (W3). null/undefined when there are no more pages. */
  next_cursor?: string | null;
  /** True if more pages exist (W3). */
  has_more?: boolean;
  /** Page size used for this response (W3). */
  page_size?: number;
  /** True if the server returned this in paginated mode (W3). */
  paginated?: boolean;
}

export interface CatalogQueryOptions {
  /** Cursor from a prior page's `next_cursor`. */
  cursor?: string;
  /** Items per page, server clamps to [1, 200]. Default 50. */
  pageSize?: number;
  /** Optional namespace filter (e.g. 'jobdonebot'). */
  namespace?: string;
  /** Optional tag filter (must match at least one). */
  tags?: string[];
  /** AbortSignal for cancellation. */
  signal?: AbortSignal;
  /** Override timeout for this call. */
  timeoutMs?: number;
}

// ─── Agent registration & topup ─────────────────────────────

export interface AgentRegisterRequest {
  name: string;
  agent_type?: string;
  description?: string;
  capabilities?: string[];
  homepage?: string;
  referred_by?: string;
}

export interface AgentRegisterResponse {
  agent_id: string;
  api_key: string;
  name: string;
  free_calls_remaining: number;
  endpoints?: Record<string, string>;
  spread_the_word?: unknown;
}

export interface TopupRequest {
  amount: 5 | 20 | 100;
  returnTo?: string;
}

export interface TopupResponse {
  url: string;
  sessionId: string;
}

// ─── SDK options ─────────────────────────────────────────────

export interface JecpClientOptions {
  agentId: string;
  apiKey: string;
  /** Defaults to https://jecp.dev */
  baseUrl?: string;
  /** Default request timeout in ms (default: 30000). */
  timeoutMs?: number;
  /** Override default retry policy (auto-retry on 5xx/408/429/network errors). */
  retryConfig?: Partial<RetryConfig>;
  /** Optional logger for retry/timeout/error visibility. Default: no-op. */
  logger?: Logger;
  /** Custom fetch impl (e.g. for testing). */
  fetch?: typeof fetch;
  /**
   * x402 payment configuration (v0.8.0). When provided with a `Signer`,
   * the SDK transparently handles HTTP 402 by signing an EIP-3009
   * authorization and re-issuing the call with `X-Payment` header.
   * Locked design §6.1.
   */
  payment?: PaymentConfig;
}

export interface InvokeOptions {
  /** Pre-authorized budget cap. Use object form to specify only budget_usdc + expires_at. */
  mandate?: Mandate | { budget_usdc: number; expires_at?: string };
  /** Override request id (default: auto-generated UUID v4). */
  requestId?: string;
  /** AbortController signal — cancel mid-flight, also stops retries. */
  signal?: AbortSignal;
  /** Override the client's default timeout for this call only. */
  timeoutMs?: number;
}

// ─── v0.9.0 Provider lifecycle (JecpProviderClient) ──────────
//
// Wire shapes for POST /v1/providers/register, GET /v1/providers/me,
// POST /v1/providers/verify-dns, POST /v1/manifests, POST
// /v1/providers/me/rotate-key, POST /v1/providers/connect-stripe.
// Naming and field set MUST stay in lock-step with the Hub handler
// (jecp-hub/setsuna-jobdonebot) and the canonical CLI implementation.

/**
 * Provider registration request body. Mirrors
 * POST /v1/providers/register in the Hub.
 *
 * `namespace` is the globally-unique identifier owned by this Provider
 * after registration. It must match `^[a-z][a-z0-9-]{2,31}$` (3-32 chars,
 * lowercase + digits + hyphens, starts with a letter).
 *
 * `country` is an ISO 3166-1 alpha-2 code; the Hub uppercases it before
 * forwarding to Stripe Connect, but the SDK helper does the uppercase too
 * so a `Bad Request` doesn't surface for trivial casing mistakes.
 */
export interface ProviderRegisterRequest {
  namespace: string;
  display_name: string;
  owner_email: string;
  endpoint_url: string;
  /** ISO 3166-1 alpha-2 country code. SDK uppercases. */
  country: string;
  /** Optional marketing/product page. */
  website?: string;
  /**
   * Optional Base USDC payout address (0x + 40 hex). SDK lowercases.
   * Required only if the Provider opts into x402 settlement.
   */
  usdc_payout_address?: string;
}

/**
 * Response from POST /v1/providers/register.
 *
 * `provider_api_key` and `hmac_secret` are shown only ONCE — persist them
 * immediately. The api_key authenticates subsequent Provider admin calls
 * (verify-dns, publish, rotate-key, etc.); the hmac_secret signs inbound
 * Hub→Provider forwards.
 *
 * `dns_verification_token` is the value to place in a TXT record at
 * `_jecp.<endpoint_url host>` to prove ownership of the endpoint domain.
 */
export interface ProviderRegisterResponse {
  provider_id: string;
  namespace: string;
  provider_api_key: string;
  hmac_secret: string;
  dns_verification_token: string;
  /** Hub-supplied hints (DNS record name/value, next-step commands). */
  next_steps: Record<string, unknown>;
}

/**
 * Response from GET /v1/providers/me — full status of the calling Provider.
 *
 * `status` is the Hub-wide gating signal: typically `submitted` after
 * register, `verified` after DNS + Stripe both pass. Treat any value other
 * than `verified` as "manifests will be `submitted` not `active`".
 */
export interface ProviderMe {
  provider_id: string;
  namespace: string;
  display_name: string;
  status: string;
  dns_verified: boolean;
  stripe_verified: boolean;
  endpoint_url?: string;
  total_calls: number;
}

/**
 * Response from POST /v1/providers/verify-dns.
 *
 * `verified=true` indicates the Hub's resolver confirmed the
 * `_jecp.<host>` TXT record matches the registration token. On failure,
 * `status` carries the Hub's short code (e.g. `pending`, `txt_missing`,
 * `txt_mismatch`) and `message` carries the human-readable detail.
 */
export interface VerifyDnsResponse {
  verified: boolean;
  status: string;
  message: string;
}

/**
 * Response from POST /v1/manifests (publish).
 *
 * `status` is `active` when the manifest is fully verified and live in the
 * catalog, otherwise `submitted` (waiting on DNS or Stripe verification).
 * `validation_warnings` are non-fatal lint findings emitted by the Hub —
 * the publish succeeded.
 */
export interface PublishResponse {
  capability_id: string;
  full_id: string;
  version: string;
  status: string;
  action_count: number;
  validation_warnings: string[];
}

/**
 * Response from POST /v1/providers/me/rotate-key.
 *
 * `api_key` is the new key, shown only once — the SDK does NOT persist it
 * anywhere. Callers MUST write it to their secret store immediately.
 *
 * `previous_key_valid_until` is the RFC 3339 timestamp at which the old
 * key stops being accepted; `null` indicates the old key was revoked
 * immediately (`revoke_old=true`).
 *
 * `rotations_in_last_24h` is informational — the Hub returns
 * `ROTATION_24H_CAP` (HTTP 429 → `RotationCapError`) when the cap is hit.
 */
export interface RotateKeyResponse {
  jecp: '1.0';
  provider_id: string;
  namespace: string;
  api_key: string;
  api_key_prefix: string;
  previous_key_valid_until: string | null;
  grace_seconds: number;
  revoke_old: boolean;
  rotations_in_last_24h: number;
  warning: string;
}

/**
 * Response from POST /v1/providers/connect-stripe.
 *
 * Open `onboarding_url` in a browser to complete Stripe Connect Express
 * onboarding (verify identity, accept ToS, link a payout bank). `expires_at`
 * is a Unix timestamp; Stripe typically scopes Account Links to ~5 minutes.
 */
export interface ConnectStripeResponse {
  onboarding_url: string;
  expires_at: number;
}
