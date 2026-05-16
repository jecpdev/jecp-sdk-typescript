/**
 * JecpProviderClient (v0.9.0) — outbound Provider admin endpoints.
 *
 * Strategy: inject a fake `fetch` per test so we never hit the network and
 * can assert on the exact request the SDK sends (URL, headers, body) as
 * well as the exception shape on error responses. This mirrors the CLI's
 * `test/provider.test.ts` structure so divergence between the two surfaces
 * is easy to spot in code review.
 */

import { describe, it, expect, vi } from 'vitest';
import { JecpProviderClient } from '../src/provider-client.js';
import {
  JecpError,
  NamespaceTakenError,
  UnsupportedCountryError,
  RotationCapError,
  ManifestParseError,
  ManifestVersionExistsError,
  AuthError,
} from '../src/errors.js';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

const REGISTER_BODY = {
  provider_id: 'prov_abc123',
  namespace: 'tester',
  provider_api_key: 'jdb_pk_' + 'a'.repeat(48),
  hmac_secret: 'YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYQ==',
  dns_verification_token: 'tok_xyz',
  next_steps: { dns_txt: { name: '_jecp.tester.example', value: 'jecp-verify=tok_xyz' } },
};

describe('JecpProviderClient — construction', () => {
  it('requires providerApiKey', () => {
    // @ts-expect-error - testing runtime guard
    expect(() => new JecpProviderClient({})).toThrow(/providerApiKey/);
  });

  it('trims trailing slashes off baseUrl', () => {
    const c = new JecpProviderClient({
      providerApiKey: 'jdb_pk_x',
      baseUrl: 'https://hub.example/',
    });
    expect(c.baseUrl).toBe('https://hub.example');
  });
});

describe('JecpProviderClient.register (static)', () => {
  it('returns the response envelope on 201 without persisting state in the SDK', async () => {
    let captured: { url?: string; init?: RequestInit } = {};
    const fakeFetch = async (url: string | URL, init?: RequestInit) => {
      captured = { url: String(url), init };
      return jsonResponse(REGISTER_BODY, 201);
    };
    const r = await JecpProviderClient.register(
      {
        namespace: 'tester',
        display_name: 'Tester Co',
        owner_email: 'ops@tester.example',
        endpoint_url: 'https://tester.example/jecp',
        country: 'JP',
      },
      'https://hub.example',
      fakeFetch as unknown as typeof fetch,
    );

    expect(r.provider_id).toBe('prov_abc123');
    expect(r.namespace).toBe('tester');
    expect(r.provider_api_key).toMatch(/^jdb_pk_/);
    expect(captured.url).toBe('https://hub.example/v1/providers/register');
    // No global state — caller must persist creds themselves.
  });

  it('maps NAMESPACE_TAKEN (409) to NamespaceTakenError', async () => {
    const fakeFetch = async () =>
      jsonResponse(
        { error: { code: 'NAMESPACE_TAKEN', message: "namespace 'tester' is already registered" } },
        409,
      );
    await expect(
      JecpProviderClient.register(
        {
          namespace: 'tester',
          display_name: 'T',
          owner_email: 'o@t.example',
          endpoint_url: 'https://t.example/j',
          country: 'JP',
        },
        'https://hub.example',
        fakeFetch as unknown as typeof fetch,
      ),
    ).rejects.toBeInstanceOf(NamespaceTakenError);
  });

  it('uppercases country and lowercases usdc_payout_address before sending', async () => {
    let body: Record<string, unknown> = {};
    const fakeFetch = async (_url: string | URL, init?: RequestInit) => {
      body = JSON.parse((init?.body as string) ?? '{}');
      return jsonResponse(REGISTER_BODY, 201);
    };
    await JecpProviderClient.register(
      {
        namespace: 'Tester2',
        display_name: 'T',
        owner_email: 'o@t.example',
        endpoint_url: 'https://t.example/j',
        country: 'us',
        usdc_payout_address: '0xABBA' + 'C'.repeat(36),
      },
      'https://hub.example',
      fakeFetch as unknown as typeof fetch,
    );
    expect(body.country).toBe('US');
    expect(body.namespace).toBe('tester2'); // namespace lowercased too
    expect(body.usdc_payout_address).toBe('0xabba' + 'c'.repeat(36));
  });

  it('maps UNSUPPORTED_COUNTRY (400) to UnsupportedCountryError', async () => {
    const fakeFetch = async () =>
      jsonResponse(
        { error: { code: 'UNSUPPORTED_COUNTRY', message: 'country XX not supported by Stripe Connect' } },
        400,
      );
    await expect(
      JecpProviderClient.register(
        {
          namespace: 'tester',
          display_name: 'T',
          owner_email: 'o@t.example',
          endpoint_url: 'https://t.example/j',
          country: 'XX',
        },
        'https://hub.example',
        fakeFetch as unknown as typeof fetch,
      ),
    ).rejects.toBeInstanceOf(UnsupportedCountryError);
  });
});

