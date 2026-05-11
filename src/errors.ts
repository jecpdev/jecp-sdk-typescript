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

      // v1.1.0 x402 — locked design §3.5
      case 'X402_PAYMENT_INVALID':
        return new X402PaymentInvalidError(opts);
      case 'X402_NOT_ACCEPTED':
        return new X402NotAcceptedError(opts);
      case 'X402_SETTLEMENT_TIMEOUT':
        return new X402SettlementTimeoutError(opts);
      case 'X402_FACILITATOR_UNREACHABLE':
        return new X402FacilitatorUnreachableError(opts);
      case 'X402_SETTLEMENT_REUSED':
        return new X402SettlementReusedError(opts);

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
 * present the right recovery UI.
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
    super(opts);
    this.name = 'InsufficientPaymentOptionsError';
    this.signerMissing = opts.signerMissing ?? false;
    this.capabilityRejectedX402 = opts.capabilityRejectedX402 ?? false;
  }

  public readonly signerMissing: boolean;
  public readonly capabilityRejectedX402: boolean;

  /** Always false — caller must change configuration or top up first. */
  get retryable(): false { return false; }
}

