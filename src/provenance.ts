/**
 * Provenance helpers — generate the optional `mandate.provenance_hash` value
 * that proves the agent actually holds the api_key it claims.
 *
 * **v2 (recommended)** — HMAC-SHA256 binding agent_id, timestamp, nonce.
 * Wire format: `"v2:<unix_seconds>:<nonce_hex>:<hmac_hex>"`. Hub re-computes
 * the HMAC using the plaintext api_key supplied via `mandate.api_key`, then
 * compares constant-time. Timestamps must be within ±300s of Hub clock; nonces
 * are tracked for 600s to prevent replay.
 *
 * **v1 (legacy, sunset 2026-11-01)** — `SHA256("agent_id:total_calls:api_key[..8]")`.
 * Cannot be computed after key rotation (plaintext is NULLed). `Deprecation` /
 * `Sunset` response headers begin 2026-08-01; final removal 2026-11-01. Migrate to v2.
 *
 * @example
 * ```ts
 * import { computeProvenanceV2 } from '@jecpdev/sdk';
 *
 * const hash = computeProvenanceV2({
 *   apiKey: 'jdb_ak_supersecret_xyz',
 *   agentId: 'jdb_ag_abc123',
 * });
 * // pass into invoke():
 * await client.invoke({ ..., mandate: { ..., provenance_hash: hash } });
 * ```
 */

import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export interface ComputeProvenanceV2Input {
  /** Plaintext API key the agent is currently using. */
  apiKey: string;
  /** Agent ID (e.g. `jdb_ag_abc123`). */
  agentId: string;
  /** Optional unix-seconds timestamp. Defaults to `Date.now() / 1000` floored. */
  timestamp?: number;
  /** Optional pre-generated nonce (≥16 hex chars). Defaults to 16 random bytes hex. */
  nonce?: string;
}

/**
 * Provenance verification subcause — closed registry per spec v1.0.1 §3.1.
 * Mirrors the Hub's `ProvenanceSubcause` Rust enum 1:1.
 */
export type ProvenanceSubcause =
  | 'wire_malformed'
  | 'clock_skew'
  | 'hmac_mismatch'
  /** Hub-only — SDK never returns this; here for type completeness when
   *  parsing Hub error responses. */
  | 'nonce_replay'
  | 'v1_legacy_mismatch'
  | 'v1_unavailable';

/**
 * Result of {@link verifyProvenanceV2}. Discriminated union — the helper
 * never throws on verification failure (Stripe webhook pattern). Exceptions
 * are reserved for programmer errors (e.g. missing required fields).
 */
export type VerifyProvenanceResult =
  | { ok: true;  timestamp: number; nonce: string }
  | { ok: false; subcause: Exclude<ProvenanceSubcause, 'nonce_replay'>; detail: string };

export interface VerifyProvenanceV2Input {
  /** Plaintext API key (the same value the Hub authenticates against bcrypt). */
  apiKey: string;
  /** Agent ID expected in the provenance binding. */
  agentId: string;
  /** The wire string from `mandate.provenance_hash`. */
  claimed: string;
  /** Optional clock-skew window in seconds. Default 300s, matching Hub. */
  clockSkewSec?: number;
  /** Optional clock injection (testability). Returns unix-seconds. */
  now?: () => number;
}

/**
 * Build a Provenance v2 wire string.
 *
 * Returns `"v2:<timestamp>:<nonce>:<hmac_hex>"` — pass directly to
 * `mandate.provenance_hash`.
 */
export function computeProvenanceV2(input: ComputeProvenanceV2Input): string {
  const timestamp = input.timestamp ?? Math.floor(Date.now() / 1000);
  const nonce = input.nonce ?? randomBytes(16).toString('hex');

  if (nonce.length < 16 || !/^[0-9a-fA-F]+$/.test(nonce)) {
    throw new Error('computeProvenanceV2: nonce must be ≥16 hex chars');
  }

  const msg = `${input.agentId}:${timestamp}:${nonce}`;
  const tag = createHmac('sha256', input.apiKey).update(msg).digest('hex');
  return `v2:${timestamp}:${nonce}:${tag}`;
}