describe('JecpProviderClient.me', () => {
  it('GETs /v1/providers/me and parses the envelope', async () => {
    let captured: { url?: string; init?: RequestInit } = {};
    const fakeFetch = async (url: string | URL, init?: RequestInit) => {
      captured = { url: String(url), init };
      return jsonResponse({
        provider_id: 'p',
        namespace: 'ns',
        display_name: 'NS Co',
        status: 'active',
        dns_verified: true,
        stripe_verified: false,
        endpoint_url: 'https://ns.example/jecp',
        total_calls: 42,
      });
    };
    const c = new JecpProviderClient({
      providerApiKey: 'jdb_pk_test',
      baseUrl: 'https://hub.example',
      fetch: fakeFetch as unknown as typeof fetch,
    });
    const me = await c.me();
    expect(me.namespace).toBe('ns');
    expect(me.total_calls).toBe(42);
    expect(captured.url).toBe('https://hub.example/v1/providers/me');
    expect((captured.init?.headers as Record<string, string>).Authorization).toBe('Bearer jdb_pk_test');
    expect(captured.init?.method).toBe('GET');
  });

  it('maps 401 AUTH_REQUIRED to AuthError', async () => {
    const fakeFetch = async () =>
      jsonResponse(
        { error: { code: 'AUTH_REQUIRED', message: 'missing provider api key' } },
        401,
      );
    const c = new JecpProviderClient({
      providerApiKey: 'jdb_pk_test',
      fetch: fakeFetch as unknown as typeof fetch,
    });
    await expect(c.me()).rejects.toBeInstanceOf(AuthError);
  });
});

describe('JecpProviderClient.verifyDns', () => {
  it('returns the verified envelope when Hub confirms', async () => {
    const fakeFetch = async () =>
      jsonResponse({ verified: true, status: 'verified', message: 'ok' });
    const c = new JecpProviderClient({
      providerApiKey: 'jdb_pk_test',
      fetch: fakeFetch as unknown as typeof fetch,
    });
    const r = await c.verifyDns({ once: true });
    expect(r.verified).toBe(true);
    expect(r.status).toBe('verified');
  });

  it('treats 4xx (non-auth) as "not yet verified" instead of throwing', async () => {
    // 404 DNS_NOT_VERIFIED is the normal "still propagating" path — must NOT
    // throw, or callers will need a try/catch around every poll attempt.
    const fakeFetch = async () =>
      jsonResponse(
        { error: { code: 'DNS_NOT_VERIFIED', message: 'TXT not found at _jecp.tester.example' } },
        404,
      );
    const c = new JecpProviderClient({
      providerApiKey: 'jdb_pk_test',
      fetch: fakeFetch as unknown as typeof fetch,
    });
    const r = await c.verifyDns();
    expect(r.verified).toBe(false);
    expect(r.status).toBe('DNS_NOT_VERIFIED');
    expect(r.message).toMatch(/TXT not found/);
  });

  it('throws AuthError on 401 (a bad key should NOT be silently polled forever)', async () => {
    const fakeFetch = async () =>
      jsonResponse(
        { error: { code: 'AUTH_REQUIRED', message: 'missing provider api key' } },
        401,
      );
    const c = new JecpProviderClient({
      providerApiKey: 'jdb_pk_wrong',
      fetch: fakeFetch as unknown as typeof fetch,
    });
    await expect(c.verifyDns()).rejects.toBeInstanceOf(AuthError);
  });

  it('throws JecpError on 5xx (Hub internal failure surfaces, not silent)', async () => {
    const fakeFetch = async () =>
      jsonResponse({ error: { code: 'DB_ERROR', message: 'lookup failed' } }, 500);
    const c = new JecpProviderClient({
      providerApiKey: 'jdb_pk_test',
      fetch: fakeFetch as unknown as typeof fetch,
    });
    await expect(c.verifyDns()).rejects.toBeInstanceOf(JecpError);
  });
});

