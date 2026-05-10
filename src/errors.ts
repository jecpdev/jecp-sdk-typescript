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
