import { describe, it, expect } from 'vitest';
import { createHmac, createHash } from 'node:crypto';
import {
  computeProvenanceV2,
  computeProvenanceV1,
  verifyProvenanceV2,
  createReplayCache,
} from '../src/provenance.js';

describe('computeProvenanceV2', () => {
  it('produces wire format "v2:<ts>:<nonce>:<hmac_hex>"', () => {
    const wire = computeProvenanceV2({
      apiKey: 'jdb_ak_secret_xyz',
      agentId: 'jdb_ag_abc123',
      timestamp: 1762689600,
      nonce: 'deadbeef0123456789abcdef01234567',
    });
    const parts = wire.split(':');
    expect(parts[0]).toBe('v2');
    expect(parts[1]).toBe('1762689600');
    expect(parts[2]).toBe('deadbeef0123456789abcdef01234567');
    expect(parts[3]).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(parts[3])).toBe(true);
  });

  it('matches independent HMAC-SHA256 reference computation', () => {
    const apiKey = 'jdb_ak_supersecret';
    const agentId = 'jdb_ag_xyz';
    const timestamp = 1762689600;
    const nonce = 'aabbccddeeff00112233445566778899';
    const wire = computeProvenanceV2({ apiKey, agentId, timestamp, nonce });

    const expected = createHmac('sha256', apiKey)
      .update(`${agentId}:${timestamp}:${nonce}`)
      .digest('hex');
    expect(wire).toBe(`v2:${timestamp}:${nonce}:${expected}`);
  });

  it('defaults timestamp to current second when omitted', () => {
    const before = Math.floor(Date.now() / 1000);
    const wire = computeProvenanceV2({
      apiKey: 'k',
      agentId: 'a',
      nonce: '0123456789abcdef0123456789abcdef',
    });
    const after = Math.floor(Date.now() / 1000);
    const ts = parseInt(wire.split(':')[1]!, 10);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it('generates a random nonce when omitted', () => {
    const w1 = computeProvenanceV2({ apiKey: 'k', agentId: 'a', timestamp: 1 });
    const w2 = computeProvenanceV2({ apiKey: 'k', agentId: 'a', timestamp: 1 });
    expect(w1).not.toBe(w2); // distinct nonces → distinct wires
    const nonce1 = w1.split(':')[2]!;
    expect(nonce1.length).toBeGreaterThanOrEqual(16);
    expect(/^[0-9a-f]+$/.test(nonce1)).toBe(true);
  });

  it('rejects nonce shorter than 16 hex chars', () => {
    expect(() =>
      computeProvenanceV2({ apiKey: 'k', agentId: 'a', timestamp: 1, nonce: 'abcd' })
    ).toThrow(/≥16 hex chars/);
  });

  it('rejects non-hex nonce', () => {
    expect(() =>
      computeProvenanceV2({
        apiKey: 'k',
        agentId: 'a',
        timestamp: 1,
        nonce: 'zzzz0123456789abcdefghij',
      })
    ).toThrow();
  });

  it('different api_keys produce different wires for same agent/ts/nonce', () => {
    const args = { agentId: 'a', timestamp: 1, nonce: '0123456789abcdef0123456789abcdef' };
    const w1 = computeProvenanceV2({ apiKey: 'key1', ...args });
    const w2 = computeProvenanceV2({ apiKey: 'key2', ...args });
    expect(w1).not.toBe(w2);
  });
});

describe('computeProvenanceV1 (deprecated)', () => {
  it('matches independent SHA-256 reference computation', () => {
    const apiKey = 'jdb_ak_secret_xyz';
    const agentId = 'jdb_ag_abc123';
    const totalCalls = 42;
    const got = computeProvenanceV1({ apiKey, agentId, totalCalls });
    const expected = createHash('sha256')
      .update(`${agentId}:${totalCalls}:${apiKey.slice(0, 8)}`)
      .digest('hex');
    expect(got).toBe(expected);
    expect(got).toHaveLength(64);
  });

  it('truncates api_key to 8 chars', () => {
    const a = computeProvenanceV1({ apiKey: 'jdb_ak_b___MORE___', agentId: 'a', totalCalls: 0 });
    const b = computeProvenanceV1({ apiKey: 'jdb_ak_b___DIFFERENT___', agentId: 'a', totalCalls: 0 });
    expect(a).toBe(b); // same first 8 chars → same hash (this is the v1 weakness)
  });
});

describe('verifyProvenanceV2', () => {
  const apiKey = 'jdb_ak_secret_xyz';
  const agentId = 'jdb_ag_test123';

  it('round-trips compute → verify successfully', () => {
    const wire = computeProvenanceV2({ apiKey, agentId });
    const result = verifyProvenanceV2({ apiKey, agentId, claimed: wire });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.timestamp).toBeGreaterThan(0);
      expect(result.nonce.length).toBeGreaterThanOrEqual(16);
    }
  });

  it('rejects wrong api_key as hmac_mismatch', () => {
    const wire = computeProvenanceV2({ apiKey: 'real-key', agentId });
    const result = verifyProvenanceV2({ apiKey: 'attacker-key', agentId, claimed: wire });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.subcause).toBe('hmac_mismatch');
  });

  it('rejects malformed wire (no v2 prefix, non-64-hex)', () => {
    const result = verifyProvenanceV2({ apiKey, agentId, claimed: 'not-v2-format' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.subcause).toBe('wire_malformed');
  });

  it('detects v1 hash and labels v1_legacy_mismatch', () => {
    const v1 = computeProvenanceV1({ apiKey, agentId, totalCalls: 0 });
    const result = verifyProvenanceV2({ apiKey, agentId, claimed: v1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.subcause).toBe('v1_legacy_mismatch');
  });

  it('rejects stale timestamp as clock_skew', () => {
    const stale = Math.floor(Date.now() / 1000) - 3600;
    const wire = computeProvenanceV2({
      apiKey, agentId, timestamp: stale, nonce: 'deadbeef0123456789abcdef01234567',
    });
    const result = verifyProvenanceV2({ apiKey, agentId, claimed: wire });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.subcause).toBe('clock_skew');
      expect(result.detail).toMatch(/drift=/);
    }
  });

  it('rejects wire with wrong number of parts as wire_malformed', () => {
    const result = verifyProvenanceV2({ apiKey, agentId, claimed: 'v2:123:abc' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.subcause).toBe('wire_malformed');
  });

  it('rejects nonce shorter than 16 hex chars', () => {
    const wire = `v2:${Math.floor(Date.now() / 1000)}:abc:${'0'.repeat(64)}`;
    const result = verifyProvenanceV2({ apiKey, agentId, claimed: wire });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.subcause).toBe('wire_malformed');
  });

  it('honours injectable now() for testability', () => {
    const fixed = 1762689600;
    const wire = computeProvenanceV2({ apiKey, agentId, timestamp: fixed });
    // 10 years later → should be way out of skew
    const result = verifyProvenanceV2({
      apiKey, agentId, claimed: wire,
      now: () => fixed + 60 * 60 * 24 * 365 * 10,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.subcause).toBe('clock_skew');
  });
});

