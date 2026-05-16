/**
 * JECP error classes — typed exceptions with next_action metadata for auto-recovery.
 *
 * v1.0.2 alignment (SDK 0.7.1): error code constants + 4 new wire-format
 * error subclasses (415 / 409 / 410 / 400 INPUT_SCHEMA_VIOLATION) +
 * RateLimitError.retryAfterSeconds accessor for K2.4.
 *
 * See ADR-0001 (idempotency-provenance-interaction.md): the Hub's idempotency
 * cache key MUST include mandate.provenance_hash. Same `(agent_id, request_id)`
 * with different provenance_hash hits a different cache slot — clients
 * observing 409 DUPLICATE_REQUEST without an obvious replay are likely
 * sending two distinct mandates under one id.
 */

import type { NextAction } from './types.js';

/**
 * Canonical JECP error codes (v1.0.2). Use these constants for type-safe
 * comparisons: `if (err.code === JecpErrorCode.RATE_LIMITED) {...}`.
 *
 * Spec: 03-errors.md.
 */
export const JecpErrorCode = {
  // Auth / billing
  AUTH_REQUIRED:           'AUTH_REQUIRED',
  INVALID_AGENT:           'INVALID_AGENT',
  INSUFFICIENT_BALANCE:    'INSUFFICIENT_BALANCE',
  INSUFFICIENT_BUDGET:     'INSUFFICIENT_BUDGET',
  MANDATE_EXPIRED:         'MANDATE_EXPIRED',
  INSUFFICIENT_TRUST:      'INSUFFICIENT_TRUST',

  // Resolution
  CAPABILITY_NOT_FOUND:    'CAPABILITY_NOT_FOUND',
  ACTION_NOT_FOUND:        'ACTION_NOT_FOUND',
  CAPABILITY_DEPRECATED:   'CAPABILITY_DEPRECATED',     // v1.0.2 K2.3 (HTTP 410)

  // Wire format
  UNSUPPORTED_MEDIA_TYPE:  'UNSUPPORTED_MEDIA_TYPE',     // v1.0.2 K2.1 (HTTP 415)
  DUPLICATE_REQUEST:       'DUPLICATE_REQUEST',          // v1.0.2 K2.2 (HTTP 409)
  INPUT_SCHEMA_VIOLATION:  'INPUT_SCHEMA_VIOLATION',     // v1.0.2 K2.5 (HTTP 400)
  INVALID_REQUEST:         'INVALID_REQUEST',
  INVALID_CAPABILITY:      'INVALID_CAPABILITY',

  // Throttling
  RATE_LIMITED:            'RATE_LIMITED',               // v1.0.2 K2.4 (HTTP 429 + Retry-After)

  // Provider
  PROVIDER_UNREACHABLE:    'PROVIDER_UNREACHABLE',
  PROVIDER_ERROR:          'PROVIDER_ERROR',

  // Security
  URL_BLOCKED_SSRF:        'URL_BLOCKED_SSRF',           // v1.1.0 c10 (HTTP 422)

  // x402 integration (v1.1.0, Locked Design §3.5 — 5 codes)
  X402_PAYMENT_INVALID:        'X402_PAYMENT_INVALID',        // 422 — facilitator rejected payload
  X402_NOT_ACCEPTED:           'X402_NOT_ACCEPTED',           // 422 — capability is wallet-only
  X402_SETTLEMENT_TIMEOUT:     'X402_SETTLEMENT_TIMEOUT',     // 504 — facilitator slow / chain congested
  X402_FACILITATOR_UNREACHABLE:'X402_FACILITATOR_UNREACHABLE',// 502 — DNS / cert pin / signature pin
  X402_SETTLEMENT_REUSED:      'X402_SETTLEMENT_REUSED',      // 409 — tx_hash or nonce replay

  // SDK-side composite (no wire equivalent)
  INSUFFICIENT_PAYMENT_OPTIONS:'INSUFFICIENT_PAYMENT_OPTIONS',// 402 — neither wallet nor x402 path viable

  // v0.8.2 — H-6 SDK safety caps (Panel 4 §A.3 + Audit B cross-finding).
  // These are agent-side defense-in-depth — never sent over the wire.
  X402_AMOUNT_CAP_EXCEEDED: 'X402_AMOUNT_CAP_EXCEEDED',
  X402_HOURLY_CAP_EXCEEDED: 'X402_HOURLY_CAP_EXCEEDED',
  X402_GAS_RATIO_EXCEEDED:  'X402_GAS_RATIO_EXCEEDED',

  // Internal
  INTERNAL:                'INTERNAL',
} as const;

export type JecpErrorCodeValue = typeof JecpErrorCode[keyof typeof JecpErrorCode];

