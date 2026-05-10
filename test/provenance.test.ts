import { describe, it, expect } from 'vitest';
import { createHmac, createHash } from 'node:crypto';
import {
  computeProvenanceV2,
  computeProvenanceV1,
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