/**
 * Verify a Provenance v2 wire string. Returns a discriminated-union result;
 * never throws on verification failure (the helper distinguishes "wire
 * malformed" / "clock skew" / "hmac mismatch" via `result.subcause`).
 *
 * Only the cryptographic binding and timestamp window are checked here —
 * **nonce-replay defense is the caller's responsibility**. Providers that
 * want the full guarantee should pair this helper with their own LRU cache
 * keyed by `(agent_id, nonce)` (or use the {@link createReplayCache} factory
 * we ship for the same purpose).
 *
 * The Hub remains the authoritative verifier — this helper is provided so
 * Provider-side code (receiving forwarded calls from a Hub) can independently
 * validate the binding before processing.
 *
 * @example
 * ```ts
 * const result = verifyProvenanceV2({
 *   apiKey: agent.apiKey,
 *   agentId: agent.id,
 *   claimed: mandate.provenance_hash!,
 * });
 * if (!result.ok) {
 *   // result.subcause is one of: wire_malformed | clock_skew | hmac_mismatch | v1_*
 *   throw new Error(`Provenance check failed: ${result.subcause}`);
 * }
 * console.log('verified', result.timestamp, result.nonce);
 * ```
 */
export function verifyProvenanceV2(input: VerifyProvenanceV2Input): VerifyProvenanceResult {
  const skew = input.clockSkewSec ?? 300;
  const nowFn = input.now ?? (() => Math.floor(Date.now() / 1000));

  // Detect v1 (64 hex, no colons) vs v2 (v2:...) up front so the SDK can
  // surface a clear `v1_legacy_mismatch` rather than `wire_malformed`.
  if (!input.claimed.startsWith('v2:')) {
    if (/^[0-9a-f]{64}$/.test(input.claimed)) {
      return {
        ok: false,
        subcause: 'v1_legacy_mismatch',
        detail: 'Wire is a v1 SHA-256 hash; verifyProvenanceV2 only handles v2. Use computeProvenanceV1 if you must verify v1 (deprecated, sunset 2026-11-01).',
      };
    }
    return {
      ok: false,
      subcause: 'wire_malformed',
      detail: 'Wire format must start with "v2:" (or be a 64-hex v1 hash).',
    };
  }

  const parts = input.claimed.split(':');
  // v2:<ts>:<nonce>:<hmac> → 4 parts
  if (parts.length !== 4) {
    return {
      ok: false,
      subcause: 'wire_malformed',
      detail: 'v2 wire must be exactly 4 colon-separated parts (v2:<ts>:<nonce>:<hmac_hex>).',
    };
  }
  const [, tsStr, nonce, claimedTag] = parts as [string, string, string, string];

  if (!/^[0-9]+$/.test(tsStr)) {
    return {
      ok: false,
      subcause: 'wire_malformed',
      detail: 'v2 timestamp must be an unsigned unix-seconds integer.',
    };
  }
  const timestamp = Number.parseInt(tsStr, 10);
  if (!Number.isFinite(timestamp)) {
    return {
      ok: false,
      subcause: 'wire_malformed',
      detail: 'v2 timestamp does not parse to a finite number.',
    };
  }

  if (nonce.length < 16 || !/^[0-9a-fA-F]+$/.test(nonce)) {
    return {
      ok: false,
      subcause: 'wire_malformed',
      detail: 'v2 nonce must be ≥ 16 hex characters.',
    };
  }

  if (claimedTag.length !== 64 || !/^[0-9a-fA-F]+$/.test(claimedTag)) {
    return {
      ok: false,
      subcause: 'wire_malformed',
      detail: 'v2 HMAC tag must be exactly 64 hex characters (SHA-256).',
    };
  }

  const drift = nowFn() - timestamp;
  if (Math.abs(drift) > skew) {
    return {
      ok: false,
      subcause: 'clock_skew',
      detail: `v2 timestamp out of ±${skew}s window (drift=${drift}s).`,
    };
  }

  const msg = `${input.agentId}:${timestamp}:${nonce}`;
  const expectedTag = createHmac('sha256', input.apiKey).update(msg).digest('hex');

  // Constant-time compare. Buffer must be same length — already guaranteed
  // by the regex check above, but we double-check for safety.
  const a = Buffer.from(expectedTag, 'utf8');
  const b = Buffer.from(claimedTag.toLowerCase(), 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return {
      ok: false,
      subcause: 'hmac_mismatch',
      detail: 'v2 HMAC tag does not match — provenance verification failed.',
    };
  }

  return { ok: true, timestamp, nonce };
}