describe('JecpProviderClient.verifyDnsPoll', () => {
  it('keeps polling on 404 then resolves once verified — fake timers drive the loop', async () => {
    let call = 0;
    const fakeFetch = async () => {
      call++;
      if (call === 1) {
        return jsonResponse(
          { error: { code: 'DNS_NOT_VERIFIED', message: 'TXT not found' } },
          404,
        );
      }
      return jsonResponse({ verified: true, status: 'verified', message: 'ok' });
    };
    const c = new JecpProviderClient({
      providerApiKey: 'jdb_pk_test',
      fetch: fakeFetch as unknown as typeof fetch,
    });
    const observed: Array<[number, string]> = [];
    vi.useFakeTimers();
    const p = c.verifyDnsPoll({
      intervalMs: 5_000,
      timeoutMs: 60_000,
      onAttempt: (n, s) => observed.push([n, s]),
    });
    await vi.advanceTimersByTimeAsync(5_000);
    const r = await p;
    vi.useRealTimers();
    expect(r.verified).toBe(true);
    expect(call).toBe(2);
    expect(observed[0]).toEqual([1, 'DNS_NOT_VERIFIED']);
    expect(observed[1]).toEqual([2, 'verified']);
  });

  it('returns last (unverified) response on deadline rather than throwing', async () => {
    // intervalMs >= timeoutMs ensures the loop runs exactly one attempt and
    // then exits via the deadline break — covers the "long-tail DNS" case.
    const fakeFetch = async () =>
      jsonResponse(
        { error: { code: 'DNS_NOT_VERIFIED', message: 'TXT not found' } },
        404,
      );
    const c = new JecpProviderClient({
      providerApiKey: 'jdb_pk_test',
      fetch: fakeFetch as unknown as typeof fetch,
    });
    const r = await c.verifyDnsPoll({ intervalMs: 100, timeoutMs: 50 });
    expect(r.verified).toBe(false);
  });
});

describe('JecpProviderClient.publishManifest', () => {
  it('autodetects YAML and sends application/x-yaml', async () => {
    let captured: { init?: RequestInit } = {};
    const fakeFetch = async (_url: string | URL, init?: RequestInit) => {
      captured = { init };
      return jsonResponse(
        {
          capability_id: 'cap_abc',
          full_id: 'tester/hello',
          version: '1.0.0',
          status: 'active',
          action_count: 1,
          validation_warnings: [],
        },
        201,
      );
    };
    const c = new JecpProviderClient({
      providerApiKey: 'jdb_pk_test',
      fetch: fakeFetch as unknown as typeof fetch,
    });
    const yaml = 'namespace: tester\ncapability: hello\nversion: 1.0.0\n';
    const r = await c.publishManifest(yaml);
    expect(r.status).toBe('active');
    expect((captured.init?.headers as Record<string, string>)['Content-Type']).toBe(
      'application/x-yaml',
    );
    expect(captured.init?.body).toBe(yaml);
  });

  it('autodetects JSON manifest and sends application/json', async () => {
    let captured: { init?: RequestInit } = {};
    const fakeFetch = async (_url: string | URL, init?: RequestInit) => {
      captured = { init };
      return jsonResponse(
        {
          capability_id: 'cap_abc',
          full_id: 'tester/hello',
          version: '1.0.0',
          status: 'submitted',
          action_count: 1,
          validation_warnings: [],
        },
        201,
      );
    };
    const c = new JecpProviderClient({
      providerApiKey: 'jdb_pk_test',
      fetch: fakeFetch as unknown as typeof fetch,
    });
    const json = '  \n{"namespace":"tester","capability":"hello","version":"1.0.0"}';
    await c.publishManifest(json);
    expect((captured.init?.headers as Record<string, string>)['Content-Type']).toBe(
      'application/json',
    );
  });

  it('honors explicit contentType override', async () => {
    let captured: { init?: RequestInit } = {};
    const fakeFetch = async (_url: string | URL, init?: RequestInit) => {
      captured = { init };
      return jsonResponse(
        {
          capability_id: 'cap_abc',
          full_id: 'tester/hello',
          version: '1.0.0',
          status: 'active',
          action_count: 1,
          validation_warnings: [],
        },
        201,
      );
    };
    const c = new JecpProviderClient({
      providerApiKey: 'jdb_pk_test',
      fetch: fakeFetch as unknown as typeof fetch,
    });
    // A YAML payload that happens to start with `[` would otherwise be
    // misdetected as JSON; the override lets the caller force the right type.
    await c.publishManifest('[\n  "this is YAML flow sequence"\n]', {
      contentType: 'application/x-yaml',
    });
    expect((captured.init?.headers as Record<string, string>)['Content-Type']).toBe(
      'application/x-yaml',
    );
  });

  it('maps VERSION_EXISTS (409) to ManifestVersionExistsError', async () => {
    const fakeFetch = async () =>
      jsonResponse(
        {
          error: {
            code: 'VERSION_EXISTS',
            message: "capability 'tester/hello' version '1.0.0' is already published",
          },
        },
        409,
      );
    const c = new JecpProviderClient({
      providerApiKey: 'jdb_pk_test',
      fetch: fakeFetch as unknown as typeof fetch,
    });
    await expect(c.publishManifest('namespace: x\n')).rejects.toBeInstanceOf(
      ManifestVersionExistsError,
    );
  });

  it('maps PARSE_ERROR (400) to ManifestParseError', async () => {
    const fakeFetch = async () =>
      jsonResponse(
        { error: { code: 'PARSE_ERROR', message: 'YAML parse error at line 3' } },
        400,
      );
    const c = new JecpProviderClient({
      providerApiKey: 'jdb_pk_test',
      fetch: fakeFetch as unknown as typeof fetch,
    });
    await expect(c.publishManifest('not valid yaml: : :\n')).rejects.toBeInstanceOf(
      ManifestParseError,
    );
  });
});