export class JecpError extends Error {
  public readonly code: string;
  public readonly status: number;
  public readonly nextAction?: NextAction;
  public readonly raw?: unknown;

  /**
   * Structured error details from the wire envelope's `error.details` field.
   * v1.0.2 errors populate this with: retry_after_seconds (RATE_LIMITED),
   * sunset_at + successor_version (CAPABILITY_DEPRECATED), errors[]
   * (INPUT_SCHEMA_VIOLATION), received + expected (UNSUPPORTED_MEDIA_TYPE),
   * documentation_url (all v1.0.2 errors).
   */
  public readonly details?: Record<string, unknown>;

  constructor(opts: {
    code: string;
    message: string;
    status: number;
    nextAction?: NextAction;
    raw?: unknown;
    details?: Record<string, unknown>;
  }) {
    super(opts.message);
    this.name = 'JecpError';
    this.code = opts.code;
    this.status = opts.status;
    this.nextAction = opts.nextAction;
    this.raw = opts.raw;
    this.details = opts.details;
  }

  /**
   * The canonical documentation URL for this error code (v1.0.2 errors only).
   * `undefined` for older errors.
   */
  get documentationUrl(): string | undefined {
    const v = this.details?.['documentation_url'];
    return typeof v === 'string' ? v : undefined;
  }

  /**
   * Factory: build the most specific subclass for a given error code.
   * Falls back to plain JecpError for unknown codes.
   */
  static fromBody(body: {
    error?: { code?: string; message?: string; details?: Record<string, unknown> };
    next_action?: NextAction;
  }, status: number): JecpError {
    const code = body.error?.code ?? 'UNKNOWN';
    const message = body.error?.message ?? 'Unknown error';
    const nextAction = body.next_action;
    const details = body.error?.details;
    const opts = { code, message, status, nextAction, raw: body, details };

    switch (code) {
      case 'INSUFFICIENT_BALANCE':
        return new InsufficientBalanceError(opts);
      case 'INSUFFICIENT_BUDGET':
        return new InsufficientBudgetError(opts);
      case 'MANDATE_EXPIRED':
        return new MandateExpiredError(opts);
      case 'AUTH_REQUIRED':
      case 'INVALID_AGENT':
      // v0.9.0 — Provider-side auth failure codes (provider-client surface).
      // Same recovery path as the agent-side auth errors: caller must rotate
      // or re-fetch the credential.
      case 'INVALID_API_KEY':
      case 'INVALID_PROVIDER':
        return new AuthError(opts);
      case 'RATE_LIMITED':
        return new RateLimitError(opts);
      case 'CAPABILITY_NOT_FOUND':
        return new CapabilityNotFoundError(opts);
      case 'ACTION_NOT_FOUND':
        return new ActionNotFoundError(opts);
      case 'INSUFFICIENT_TRUST':
        return new InsufficientTrustError(opts);
      case 'PROVIDER_UNREACHABLE':
      case 'PROVIDER_ERROR':
        return new ProviderError(opts);

      // v1.0.2 K2.1
      case 'UNSUPPORTED_MEDIA_TYPE':
        return new UnsupportedMediaTypeError(opts);
      // v1.0.2 K2.2 — see ADR-0001 for cache-key semantics with provenance_hash.
      case 'DUPLICATE_REQUEST':
        return new DuplicateRequestError(opts);
      // v1.0.2 K2.3
      case 'CAPABILITY_DEPRECATED':
        return new CapabilityDeprecatedError(opts);
      // v1.0.2 K2.5
      case 'INPUT_SCHEMA_VIOLATION':
        return new InputSchemaViolationError(opts);

      // v1.1.0 c10 — composite SSRF defense (spec §9.7.1, ADR-0002)
      case 'URL_BLOCKED_SSRF':
        return new UrlBlockedSsrfError(opts);

      // v0.9.0 Provider lifecycle (register / publish / rotate-key)
      case 'NAMESPACE_TAKEN':
        return new NamespaceTakenError(opts);
      case 'UNSUPPORTED_COUNTRY':
        return new UnsupportedCountryError(opts);
      case 'ROTATION_24H_CAP':
        return new RotationCapError(opts);
      case 'PARSE_ERROR':
        return new ManifestParseError(opts);
      case 'VERSION_EXISTS':
        return new ManifestVersionExistsError(opts);

      // v1.1.0 x402 — locked design §3.5
      // H-4.4: enrich with default nextAction when Hub didn't supply one.
      case 'X402_PAYMENT_INVALID':
        return new X402PaymentInvalidError(applyDefaultX402NextAction(opts));
      case 'X402_NOT_ACCEPTED':
        return new X402NotAcceptedError(applyDefaultX402NextAction(opts));
      case 'X402_SETTLEMENT_TIMEOUT':
        return new X402SettlementTimeoutError(applyDefaultX402NextAction(opts));
      case 'X402_FACILITATOR_UNREACHABLE':
        return new X402FacilitatorUnreachableError(applyDefaultX402NextAction(opts));
      case 'X402_SETTLEMENT_REUSED':
        return new X402SettlementReusedError(applyDefaultX402NextAction(opts));

      default:
        return new JecpError(opts);
    }
  }
}

