import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  computeProvenanceV2,
  verifyProvenanceV2,
} from '../src/provenance.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, 'fixtures', 'provenance-v2-vectors.json');

interface Vector {
  name: string;
}
interface ValidVector extends Vector {
  input: { api_key: string; agent_id: string; timestamp: number; nonce: string };
  expected_wire: string;
}
interface InvalidVector extends Vector {
  wire: string;
  input: { api_key: string; agent_id: string; now: number };
  expected_subcause: string;
}
interface SkewVector extends Vector {
  skew_offset_sec: number;
  expected_subcause: string | null;
}

interface Fixture {
  spec_version: string;
  description: string;
  valid: ValidVector[];
  invalid: InvalidVector[];
  clock_skew: SkewVector[];
}

const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as Fixture;

describe('Provenance v2 cross-stack fixture (jecp-spec/fixtures/provenance-v2-vectors.json)', () => {
  it('fixture is the v1.0.1 conformance set', () => {
    expect(fixture.spec_version).toBe('1.0.1');
    expect(fixture.valid.length).toBeGreaterThanOrEqual(3);
    expect(fixture.invalid.length).toBeGreaterThanOrEqual(7);
  });

  describe('valid vectors — compute_v2 must match expected_wire byte-for-byte', () => {
    fixture.valid.forEach((v) => {
      it(v.name, () => {
        const wire = computeProvenanceV2({
          apiKey:    v.input.api_key,
          agentId:   v.input.agent_id,
          timestamp: v.input.timestamp,
          nonce:     v.input.nonce,
        });
        expect(wire).toBe(v.expected_wire);
      });
    });
  });

  describe('invalid vectors — verifyProvenanceV2 must reject with the documented subcause', () => {
    fixture.invalid.forEach((v) => {
      it(v.name, () => {
        // Use a fixed `now` so wire-malformed cases aren't preempted by clock_skew.
        // `clockSkewSec` is set very large for the same reason — the cases that
        // SHOULD trigger clock_skew are in the dedicated block below.
        const result = verifyProvenanceV2({
          apiKey:       v.input.api_key,
          agentId:      v.input.agent_id,
          claimed:      v.wire,
          now:          () => v.input.now,
          clockSkewSec: Number.MAX_SAFE_INTEGER / 2,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.subcause).toBe(v.expected_subcause);
      });
    });
  });

  describe('clock_skew vectors — dynamic wire vs ±300s window', () => {
    const apiKey  = 'jdb_ak_skew_test';
    const agentId = 'jdb_ag_skew_test';
    const nonce   = 'abcdef0123456789abcdef0123456789';

    fixture.clock_skew.forEach((v) => {
      it(v.name, () => {
        const now = Math.floor(Date.now() / 1000);
        const wire = computeProvenanceV2({
          apiKey, agentId,
          timestamp: now + v.skew_offset_sec,
          nonce,
        });
        const result = verifyProvenanceV2({ apiKey, agentId, claimed: wire });
        if (v.expected_subcause === null) {
          expect(result.ok).toBe(true);
        } else {
          expect(result.ok).toBe(false);
          if (!result.ok) expect(result.subcause).toBe(v.expected_subcause);
        }
      });
    });
  });
});