describe('JecpProviderClient.rotateKey', () => {
  it('forwards revokeOld + graceSeconds in the request body', async () => {
    let body: Record<string, unknown> = {};
    const fakeFetch = async (_url: string | URL, init?: RequestInit) => {
      body = JSON.parse((init?.body as string) ?? '{}');
      return jsonResponse({
        jecp: '1.0',
        provider_id: 'prov_abc',
        namespace: 'tester',
        api_key: 'jdb_pk_new',
        api_key_prefix: 'jdb_pk_new_',
        previous_key_valid_until: null,
        grace_seconds: 0,
        revoke_old: true,
        rotations_in_last_24h: 2,
        warning: 'previous key revoked',
      });
    };
    const c = new JecpProviderClient({
      providerApiKey: 'jdb_pk_old',
      fetch: fakeFetch as unknown as typeof fetch,
    });
    const r = await c.rotateKey({ graceSeconds: 300, revokeOld: true });
    expect(body.grace_seconds).toBe(300);
    expect(body.revoke_old).toBe(true);
    expect(r.api_key).toBe('jdb_pk_new');
  });

  it('maps ROTATION_24H_CAP (429) to RotationCapError', async () => {
    const fakeFetch = async () =>
      jsonResponse(
        {
          error: {
            code: 'ROTATION_24H_CAP',
            message: 'Rotation limit exceeded (5 rotations in the last 24 h).',
          },
        },
        429,
      );
    const c = new JecpProviderClient({
      providerApiKey: 'jdb_pk_old',
      fetch: fakeFetch as unknown as typeof fetch,
    });
    await expect(c.rotateKey()).rejects.toBeInstanceOf(RotationCapError);
  });

  it('rejects graceSeconds outside [60, 604800] synchronously (no Hub roundtrip)', async () => {
    // No fakeFetch — if the validator fails to fire we'd hit a real network
    // call and the test would hang or error differently.
    const c = new JecpProviderClient({
      providerApiKey: 'jdb_pk_old',
      fetch: (async () => {
        throw new Error('should never be called');
      }) as unknown as typeof fetch,
    });
    await expect(c.rotateKey({ graceSeconds: 30 })).rejects.toThrow(/graceSeconds/);
    await expect(c.rotateKey({ graceSeconds: 604_801 })).rejects.toThrow(/graceSeconds/);
    await expect(c.rotateKey({ graceSeconds: 1.5 })).rejects.toThrow(/integer/);
  });
});

describe('JecpProviderClient.connectStripe', () => {
  it('POSTs and returns the onboarding URL', async () => {
    let captured: { url?: string; init?: RequestInit } = {};
    const fakeFetch = async (url: string | URL, init?: RequestInit) => {
      captured = { url: String(url), init };
      return jsonResponse({
        onboarding_url: 'https://connect.stripe.com/setup/abc',
        expires_at: 1_700_000_000,
      });
    };
    const c = new JecpProviderClient({
      providerApiKey: 'jdb_pk_test',
      baseUrl: 'https://hub.example',
      fetch: fakeFetch as unknown as typeof fetch,
    });
    const r = await c.connectStripe();
    expect(r.onboarding_url).toMatch(/^https:\/\/connect\.stripe\.com\//);
    expect(captured.url).toBe('https://hub.example/v1/providers/connect-stripe');
    expect(captured.init?.method).toBe('POST');
  });

  it('maps 401 to AuthError when the api_key is bad', async () => {
    const fakeFetch = async () =>
      jsonResponse(
        { error: { code: 'AUTH_REQUIRED', message: 'invalid api key' } },
        401,
      );
    const c = new JecpProviderClient({
      providerApiKey: 'jdb_pk_wrong',
      fetch: fakeFetch as unknown as typeof fetch,
    });
    await expect(c.connectStripe()).rejects.toBeInstanceOf(AuthError);
  });
});