export class InsufficientBalanceError extends JecpError {
  constructor(opts: ConstructorParameters<typeof JecpError>[0]) {
    super(opts);
    this.name = 'InsufficientBalanceError';
  }
}
export class InsufficientBudgetError extends JecpError {
  constructor(opts: ConstructorParameters<typeof JecpError>[0]) {
    super(opts);
    this.name = 'InsufficientBudgetError';
  }
}
export class MandateExpiredError extends JecpError {
  constructor(opts: ConstructorParameters<typeof JecpError>[0]) {
    super(opts);
    this.name = 'MandateExpiredError';
  }
}
export class AuthError extends JecpError {
  constructor(opts: ConstructorParameters<typeof JecpError>[0]) {
    super(opts);
    this.name = 'AuthError';
  }
}
export class RateLimitError extends JecpError {
  constructor(opts: ConstructorParameters<typeof JecpError>[0]) {
    super(opts);
    this.name = 'RateLimitError';
  }

  /**
   * v1.0.2 K2.4: server-recommended retry delay in seconds, mirrored from
   * the `Retry-After` HTTP header into `error.details.retry_after_seconds`.
   * Returns `undefined` if the server didn't include it (older Hubs).
   *
   * Spec: 03-errors §RATE_LIMITED + RFC 9110 §10.2.3.
   */
  get retryAfterSeconds(): number | undefined {
    const v = this.details?.['retry_after_seconds'];
    return typeof v === 'number' ? v : undefined;
  }
}
export class CapabilityNotFoundError extends JecpError {
  constructor(opts: ConstructorParameters<typeof JecpError>[0]) {
    super(opts);
    this.name = 'CapabilityNotFoundError';
  }
}
export class ActionNotFoundError extends JecpError {
  constructor(opts: ConstructorParameters<typeof JecpError>[0]) {
    super(opts);
    this.name = 'ActionNotFoundError';
  }
}
export class InsufficientTrustError extends JecpError {
  constructor(opts: ConstructorParameters<typeof JecpError>[0]) {
    super(opts);
    this.name = 'InsufficientTrustError';
  }
}
export class ProviderError extends JecpError {
  constructor(opts: ConstructorParameters<typeof JecpError>[0]) {
    super(opts);
    this.name = 'ProviderError';
  }
}

/**
 * v1.0.2 K2.1 — HTTP 415: the Hub rejected the request because
 * `Content-Type` was not `application/json` (or compatible).
 *
 * Spec: 01-protocol §2 + 03-errors §UNSUPPORTED_MEDIA_TYPE.
 */
export class UnsupportedMediaTypeError extends JecpError {
  constructor(opts: ConstructorParameters<typeof JecpError>[0]) {
    super(opts);
    this.name = 'UnsupportedMediaTypeError';
  }

  /** The Content-Type the Hub actually saw (echoed back for diagnostics). */
  get receivedContentType(): string | undefined {
    const v = this.details?.['received'];
    return typeof v === 'string' ? v : undefined;
  }

  /** The Content-Type the Hub expects (always `application/json`). */
  get expectedContentType(): string | undefined {
    const v = this.details?.['expected'];
    return typeof v === 'string' ? v : undefined;
  }
}

/**
 * v1.0.2 K2.2 — HTTP 409: the Hub saw a previous request with the same
 * `(agent_id, request_id)` but DIFFERENT payload (capability / action /
 * input / mandate.provenance_hash). This is NOT an idempotency hit —
 * those return a cached success response.
 *
 * Per ADR-0001 (idempotency-provenance-interaction.md), the Hub's
 * idempotency cache key includes `mandate.provenance_hash`. If a client
 * sees this error unexpectedly, two distinct mandates were sent under one
 * request_id — fix the caller to either reuse the mandate or generate a
 * fresh request_id.
 *
 * Spec: 03-errors §DUPLICATE_REQUEST + RFC 9110 §15.5.10.
 */
export class DuplicateRequestError extends JecpError {
  constructor(opts: ConstructorParameters<typeof JecpError>[0]) {
    super(opts);
    this.name = 'DuplicateRequestError';
  }
}