describe('createReplayCache', () => {
  it('first observation is "first"', () => {
    const c = createReplayCache();
    expect(c.checkAndInsert('agent-a', 'nonce-1')).toBe('first');
  });

  it('second observation within ttl is "replay"', () => {
    const c = createReplayCache({ ttlSec: 600 });
    expect(c.checkAndInsert('agent-a', 'nonce-1')).toBe('first');
    expect(c.checkAndInsert('agent-a', 'nonce-1')).toBe('replay');
  });

  it('different agents same nonce are independent', () => {
    const c = createReplayCache({ ttlSec: 600 });
    expect(c.checkAndInsert('agent-a', 'shared-nonce')).toBe('first');
    expect(c.checkAndInsert('agent-b', 'shared-nonce')).toBe('first');
    expect(c.checkAndInsert('agent-a', 'shared-nonce')).toBe('replay');
  });

  it('observation after ttl expiry is "first" again', () => {
    let t = 1_000_000;
    const c = createReplayCache({ ttlSec: 60, now: () => t });
    expect(c.checkAndInsert('agent-a', 'nonce-1')).toBe('first');
    t += 30_000; // 30s elapsed
    expect(c.checkAndInsert('agent-a', 'nonce-1')).toBe('replay');
    t += 31_000; // total 61s elapsed > 60s ttl
    expect(c.checkAndInsert('agent-a', 'nonce-1')).toBe('first');
  });

  it('lowercase normalises nonce comparison', () => {
    const c = createReplayCache({ ttlSec: 600 });
    expect(c.checkAndInsert('agent-a', 'ABCDEF12')).toBe('first');
    expect(c.checkAndInsert('agent-a', 'abcdef12')).toBe('replay');
    expect(c.checkAndInsert('agent-a', 'AbCdEf12')).toBe('replay');
  });
});
