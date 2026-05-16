/**
 * Hand-rolled validator tests against the JECP manifest schema (v0.9.0).
 *
 * Ported 1:1 from `@jecpdev/cli`'s `test/manifest-validate.test.ts` since
 * the validator code itself is the same — both sides MUST behave identically
 * so operators see the same errors locally as the Hub returns.
 */

import { describe, it, expect } from 'vitest';
import { validateManifest } from '../src/lib/manifest-validate.js';

const validMinimal = {
  namespace: 'example',
  display_name: 'Example Co',
  capability: 'translate',
  version: '1.0.0',
  description: 'Translates text.',
  endpoint: 'https://example.com/jecp',
  actions: [
    {
      id: 'translate',
      description: 'Translate text.',
      pricing: { base: '$0.005', currency: 'USDC', model: 'per_call' },
      input_schema: { type: 'object' },
      output_schema: { type: 'object' },
    },
  ],
};

describe('validateManifest — happy path', () => {
  it('accepts the minimal valid fixture', () => {
    const r = validateManifest(validMinimal);
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('accepts a manifest with all optional fields filled', () => {
    const full = {
      ...validMinimal,
      website: 'https://example.com',
      support_email: 'ops@example.com',
      tags: ['translation', 'language'],
      streaming: false,
      authentication: { type: 'api_key', header_name: 'x-jecp-signature' },
      compliance: {
        pii_handling: 'process_only_no_store',
        gdpr_compliant: true,
        data_residency: ['US', 'JP'],
      },
      billing: { payout_currency: 'USD', stripe_connect_required: true },
      deprecation: { status: 'active' },
      metadata: { internal_id: 'team-7' },
      extensions: { usdc_payout_address: '0xabcd' },
    };
    const r = validateManifest(full);
    expect(r.valid).toBe(true);
  });
});

describe('validateManifest — required fields', () => {
  it('flags missing namespace', () => {
    const m = { ...validMinimal } as Record<string, unknown>;
    delete m.namespace;
    const r = validateManifest(m);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.reason.includes("'namespace'"))).toBe(true);
  });

  it('flags empty actions array (minItems: 1)', () => {
    const r = validateManifest({ ...validMinimal, actions: [] });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.reason.match(/min is 1/i))).toBe(true);
  });

  it('flags missing action.pricing', () => {
    const m = {
      ...validMinimal,
      actions: [{ id: 'a', description: 'd', input_schema: {}, output_schema: {} }],
    };
    const r = validateManifest(m);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.reason.includes("'pricing'"))).toBe(true);
  });
});

describe('validateManifest — pattern + enum violations', () => {
  it('rejects uppercase / digit-leading namespace', () => {
    const r = validateManifest({ ...validMinimal, namespace: '1Invalid' });
    expect(r.valid).toBe(false);
    const e = r.errors.find((x) => x.instance_path === '/namespace');
    expect(e?.reason).toMatch(/pattern/);
  });

  it('rejects non-https endpoint', () => {
    const r = validateManifest({ ...validMinimal, endpoint: 'http://example.com/jecp' });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.instance_path === '/endpoint' && e.reason.match(/https/))).toBe(true);
  });

  it('rejects non-semver version', () => {
    const r = validateManifest({ ...validMinimal, version: 'v1.0' });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.instance_path === '/version')).toBe(true);
  });

  it('rejects unknown pricing model (enum)', () => {
    const m = {
      ...validMinimal,
      actions: [
        {
          ...validMinimal.actions[0],
          pricing: { base: '$0.005', currency: 'USDC', model: 'subscription' },
        },
      ],
    };
    const r = validateManifest(m);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.reason.match(/per_call|per_token/))).toBe(true);
  });

  it('rejects unsupported trust_tier value', () => {
    const m = {
      ...validMinimal,
      actions: [
        { ...validMinimal.actions[0], trust_tier_required: 'diamond' },
      ],
    };
    const r = validateManifest(m);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.reason.match(/bronze|silver|gold|platinum/))).toBe(true);
  });
});

describe('validateManifest — type mismatches', () => {
  it('rejects pricing.base as number (must be string like "$0.005")', () => {
    const m = {
      ...validMinimal,
      actions: [
        {
          ...validMinimal.actions[0],
          pricing: { base: 0.005, currency: 'USDC', model: 'per_call' },
        },
      ],
    };
    const r = validateManifest(m);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.reason.match(/expected string/))).toBe(true);
  });

  it('rejects tags as comma-separated string instead of array', () => {
    const r = validateManifest({ ...validMinimal, tags: 'a,b,c' });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.instance_path === '/tags' && e.reason.match(/expected array/))).toBe(true);
  });
});

describe('validateManifest — composes/streaming xor', () => {
  it('rejects an action that sets both streaming and composes', () => {
    const m = {
      ...validMinimal,
      actions: [
        {
          ...validMinimal.actions[0],
          streaming: true,
          composes: { steps: [{ id: 's1', call: 'a/b', action: 'c', input: {} }] },
        },
      ],
    };
    const r = validateManifest(m);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.reason.match(/cannot all be set together/))).toBe(true);
  });

  it('accepts an action with only streaming', () => {
    const m = {
      ...validMinimal,
      actions: [{ ...validMinimal.actions[0], streaming: true }],
    };
    const r = validateManifest(m);
    expect(r.valid).toBe(true);
  });

  it('accepts an action with only composes', () => {
    const m = {
      ...validMinimal,
      actions: [
        {
          ...validMinimal.actions[0],
          composes: { steps: [{ id: 's1', call: 'a/b', action: 'c', input: {} }] },
        },
      ],
    };
    const r = validateManifest(m);
    expect(r.valid).toBe(true);
  });
});

describe('validateManifest — additionalProperties: false catches typos', () => {
  it('rejects an unknown top-level field (catches typos)', () => {
    const r = validateManifest({ ...validMinimal, descripshun: 'typo' });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.reason.match(/unknown property 'descripshun'/))).toBe(true);
  });

  it('rejects unknown property inside pricing block', () => {
    const m = {
      ...validMinimal,
      actions: [
        {
          ...validMinimal.actions[0],
          pricing: {
            base: '$0.005',
            currency: 'USDC',
            model: 'per_call',
            payment_method: 'card', // not a known property
          },
        },
      ],
    };
    const r = validateManifest(m);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.reason.match(/unknown property 'payment_method'/))).toBe(true);
  });
});

describe('validateManifest — error shape matches Hub INPUT_SCHEMA_VIOLATION', () => {
  it('each error carries instance_path, schema_path, reason', () => {
    const r = validateManifest({ ...validMinimal, namespace: '1bad' });
    expect(r.errors.length).toBeGreaterThan(0);
    for (const e of r.errors) {
      expect(typeof e.instance_path).toBe('string');
      expect(typeof e.schema_path).toBe('string');
      expect(typeof e.reason).toBe('string');
      expect(e.reason.length).toBeGreaterThan(0);
    }
  });

  it('instance_path is a usable JSON pointer (leading slash, segments joined by /)', () => {
    const m = {
      ...validMinimal,
      actions: [{ ...validMinimal.actions[0], id: '1bad-action-id' }],
    };
    const r = validateManifest(m);
    const e = r.errors.find((x) => x.instance_path.includes('actions'));
    expect(e?.instance_path).toMatch(/^\/actions\/\d+\/id$/);
  });
});