/**
 * v1.0.2 K2.3 — HTTP 410: the requested capability has been sunset.
 * The response carries RFC 8594 `Sunset` / `Deprecation` / `Link` headers,
 * mirrored into `error.details.sunset_at` and `successor_version`.
 *
 * Clients SHOULD migrate to `successorVersion`. The `sunsetAt` field is
 * the timestamp at which the capability stopped accepting invocations
 * (which may be in the past if the client is using a stale catalog).
 *
 * Spec: 01-protocol §4.6 + 03-errors §CAPABILITY_DEPRECATED + RFC 8594.
 */
export class CapabilityDeprecatedError extends JecpError {
  constructor(opts: ConstructorParameters<typeof JecpError>[0]) {
    super(opts);
    this.name = 'CapabilityDeprecatedError';
  }

  /** RFC 3339 timestamp when this capability was (or will be) sunset. */
  get sunsetAt(): string | undefined {
    const v = this.details?.['sunset_at'];
    return typeof v === 'string' ? v : undefined;
  }

  /** Suggested replacement capability (e.g., 'jecp-test/echo'). */
  get successorVersion(): string | undefined {
    const v = this.details?.['successor_version'];
    return typeof v === 'string' ? v : undefined;
  }
}

/**
 * Per-violation entry from a JSON-Schema validation failure.
 * v1.0.2 K2.5.
 */
export interface InputSchemaViolation {
  instance_path: string;
  schema_path:   string;
  reason:        string;
}

/**
 * v1.1.0 c10 — HTTP 422: the Hub refused to dereference an
 * Agent-controlled URL because it hits the JECP SSRF deny-list.
 * The URL itself was structurally well-formed; the Hub blocked it
 * by policy per spec §9.7.1 + ADR-0002.
 *
 * `field` identifies which wire field carried the URL
 *   ('endpoint_url' | 'webhook_destination_url' | 'callback_url').
 * `blockedUrl` is the URL the Hub rejected (with credentials redacted).
 * `reason` ∈ {parse_error, scheme, host_syntax, resolved_to_deny_cidr,
 *             dns_resolve_failed, connect_pin_violation}.
 *
 * For asynchronous deref paths (webhook delivery), the Hub does not
 * return this envelope to the caller — the originating subscribe call
 * already returned 200. Instead, the Hub marks the outbox row abandoned
 * with `last_error = 'SSRF_DENIED: <reason>'` and stops retrying.
 */
export class UrlBlockedSsrfError extends JecpError {
  constructor(opts: ConstructorParameters<typeof JecpError>[0]) {
    super(opts);
    this.name = 'UrlBlockedSsrfError';
  }

  /** Which wire field carried the rejected URL. */
  get field(): string | undefined {
    const v = this.details?.['field'];
    return typeof v === 'string' ? v : undefined;
  }

  /** The rejected URL with credentials redacted by the Hub. */
  get blockedUrl(): string | undefined {
    const v = this.details?.['blocked_url'];
    return typeof v === 'string' ? v : undefined;
  }

  /** Subcause from spec §9.7.1.3. */
  get reason(): string | undefined {
    const v = this.details?.['reason'];
    return typeof v === 'string' ? v : undefined;
  }
}

/**
 * v1.0.2 K2.5 — HTTP 400: the request `input` violated the manifest's
 * `input_schema` for the named action. The wallet was NOT debited
 * (validation runs before pricing on the Hub).
 *
 * Inspect `errors` for per-violation details. Up to 10 violations are
 * enumerated to keep the payload bounded.
 *
 * Spec: 01-protocol §4.5 + 03-errors §INPUT_SCHEMA_VIOLATION.
 */
export class InputSchemaViolationError extends JecpError {
  constructor(opts: ConstructorParameters<typeof JecpError>[0]) {
    super(opts);
    this.name = 'InputSchemaViolationError';
  }

  /** Structured per-violation list (empty array on older / sparse responses). */
  get errors(): InputSchemaViolation[] {
    const v = this.details?.['errors'];
    if (!Array.isArray(v)) return [];
    return v.filter(
      (e): e is InputSchemaViolation =>
        typeof e === 'object' && e !== null &&
        typeof (e as Record<string, unknown>)['instance_path'] === 'string' &&
        typeof (e as Record<string, unknown>)['schema_path'] === 'string' &&
        typeof (e as Record<string, unknown>)['reason'] === 'string'
    );
  }
}

// ─── x402 integration (v1.1.0, Locked Design §3.5 / §6.3) ────────────────
//
// Five wire-format error classes + one SDK-composite for unrecoverable cases.
// All cite spec §3.5 + locked design §3.5 (subcause enumeration).

/**
 * v1.1.0 X402_PAYMENT_INVALID — HTTP 422: the facilitator (x402.org) rejected
 * the X-Payment payload. Non-retryable; fix the signed authorization.
 *
 * `subcause` ∈ { signature_invalid, amount_mismatch, nonce_reused, expired }.
 *
 * Locked design §3.5 + spec/03-error-catalog.md §X402_PAYMENT_INVALID.
 */
