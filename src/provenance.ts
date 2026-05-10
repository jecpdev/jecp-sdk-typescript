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
 * **v1 (legacy, sunset 2026-08-01)** — `SHA256("agent_id:total_calls:api_key[..8]")`.
 * Cannot be computed after key rotation (plaintext is NULLed). Migrate to v2.
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

import { createHmac, createHash, randomBytes } from 'node:crypto';

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
 * **Deprecated** — Provenance v1 (SHA-256). Sunset 2026-08-01. Use
 * {@link computeProvenanceV2} for new code.
 *
 * Hub will return `PROVENANCE_MISMATCH` (HTTP 403) for v1 hashes after the
 * sunset date, and v1 cannot be computed for agents whose api_key has been
 * rotated to the bcrypt-only column (the plaintext is NULLed).
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