export interface ReplayCacheOptions {
  /** TTL in seconds. Default 600 to match spec §5.2 step 5. */
  ttlSec?: number;
  /** Optional clock injection for tests. */
  now?: () => number;
}

/**
 * In-memory replay-defense cache for `(agent_id, nonce)` pairs. Drop-in
 * companion to {@link verifyProvenanceV2}: providers can compose them to
 * achieve the full spec §5.2 step 5 semantics on their own service.
 *
 * The Hub maintains its own cache; this is for Providers (and Agents that
 * want belt-and-braces local verification). Single-process LRU; for
 * cluster deployments swap to a shared store.
 *
 * @example
 * ```ts
 * const cache = createReplayCache({ ttlSec: 600 });
 * const result = verifyProvenanceV2({ apiKey, agentId, claimed });
 * if (!result.ok) throw new Error(result.subcause);
 * if (cache.checkAndInsert(agentId, result.nonce) === 'replay') {
 *   throw new Error('nonce_replay');
 * }
 * ```
 */
export interface ReplayCache {
  checkAndInsert(agentId: string, nonce: string): 'first' | 'replay';
  size(): number;
}

export function createReplayCache(opts: ReplayCacheOptions = {}): ReplayCache {
  const ttlMs = (opts.ttlSec ?? 600) * 1000;
  const nowFn = opts.now ?? (() => Date.now());
  const entries = new Map<string, number>(); // key → insertion timestamp ms

  return {
    checkAndInsert(agentId, nonce) {
      const key = `${agentId}\x00${nonce.toLowerCase()}`;
      const now = nowFn();
      const seen = entries.get(key);
      if (seen !== undefined && now - seen < ttlMs) {
        return 'replay';
      }
      entries.set(key, now);
      // Lazy cleanup: drop old entries on every Nth insert. Cheap.
      if (entries.size % 1024 === 0) {
        for (const [k, t] of entries) {
          if (now - t >= ttlMs) entries.delete(k);
        }
      }
      return 'first';
    },
    size() {
      return entries.size;
    },
  };
}

/**
 * **Deprecated** — Provenance v1 (SHA-256). Sunset 2026-11-01. Use
 * {@link computeProvenanceV2} for new code.
 *
 * Hub will return `PROVENANCE_MISMATCH` (HTTP 403) for v1 hashes after the
 * sunset date, and v1 cannot be computed for agents whose api_key has been
 * rotated to the bcrypt-only column (the plaintext is NULLed). Hubs attach
 * `Deprecation: true` and `Sunset: Sat, 01 Nov 2026 00:00:00 GMT` response
 * headers from 2026-08-01 onward whenever a v1 hash is accepted.
 *
 * @deprecated since 2026-05-10, removed 2026-11-01 — switch to {@link computeProvenanceV2}.
 */
export function computeProvenanceV1(input: {
  apiKey: string;
  agentId: string;
  totalCalls: number;
}): string {
  const prefix = input.apiKey.length >= 8 ? input.apiKey.slice(0, 8) : input.apiKey;
  const msg = `${input.agentId}:${input.totalCalls}:${prefix}`;
  return createHash('sha256').update(msg).digest('hex');
}