export class X402PaymentInvalidError extends JecpError {
  constructor(opts: ConstructorParameters<typeof JecpError>[0]) {
    super(opts);
    this.name = 'X402PaymentInvalidError';
  }

  /** Subcause string (signature_invalid / amount_mismatch / nonce_reused / expired). */
  get subcause(): string | undefined {
    const v = this.details?.['subcause'];
    return typeof v === 'string' ? v : undefined;
  }

  /** Always false — re-signing a fresh authorization is required. */
  get retryable(): false { return false; }
}

/**
 * v1.1.0 X402_NOT_ACCEPTED — HTTP 422: the capability does not advertise
 * x402 in its `payment_methods` list. Switch to mode='wallet' or pick another
 * Provider.
 *
 * `subcause` ∈ { capability_wallet_only, network_unsupported }.
 *
 * Locked design §3.5.
 */
export class X402NotAcceptedError extends JecpError {
  constructor(opts: ConstructorParameters<typeof JecpError>[0]) {
    super(opts);
    this.name = 'X402NotAcceptedError';
  }

  get subcause(): string | undefined {
    const v = this.details?.['subcause'];
    return typeof v === 'string' ? v : undefined;
  }

  /**
   * The list of payment methods the Hub WILL accept for this capability,
   * surfaced from `details.accepted` per spec §3.5 (Audit A-L3).
   *
   * Typed accessor — saves callers a `details?.accepted as string[] | undefined`
   * cast and gives them a discoverable surface in IDE autocomplete.
   *
   * @example
   *   if (err.accepted?.includes('stripe')) { /* fall back to wallet *\/ }
   */
  get accepted(): string[] | undefined {
    const v = this.details?.['accepted'];
    if (Array.isArray(v) && v.every((x) => typeof x === 'string')) {
      return v as string[];
    }
    return undefined;
  }

  /**
   * The payment method the agent attempted but the Hub rejected
   * (e.g. `"x402"` when the capability is wallet-only). From `details.received`.
   * Audit A-L3.
   */
  get received(): string | undefined {
    const v = this.details?.['received'];
    return typeof v === 'string' ? v : undefined;
  }

  /** Always false. */
  get retryable(): false { return false; }
}

/**
 * v1.1.0 X402_SETTLEMENT_TIMEOUT — HTTP 504: the facilitator did not confirm
 * settlement within Hub's timeout window. Safe to retry; the SDK auto-retry
 * layer treats this as transient by default.
 *
 * `subcause` ∈ { facilitator_slow, chain_congested }.
 */
export class X402SettlementTimeoutError extends JecpError {
  constructor(opts: ConstructorParameters<typeof JecpError>[0]) {
    super(opts);
    this.name = 'X402SettlementTimeoutError';
  }

  get subcause(): string | undefined {
    const v = this.details?.['subcause'];
    return typeof v === 'string' ? v : undefined;
  }

  /** True — locked design §3.5 marks this Retry: yes. */
  get retryable(): true { return true; }
}

/**
 * v1.1.0 X402_FACILITATOR_UNREACHABLE — HTTP 502: Hub could not reach the
 * trusted facilitator (DNS / TCP / TLS / cert pin / Ed25519 signature pin
 * mismatch). Retryable for transient causes; cert/signature pin failures
 * indicate a potential compromise and should be investigated (the Hub
 * logs an alert).
 *
 * `subcause` ∈ { dns_fail, connection_refused, cert_pin_mismatch,
 *                signature_pin_mismatch }.
 */
export class X402FacilitatorUnreachableError extends JecpError {
  constructor(opts: ConstructorParameters<typeof JecpError>[0]) {
    super(opts);
    this.name = 'X402FacilitatorUnreachableError';
  }

  get subcause(): string | undefined {
    const v = this.details?.['subcause'];
    return typeof v === 'string' ? v : undefined;
  }

  /**
   * True for transport-level transients (dns_fail, connection_refused).
   * False for pin failures — those represent a trust failure, not a glitch.
   */
  get retryable(): boolean {
    const s = this.subcause;
    return s === 'dns_fail' || s === 'connection_refused';
  }
}

/**
 * v1.1.0 X402_SETTLEMENT_REUSED — HTTP 409: the X-Payment payload (by tx_hash
 * or EIP-3009 nonce) has already been settled. The SDK should generate a
 * fresh nonce and re-sign. Non-retryable with the same payload.
 *
 * `subcause` ∈ { tx_hash_seen, nonce_reused }.
 */
export class X402SettlementReusedError extends JecpError {
  constructor(opts: ConstructorParameters<typeof JecpError>[0]) {
    super(opts);
    this.name = 'X402SettlementReusedError';
  }

