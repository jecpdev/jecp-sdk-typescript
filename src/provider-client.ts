/**
 * JecpProviderClient (v0.9.0) — outbound Provider admin endpoints.
 *
 * Mirrors the surface of `@jecpdev/cli`'s `src/commands/provider.ts` so a
 * TypeScript app can run the full Provider lifecycle without shelling out:
 *
 *   1. JecpProviderClient.register(...)      — POST /v1/providers/register
 *   2. client.verifyDns({ once: true })      — POST /v1/providers/verify-dns
 *      or client.verifyDnsPoll(...)            (auto-retry every 10 s)
 *   3. client.publishManifest(yamlOrJson)    — POST /v1/manifests
 *   4. client.me()                           — GET  /v1/providers/me
 *   5. client.rotateKey({ ... })             — POST /v1/providers/me/rotate-key
 *   6. client.connectStripe()                — POST /v1/providers/connect-stripe
 *
 * Note this is a separate class from `JecpProvider` (the server-side HMAC
 * verifier in `src/provider.ts`). The two operate on different sides of the
 * wire: `JecpProvider` validates *inbound* Hub-to-Provider forwards; this
 * class drives *outbound* admin calls from the Provider to the Hub.
 *
 * v0.9.0 ships register / verify-dns / publish / rotate-key / me /
 * connect-stripe as a focused, ergonomic surface. No retries are layered
 * here: every endpoint is operator-driven, so masking transient failures
 * would be the wrong default (an operator wants to know if DNS is flaky).
 * Use `verifyDnsPoll()` when you do want a wait-loop.
 */

import { JecpError } from './errors.js';
import type {
  ConnectStripeResponse,
  ProviderMe,
  ProviderRegisterRequest,
  ProviderRegisterResponse,
  PublishResponse,
  RotateKeyResponse,
  VerifyDnsResponse,
} from './types.js';

const DEFAULT_BASE_URL = 'https://jecp.dev';
const DEFAULT_POLL_INTERVAL_MS = 10_000;
const DEFAULT_POLL_TIMEOUT_MS = 10 * 60 * 1000; // 10 min
const MIN_GRACE_SECONDS = 60;
const MAX_GRACE_SECONDS = 604_800; // 7 days

export interface JecpProviderClientOptions {
  /**
   * The Provider's API key (`jdb_pk_<48 hex>`), issued at register time.
   * Required for every instance method on this class.
   */
  providerApiKey: string;
  /** Defaults to https://jecp.dev. Trailing slashes are trimmed. */
  baseUrl?: string;
  /** Custom fetch impl (e.g. for testing). */
  fetch?: typeof fetch;
}

export interface VerifyDnsOptions {
  /**
   * If true, perform a single `POST /v1/providers/verify-dns` and return.
   * Default false — kept for symmetry with the CLI `--once` flag.
   * `verifyDns()` already does one attempt; this option is a no-op there
   * but accepted for API consistency.
   */
  once?: boolean;
}

export interface VerifyDnsPollOptions {
  /** Interval between attempts in ms. Default 10 000 (10 s). */
  intervalMs?: number;
  /** Overall deadline in ms. Default 600 000 (10 min). */
  timeoutMs?: number;
  /** Per-attempt observer — useful for surfacing progress in CI logs. */
  onAttempt?: (attempt: number, status: string) => void;
  /** AbortSignal — aborts the loop cleanly (resolves on next yield). */
  signal?: AbortSignal;
}

export interface PublishManifestOptions {
  /**
   * Override Content-Type. By default the SDK autodetects: a body whose
   * first non-whitespace character is `{` or `[` is sent as
   * `application/json`; everything else as `application/x-yaml` (matching
   * the Hub's accepted media types per spec §5).
   */
  contentType?: 'application/x-yaml' | 'application/json';
}