  get subcause(): string | undefined {
    const v = this.details?.['subcause'];
    return typeof v === 'string' ? v : undefined;
  }

  /** Always false (with the same payload — caller must re-sign). */
  get retryable(): false { return false; }
}

/**
 * SDK-composite error: mode='auto' tried every viable path and none worked.
 * Typical causes:
 * - mode='wallet' + 402 (no top-up done)
 * - mode='x402' but no signer configured
 * - mode='x402' but capability's 402 had no x402 accept entry
 * - mode='auto' but neither wallet has balance nor signer is present
 *
 * Carries the original Hub `next_action` (typically `topup`) so callers can
 * present the right recovery UI. v0.8.2 (H-4.4): when `next_action` is
 * absent, the constructor synthesizes `{type:'link_wallet'}` for
 * `signerMissing` or `{type:'switch_to_wallet'}` for `capabilityRejectedX402`.
 *
 * Locked design §6.3 (Developer UX — error classes).
 */
export class InsufficientPaymentOptionsError extends JecpError {
  constructor(opts: ConstructorParameters<typeof JecpError>[0] & {
    /** Set true if the agent has no signer; SDK exposes for diagnostics. */
    signerMissing?: boolean;
    /** Set true if mode='x402' and the 402 had no x402 entry. */
    capabilityRejectedX402?: boolean;
  }) {
    // H-4.4: synthesize a sensible default nextAction if Hub didn't send one.
    const enriched: ConstructorParameters<typeof JecpError>[0] = { ...opts };
    if (!enriched.nextAction) {
      if (opts.signerMissing) {
        enriched.nextAction = {
          type: 'link_wallet',
          hint: 'Configure payment.signer (see walletFromEnv) or top up the wallet via JecpClient.topup().',
        };
      } else if (opts.capabilityRejectedX402) {
        enriched.nextAction = {
          type: 'switch_to_wallet',
          hint: 'This capability does not accept x402. Switch payment.mode to "wallet" or pick another Provider.',
        };
      } else {
        enriched.nextAction = {
          type: 'topup',
          hint: 'Neither x402 nor a wallet balance is available. Top up via JecpClient.topup(20).',
        };
      }
    }
    super(enriched);
    this.name = 'InsufficientPaymentOptionsError';
    this.signerMissing = opts.signerMissing ?? false;
    this.capabilityRejectedX402 = opts.capabilityRejectedX402 ?? false;
  }

  public readonly signerMissing: boolean;
  public readonly capabilityRejectedX402: boolean;

  /** Always false — caller must change configuration or top up first. */
  get retryable(): false { return false; }
}

// ─── v0.8.2 H-4.4 helper: x402 default nextAction synthesis ───────────────
//
// Audit-D §A.3 P0-3 found that 5/5 X402_* error classes had no nextAction
// when Hubs (incl. the production Hub at v44+) didn't supply one. This
// helper centralizes the "fallback recovery hint" so the upgrade is purely
// additive — if a Hub starts emitting next_action, it wins.

/** @internal */
function applyDefaultX402NextAction(
  opts: ConstructorParameters<typeof JecpError>[0],
): ConstructorParameters<typeof JecpError>[0] {
  if (opts.nextAction) return opts;
  const subcause = typeof opts.details?.['subcause'] === 'string'
    ? (opts.details['subcause'] as string)
    : undefined;
  let nextAction: NextAction;
  switch (opts.code) {
    case 'X402_PAYMENT_INVALID': {
      // signature_invalid / amount_mismatch / nonce_reused / expired — all
      // resolved by re-signing a fresh authorization. signature_invalid in
      // particular often points at chainId / verifyingContract mismatch.
      nextAction = subcause === 'signature_invalid'
        ? { type: 'check_signer', hint: 'Verify EIP-712 domain (chainId, verifyingContract) matches the 402 challenge.' }
        : { type: 'resign', hint: 'Re-build EIP-3009 authorization with a fresh nonce.' };
      break;
    }
    case 'X402_NOT_ACCEPTED':
      nextAction = { type: 'switch_to_wallet', hint: 'Capability is wallet-only. Use payment.mode = "wallet" or pick another Provider.' };
      break;
    case 'X402_SETTLEMENT_TIMEOUT':
      nextAction = { type: 'retry_after', hint: 'Facilitator slow or chain congested. Retry with a fresh nonce after backoff.' };
      break;
    case 'X402_FACILITATOR_UNREACHABLE':
      nextAction = subcause === 'cert_pin_mismatch' || subcause === 'signature_pin_mismatch'
        ? { type: 'upgrade_client', hint: 'Trust pin mismatch — do not retry; check for an SDK update or facilitator key rotation.' }
        : { type: 'retry_after', hint: 'Transport-level transient. Retry the invoke with a fresh nonce.' };
      break;
    case 'X402_SETTLEMENT_REUSED':
      nextAction = { type: 'resign', hint: 'Replay detected (tx_hash or nonce). Re-sign with a fresh 32-byte nonce.' };
      break;
    default:
      return opts;
  }
  return { ...opts, nextAction };
}

// ─── v0.8.2 H-6 SDK safety caps (Panel 4 §A.3 + Audit B cross-finding) ────
//
// Three new SDK-only error classes. Thrown BEFORE signing — the EIP-3009
// signature is never produced, so even a compromised signer cannot leak it.
// All carry a `nextAction` of either `raise_cap`, `review_intent`, or
// `check_gas` so caller agents can present a recovery UI rather than just
// stack-trace.

/**
 * v0.8.2 X402_AMOUNT_CAP_EXCEEDED — SDK-only (no wire equivalent).
 *
 * Thrown by `JecpClient.invoke()` when the 402's x402 `amount` exceeds the
 * configured `payment.maxPerCallUsdc` cap. The signer is NOT invoked.
 *
 * `nextAction.type = 'raise_cap'` — caller may want to bump the cap or
 * escalate to a human-in-the-loop approval flow.
 */
export class X402AmountCapExceededError extends JecpError {
  constructor(opts: ConstructorParameters<typeof JecpError>[0] & {
    requestedUsdc: bigint;
    capUsdc: bigint;
  }) {
    const requested = formatUsdcMicros(opts.requestedUsdc);
    const cap = formatUsdcMicros(opts.capUsdc);
    super({
      ...opts,
      message: opts.message ||
        `x402 invoke amount $${requested} exceeds payment.maxPerCallUsdc cap $${cap}. ` +
        `Signature was NOT produced (audit-B / panel-4 §A.3 SDK defense).`,
      nextAction: opts.nextAction ?? {
        type: 'raise_cap',
        hint: `Raise payment.maxPerCallUsdc above ${opts.requestedUsdc.toString()} micros, ` +
          `or refuse this invoke at the caller layer.`,
      },
    });
    this.name = 'X402AmountCapExceededError';
    this.requestedUsdc = opts.requestedUsdc;
    this.capUsdc = opts.capUsdc;
  }

  /** The 402 challenge's requested USDC micros. */
  public readonly requestedUsdc: bigint;
  /** The SDK-configured cap in USDC micros. */
  public readonly capUsdc: bigint;

  /** Always false — the agent must raise the cap or refuse the call. */
  get retryable(): false { return false; }
}

/**
 * v0.8.2 X402_HOURLY_CAP_EXCEEDED — SDK-only (no wire equivalent).
 *
 * Thrown when accepting this invoke would push the rolling 1-hour spend
 * over `payment.maxPerHourUsdc`. The signer is NOT invoked, and the
 * pending invoke is NOT recorded against the budget.
 *
 * `nextAction.type = 'review_intent'` — typically points at a runaway loop
 * or prompt-injection scenario rather than an honest mistake.
 */
export class X402HourlyCapExceededError extends JecpError {
  constructor(opts: ConstructorParameters<typeof JecpError>[0] & {
    requestedUsdc: bigint;
    cumulativeUsdc: bigint;
    capUsdc: bigint;
  }) {
    const requested = formatUsdcMicros(opts.requestedUsdc);
    const cumulative = formatUsdcMicros(opts.cumulativeUsdc);
    const cap = formatUsdcMicros(opts.capUsdc);
    super({
      ...opts,
      message: opts.message ||
        `x402 invoke would push 1-hour spend to $${formatUsdcMicros(opts.cumulativeUsdc + opts.requestedUsdc)} ` +
        `(cap $${cap}; already spent $${cumulative} this hour, this call wants $${requested}).`,
      nextAction: opts.nextAction ?? {
        type: 'review_intent',
        hint: 'Pause the agent and inspect call patterns — hourly cap is a runaway-loop guardrail.',
      },
    });
    this.name = 'X402HourlyCapExceededError';
    this.requestedUsdc = opts.requestedUsdc;
    this.cumulativeUsdc = opts.cumulativeUsdc;
    this.capUsdc = opts.capUsdc;
  }

  public readonly requestedUsdc: bigint;
  /** Sum of x402 invokes accepted in the last 3600s (rolling window). */
  public readonly cumulativeUsdc: bigint;
  public readonly capUsdc: bigint;

  get retryable(): false { return false; }
}

/**
 * v0.8.2 X402_GAS_RATIO_EXCEEDED — SDK-only (no wire equivalent).
 *
 * Thrown when the estimated on-chain gas cost / invoke amount ratio
 * exceeds `payment.maxGasRatio` (default unset = no enforcement; typical
 * production setting: 0.05 = 5%).
 *
 * Defense against fee-malleability: a hostile facilitator could lure the
 * agent to settle low-value invokes during gas spikes, where gas dominates
 * total spend. The check happens after we know the amount but before
 * signing.
 */