export interface RotateKeyOptions {
  /**
   * Grace period in seconds during which the previous api_key is still
   * accepted. Must be in [60, 604 800] (7 days). When omitted the Hub
   * uses its default (currently 7 days). Ignored when `revokeOld=true`.
   */
  graceSeconds?: number;
  /** If true, the Hub revokes the previous key immediately (grace=0). */
  revokeOld?: boolean;
}

/**
 * Client for the Provider lifecycle endpoints on a JECP Hub.
 *
 * Construct one instance per Provider credential. The instance is
 * stateless — it does not persist the api_key anywhere; callers must
 * write it to their own secret store after `register()`.
 *
 * @example
 *   const creds = await JecpProviderClient.register({
 *     namespace: 'example',
 *     display_name: 'Example Co',
 *     owner_email: 'ops@example.com',
 *     endpoint_url: 'https://example.com/jecp',
 *     country: 'JP',
 *   });
 *   // Save creds.provider_api_key + creds.hmac_secret immediately.
 *
 *   const client = new JecpProviderClient({ providerApiKey: creds.provider_api_key });
 *   await client.verifyDnsPoll({ onAttempt: (n, s) => console.log(n, s) });
 *   await client.publishManifest(readFileSync('jecp.yaml', 'utf-8'));
 */
export class JecpProviderClient {
  public readonly baseUrl: string;
  private readonly providerApiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: JecpProviderClientOptions) {
    if (!opts.providerApiKey) {
      throw new Error('JecpProviderClient: providerApiKey is required');
    }
    this.providerApiKey = opts.providerApiKey;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = opts.fetch ?? fetch;
  }

  // ─── static: register ─────────────────────────────────────────────

  /**
   * Register a new Provider with the Hub. Returns credentials that are shown
   * only ONCE — persist `provider_api_key` and `hmac_secret` immediately or
   * you must re-register from scratch.
   *
   * Normalizations (matching the canonical CLI behavior):
   * - `namespace`            → lowercased
   * - `country`              → uppercased
   * - `usdc_payout_address`  → lowercased
   *
   * Common error mapping:
   * - HTTP 409 `NAMESPACE_TAKEN`   → `NamespaceTakenError`
   * - HTTP 400 `UNSUPPORTED_COUNTRY` → `UnsupportedCountryError`
   * - HTTP 422 `URL_BLOCKED_SSRF`  → `UrlBlockedSsrfError` (SSRF deny-list)
   */
  static async register(
    request: ProviderRegisterRequest,
    baseUrl: string = DEFAULT_BASE_URL,
    fetchImpl: typeof fetch = fetch,
  ): Promise<ProviderRegisterResponse> {
    const url = `${baseUrl.replace(/\/+$/, '')}/v1/providers/register`;
    const body: Record<string, unknown> = {
      namespace: request.namespace.toLowerCase(),
      display_name: request.display_name,
      owner_email: request.owner_email,
      endpoint_url: request.endpoint_url,
      country: request.country.toUpperCase(),
    };
    if (request.website) body.website = request.website;
    if (request.usdc_payout_address) {
      body.usdc_payout_address = request.usdc_payout_address.toLowerCase();
    }

    return JecpProviderClient.fetchJson<ProviderRegisterResponse>(fetchImpl, {
      method: 'POST',
      url,
      body,
    });
  }

  // ─── instance: me ─────────────────────────────────────────────────

  /** GET /v1/providers/me — full status of the calling Provider. */
  async me(): Promise<ProviderMe> {
    return this.authedFetch<ProviderMe>({ method: 'GET', path: '/v1/providers/me' });
  }

  // ─── instance: verify-dns ─────────────────────────────────────────

  /**
   * Single attempt against POST /v1/providers/verify-dns.
   *
   * Returns the parsed `{ verified, status, message }` envelope on 2xx
   * and on 4xx that is NOT 401/403 — a "not yet verified" outcome is not
   * an exception, it's an expected state during DNS propagation.
   *
   * The loop halts on the same conditions as `@jecpdev/cli`'s poll loop
   * (QA P1-5): 401/403 throws `AuthError` (a revoked key should never be
   * silently polled forever) and 5xx throws `JecpError` (a Hub internal
   * failure the caller cannot resolve). The CLI exits the process for the
   * same conditions — the surfaces share the same set of halting reasons,
   * they just differ in how they signal them (throw vs. exit).
   *
   * Pass `{ once: true }` for parity with the CLI flag; it's the same
   * behavior as omitting options.
   */
  async verifyDns(_opts: VerifyDnsOptions = {}): Promise<VerifyDnsResponse> {
    return this.singleVerifyAttempt();
  }

  /**
   * Poll POST /v1/providers/verify-dns at fixed intervals until verified
   * or until `timeoutMs` elapses.
   *
   * Resolves with `{ verified: true, ... }` on success. On timeout, the
   * final attempt's response is returned with `verified: false` so the
   * caller can decide whether to surface or retry — this is intentional:
   * a long-tail DNS propagation is a UX problem, not a fatal one, and
   * forcing callers to catch a `TimeoutError` here would be hostile.
   *
   * Halting conditions (shared with the CLI poll loop — QA P1-5):
   * - 401 / 403 during any attempt → throws `AuthError`
   * - 5xx during any attempt       → throws `JecpError`
   * The CLI exits the process under the same conditions; the two surfaces
   * stop polling for the same reasons but signal differently.
   *
   * @example
   *   const r = await client.verifyDnsPoll({
   *     intervalMs: 5000,
   *     timeoutMs: 120_000,
   *     onAttempt: (n, s) => console.log(`attempt ${n}: ${s}`),
   *   });
   *   if (!r.verified) console.warn('still propagating, try again later');
   */
  async verifyDnsPoll(opts: VerifyDnsPollOptions = {}): Promise<VerifyDnsResponse> {
    const intervalMs = opts.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    let attempt = 0;
    let last: VerifyDnsResponse | undefined;

    while (Date.now() < deadline) {
      attempt++;
      if (opts.signal?.aborted) {
        throw new JecpError({
          code: 'ABORTED',
          message: 'verifyDnsPoll aborted by caller',
          status: 0,
        });
      }
      last = await this.singleVerifyAttempt();
      opts.onAttempt?.(attempt, last.status);
      if (last.verified) return last;
      if (Date.now() + intervalMs >= deadline) break;
      await sleep(intervalMs, opts.signal);
    }

    // Loop exhausted without verification — return the last response so the
    // caller can inspect `.status` and `.message`. (Audit-style rationale:
    // throwing a TimeoutError here would force every CI script to wrap a
    // try/catch around a non-error outcome.)
    return last ?? { verified: false, status: 'timeout', message: 'no attempts ran' };
  }

  // ─── instance: publish ────────────────────────────────────────────

  /**
   * POST /v1/manifests with a YAML or JSON manifest body.
   *
   * `yamlOrJson` is sent verbatim — the SDK does NOT parse it. To validate
   * locally before publishing, parse with `js-yaml` (or `JSON.parse`) and
   * run the result through `validateManifest()`.
   *
   * Content-Type is autodetected by inspecting the first non-whitespace
   * character: `{` or `[` → `application/json`, else `application/x-yaml`.
   * Override via `opts.contentType` for edge cases (e.g. YAML that happens
   * to start with `[`).
   *
   * Common error mapping:
   * - HTTP 400 `PARSE_ERROR`     → `ManifestParseError`
   * - HTTP 409 `VERSION_EXISTS`  → `ManifestVersionExistsError`
   */
  async publishManifest(
    yamlOrJson: string,
    opts: PublishManifestOptions = {},
  ): Promise<PublishResponse> {
    const trimmed = yamlOrJson.trimStart();
    const looksLikeJson = trimmed.startsWith('{') || trimmed.startsWith('[');
    const contentType =
      opts.contentType ?? (looksLikeJson ? 'application/json' : 'application/x-yaml');

    const url = `${this.baseUrl}/v1/manifests`;
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': contentType,
        Authorization: `Bearer ${this.providerApiKey}`,
      },
      body: yamlOrJson,
    });

    if (!res.ok) {
      const raw = (await res.json().catch(() => ({}))) as RawErrorEnvelope;
      throw JecpProviderClient.errorFromBody(raw, res.status);
    }
    return (await res.json()) as PublishResponse;
  }

  // ─── instance: rotate-key ─────────────────────────────────────────

  /**
   * POST /v1/providers/me/rotate-key.
   *
   * The returned `api_key` is shown only ONCE — the SDK does not persist it.
   * Save it immediately or the Provider will be locked out.
   *
   * `graceSeconds` must be in [60, 604 800] (7 days). Pre-flight validation
   * throws synchronously to avoid wasting a Hub rotation slot on a typo.
   *
   * Common error mapping:
   * - HTTP 429 `ROTATION_24H_CAP` → `RotationCapError`
   */
  async rotateKey(opts: RotateKeyOptions = {}): Promise<RotateKeyResponse> {
    if (opts.graceSeconds !== undefined) {
      if (
        !Number.isInteger(opts.graceSeconds) ||
        opts.graceSeconds < MIN_GRACE_SECONDS ||
        opts.graceSeconds > MAX_GRACE_SECONDS
      ) {
        throw new Error(
          `JecpProviderClient.rotateKey: graceSeconds must be an integer in [${MIN_GRACE_SECONDS}, ${MAX_GRACE_SECONDS}]`,
        );
      }
    }
    const body: Record<string, unknown> = {};
    if (opts.graceSeconds !== undefined) body.grace_seconds = opts.graceSeconds;
    if (opts.revokeOld) body.revoke_old = true;

    return this.authedFetch<RotateKeyResponse>({
      method: 'POST',
      path: '/v1/providers/me/rotate-key',
      body,
    });
  }

  // ─── instance: connect-stripe ─────────────────────────────────────

  /** POST /v1/providers/connect-stripe — open the URL in a browser. */
  async connectStripe(): Promise<ConnectStripeResponse> {
    return this.authedFetch<ConnectStripeResponse>({
      method: 'POST',
      path: '/v1/providers/connect-stripe',
      body: {},
    });
  }

  // ─── internals ────────────────────────────────────────────────────

  /**
   * Single attempt against /v1/providers/verify-dns.
   *
   * Semantics (mirrored in `@jecpdev/cli` — QA P1-5):
   * - 2xx                         → return envelope
   * - 4xx (non-401/403)           → return envelope (still propagating)
   * - 401 / 403                   → throw `AuthError` (caller stops looping)
   * - 5xx                         → throw `JecpError` (Hub failure)
   *
   * The CLI exits the process under the 401/403/5xx conditions. Both
   * surfaces halt the poll loop for the same reasons.
   */
  private async singleVerifyAttempt(): Promise<VerifyDnsResponse> {
    const url = `${this.baseUrl}/v1/providers/verify-dns`;
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.providerApiKey}`,
      },
      body: JSON.stringify({}),
    });
    const raw = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.ok) return raw as unknown as VerifyDnsResponse;

    // 4xx: surface as a non-verified attempt — matches CLI singleVerifyAttempt.
    if (res.status >= 400 && res.status < 500) {
      // Auth failures (401 / 403) are NOT "still propagating" — let them
      // throw so callers don't loop forever against a bad key.
      if (res.status === 401 || res.status === 403) {
        throw JecpProviderClient.errorFromBody(raw as RawErrorEnvelope, res.status);
      }
      const err = (raw as RawErrorEnvelope).error;
      const code = typeof err === 'object' && err?.code ? err.code : `HTTP_${res.status}`;
      const message =
        typeof err === 'string'
          ? err
          : typeof err === 'object' && err?.message
            ? err.message
            : `request failed: ${res.status}`;
      return { verified: false, status: code, message };
    }
    throw JecpProviderClient.errorFromBody(raw as RawErrorEnvelope, res.status);
  }

  /**
   * Authed JSON fetch — adds `Authorization: Bearer <providerApiKey>` and
   * unwraps both legacy (`{error:"..."}`) and JECP (`{error:{code,message}}`)
   * error envelopes into typed exceptions.
   */
  private async authedFetch<T>(opts: {
    method: 'GET' | 'POST' | 'DELETE';
    path: string;
    body?: unknown;
  }): Promise<T> {
    const url = `${this.baseUrl}${opts.path}`;
    const init: RequestInit = {
      method: opts.method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.providerApiKey}`,
      },
    };
    if (opts.body !== undefined) {
      init.body = JSON.stringify(opts.body);
    }
    const res = await this.fetchImpl(url, init);
    if (!res.ok) {
      const raw = (await res.json().catch(() => ({}))) as RawErrorEnvelope;
      throw JecpProviderClient.errorFromBody(raw, res.status);
    }
    return (await res.json()) as T;
  }

  /**
   * Unauthed JSON fetch — used by the static `register()` factory.
   * Same error unwrap as `authedFetch` but no Authorization header.
   */
  private static async fetchJson<T>(
    fetchImpl: typeof fetch,
    opts: { method: 'POST' | 'GET'; url: string; body?: unknown },
  ): Promise<T> {
    const init: RequestInit = {
      method: opts.method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
    const res = await fetchImpl(opts.url, init);
    if (!res.ok) {
      const raw = (await res.json().catch(() => ({}))) as RawErrorEnvelope;
      throw JecpProviderClient.errorFromBody(raw, res.status);
    }
    return (await res.json()) as T;
  }

  /**
   * Translate a raw Hub error envelope into the most specific SDK exception.
   *
   * Wire shapes the Hub emits (both supported):
   *   { error: "string" }                                   (legacy)
   *   { error: { code, message, details? } }                (JECP v1.0+)
   *
   * Unknown codes fall back to plain `JecpError` with the raw body attached.
   *
   * Delegates to {@link JecpError.fromBody} after normalizing the envelope —
   * keeps a single source of truth for code-to-subclass dispatch (architect
   * A-1). The legacy `{ error: "string" }` shape is rewritten to a structured
   * envelope so the canonical factory sees the same input as the v1.0+ path,
   * and `next_action` (when present at the top level) is preserved.
   */
  private static errorFromBody(body: RawErrorEnvelope, status: number): JecpError {
    const err = body?.error;
    let normalized: Parameters<typeof JecpError.fromBody>[0];
    if (typeof err === 'string') {
      // Legacy `{ error: "string" }` — synthesize a structured envelope so
      // JecpError.fromBody can dispatch normally. The synthetic code carries
      // the HTTP status (`HTTP_409` etc.) so it remains diagnosable.
      normalized = {
        error: { code: `HTTP_${status}`, message: err },
        next_action: (body as { next_action?: import('./types.js').NextAction }).next_action,
      };
    } else if (err && typeof err === 'object') {
      normalized = {
        error: {
          code: err.code ?? `HTTP_${status}`,
          message: err.message ?? `request failed: ${status}`,
          details:
            err.details && typeof err.details === 'object'
              ? (err.details as Record<string, unknown>)
              : undefined,
        },
        next_action: (body as { next_action?: import('./types.js').NextAction }).next_action,
      };
    } else {
      normalized = {
        error: { code: `HTTP_${status}`, message: `request failed: ${status}` },
        next_action: (body as { next_action?: import('./types.js').NextAction }).next_action,
      };
    }
    return JecpError.fromBody(normalized, status);
  }
}

// ─── helpers ───────────────────────────────────────────────────────

interface RawErrorEnvelope {
  error?: string | { code?: string; message?: string; details?: unknown };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(
        new JecpError({
          code: 'ABORTED',
          message: 'sleep aborted by caller',
          status: 0,
        }),
      );
    };
    const cleanup = () => {
      clearTimeout(t);
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort);
  });
}