export class X402GasRatioExceededError extends JecpError {
  constructor(opts: ConstructorParameters<typeof JecpError>[0] & {
    gasUsd: number;
    amountUsd: number;
    observedRatio: number;
    capRatio: number;
  }) {
    super({
      ...opts,
      message: opts.message ||
        `x402 gas/amount ratio ${(opts.observedRatio * 100).toFixed(2)}% ` +
        `exceeds payment.maxGasRatio cap ${(opts.capRatio * 100).toFixed(2)}% ` +
        `(gas ~$${opts.gasUsd.toFixed(4)} / amount $${opts.amountUsd.toFixed(4)}).`,
      nextAction: opts.nextAction ?? {
        type: 'check_gas',
        hint: 'Wait for Base gas to cool, or raise payment.maxGasRatio if higher overhead is acceptable.',
      },
    });
    this.name = 'X402GasRatioExceededError';
    this.gasUsd = opts.gasUsd;
    this.amountUsd = opts.amountUsd;
    this.observedRatio = opts.observedRatio;
    this.capRatio = opts.capRatio;
  }

  public readonly gasUsd: number;
  public readonly amountUsd: number;
  public readonly observedRatio: number;
  public readonly capRatio: number;

  get retryable(): false { return false; }
}

/** @internal — format USDC micros as a 4-decimal USD string for messages. */
function formatUsdcMicros(micros: bigint): string {
  const usd = Number(micros) / 1_000_000;
  return usd.toFixed(usd >= 1 ? 2 : 4);
}

// ─── v0.9.0 Provider lifecycle errors (JecpProviderClient) ───────────────
//
// Five new typed errors mirroring the Hub error codes documented in
// jecp-spec §3 + the Provider register/publish/rotate-key handlers. Same
// constructor shape as JecpError so callers can pattern-match on `.code` or
// `instanceof` interchangeably.

/**
 * v0.9.0 — HTTP 409: a Provider already owns the requested namespace.
 *
 * Pick a different namespace and re-run `JecpProviderClient.register()`.
 * Namespace transfer is currently a manual operator process (contact
 * support@jecp.dev).
 */
export class NamespaceTakenError extends JecpError {
  constructor(opts: ConstructorParameters<typeof JecpError>[0]) {
    super(opts);
    this.name = 'NamespaceTakenError';
  }
}

/**
 * v0.9.0 — HTTP 400: the country code supplied at register time is not
 * supported by Stripe Connect Express. The Hub keys off the ISO 3166-1
 * alpha-2 list Stripe publishes at https://stripe.com/global.
 *
 * Surface this to the operator with a link rather than retrying — list
 * membership is decided upstream of JECP.
 */
export class UnsupportedCountryError extends JecpError {
  constructor(opts: ConstructorParameters<typeof JecpError>[0]) {
    super(opts);
    this.name = 'UnsupportedCountryError';
  }
}

/**
 * v0.9.0 — HTTP 429: the Hub's 24-hour rotation cap kicked in.
 *
 * The cap defends against an attacker who phished one key and tries to
 * permanently rotate it out of reach by spamming `rotate-key`. If this fires
 * unexpectedly, audit recent activity in the Hub's `provider_audit_log`.
 *
 * The Hub typically allows up to 5 rotations per 24h window; see
 * the Provider register/me/rotate-key handler in setsuna-jobdonebot.
 */
export class RotationCapError extends JecpError {
  constructor(opts: ConstructorParameters<typeof JecpError>[0]) {
    super(opts);
    this.name = 'RotationCapError';
  }
}

/**
 * v0.9.0 — HTTP 400 PARSE_ERROR from POST /v1/manifests.
 *
 * YAML or JSON manifest could not be parsed. Common causes: invalid
 * indentation, unquoted strings that look like booleans / numbers,
 * stray Windows line endings. The Hub's message echoes the parser's
 * line/column when available.
 */
export class ManifestParseError extends JecpError {
  constructor(opts: ConstructorParameters<typeof JecpError>[0]) {
    super(opts);
    this.name = 'ManifestParseError';
  }
}

/**
 * v0.9.0 — HTTP 409 VERSION_EXISTS from POST /v1/manifests.
 *
 * The Provider already has a published manifest with this exact
 * `version`. Manifests are immutable post-publish: bump the manifest's
 * `version:` field (semver) and re-publish.
 */
export class ManifestVersionExistsError extends JecpError {
  constructor(opts: ConstructorParameters<typeof JecpError>[0]) {
    super(opts);
    this.name = 'ManifestVersionExistsError';
  }
}

