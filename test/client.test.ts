import { describe, it, expect, vi } from 'vitest';
import { JecpClient } from '../src/client.js';
import {
  JecpError,
  InsufficientBalanceError,
  CapabilityNotFoundError,
  RateLimitError,
} from '../src/errors.js';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

const successEnvelope = {
  jecp: '1.0',
  id: 'r1',
  status: 'success',
  result: { translated: 'こんにちは' },
  provider: { namespace: 'deepl', capability: 'translate', version: '1.0.0' },
  billing: {
    charged: true,
    amount_usdc: 0.005,
    balance_after: 19.995,
    transaction_id: 'tx-1',
  },
  wallet_balance_after: 19.995,
};

describe('JecpClient — basics', () => {
  it('throws on missing credentials', () => {
    expect(() => new JecpClient({ agentId: '', apiKey: 'x' })).toThrow();
    expect(() => new JecpClient({ agentId: 'x', apiKey: '' })).toThrow();
  });

  it('exposes baseUrl and trims trailing slash', () => {
    const c = new JecpClient({
      agentId: 'jdb_ag_test',
      apiKey: 'jdb_ak_test',
      baseUrl: 'https://example.com/',
    });
    expect(c.baseUrl).toBe('https://example.com');
  });

  it('invoke() returns parsed result with attempts=0 + request_id', async () => {
    const fakeFetch = async () => jsonResponse(successEnvelope);
    const c = new JecpClient({
      agentId: 'jdb_ag_test',
      apiKey: 'jdb_ak_test',
      fetch: fakeFetch as unknown as typeof fetch,
    });

    const result = await c.invoke('deepl/translate', 'translate', {
      text: 'Hello', target_lang: 'JA',
    });

    expect(result.output).toEqual({ translated: 'こんにちは' });
    expect(result.billing.charged).toBe(true);
    expect(result.wallet_balance_after).toBe(19.995);
    expect(result.attempts).toBe(0);
    expect(result.request_id).toBeDefined();
    expect(result.request_id.length).toBeGreaterThan(0);
  });

  it('invoke() honors options.requestId', async () => {
    let captured = '';
    const fakeFetch = async (_url: string, init?: RequestInit) => {
      captured = (init?.body as string) ?? '';
      return jsonResponse(successEnvelope);
    };
    const c = new JecpClient({
      agentId: 'jdb_ag_test', apiKey: 'jdb_ak_test',
      fetch: fakeFetch as unknown as typeof fetch,
    });
    await c.invoke('a/b', 'c', {}, { requestId: 'my-custom-id-42' });
    const sent = JSON.parse(captured);
    expect(sent.id).toBe('my-custom-id-42');
  });

  it('invoke() builds mandate with agent credentials', async () => {
    let captured = '';
    const fakeFetch = async (_url: string, init?: RequestInit) => {
      captured = (init?.body as string) ?? '';
      return jsonResponse(successEnvelope);
    };
    const c = new JecpClient({
      agentId: 'jdb_ag_test', apiKey: 'jdb_ak_test',
      fetch: fakeFetch as unknown as typeof fetch,
    });
    await c.invoke('a/b', 'c', {}, { mandate: { budget_usdc: 5.0 } });
    const sent = JSON.parse(captured);
    expect(sent.mandate.agent_id).toBe('jdb_ag_test');
    expect(sent.mandate.api_key).toBe('jdb_ak_test');
    expect(sent.mandate.budget_usdc).toBe(5.0);
  });

  it('invoke() passes through full Mandate object verbatim', async () => {
    let captured = '';
    const fakeFetch = async (_url: string, init?: RequestInit) => {
      captured = (init?.body as string) ?? '';
      return jsonResponse(successEnvelope);
    };
    const c = new JecpClient({
      agentId: 'jdb_ag_test', apiKey: 'jdb_ak_test',
      fetch: fakeFetch as unknown as typeof fetch,
    });
    await c.invoke('a/b', 'c', {}, {
      mandate: {
        agent_id: 'override_ag',
        api_key: 'override_ak',
        budget_usdc: 99.0,
        provenance_hash: 'sha256-xxx',
      },
    });
    const sent = JSON.parse(captured);
    expect(sent.mandate.agent_id).toBe('override_ag');
    expect(sent.mandate.api_key).toBe('override_ak');
    expect(sent.mandate.provenance_hash).toBe('sha256-xxx');
  });
});

describe('JecpClient — error mapping', () => {
  it('maps 402 → InsufficientBalanceError with next_action', async () => {
    const fakeFetch = async () =>
      jsonResponse(
        {
          jecp: '1.0', status: 'failed',
          error: { code: 'INSUFFICIENT_BALANCE', message: 'wallet 0 USDC < 0.005' },
          next_action: { type: 'topup', api: 'https://jecp.dev/api/agents/topup' },
        },
        402,
      );

    const c = new JecpClient({
      agentId: 'a', apiKey: 'b',
      fetch: fakeFetch as unknown as typeof fetch,
      retryConfig: { maxRetries: 0 },
    });

    try {
      await c.invoke('any/cap', 'any-action', {});
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(InsufficientBalanceError);
      const err = e as InsufficientBalanceError;
      expect(err.code).toBe('INSUFFICIENT_BALANCE');
      expect(err.status).toBe(402);
      if (err.nextAction?.type === 'topup') {
        expect(err.nextAction.api).toBe('https://jecp.dev/api/agents/topup');
      }
    }
  });

  it('maps 404 → CapabilityNotFoundError', async () => {
    const fakeFetch = async () =>
      jsonResponse(
        { jecp: '1.0', status: 'failed',
          error: { code: 'CAPABILITY_NOT_FOUND', message: 'fake/x not found' } },
        404,
      );
    const c = new JecpClient({
      agentId: 'a', apiKey: 'b',
      fetch: fakeFetch as unknown as typeof fetch,
      retryConfig: { maxRetries: 0 },
    });
    await expect(c.invoke('fake/x', 'y', {})).rejects.toBeInstanceOf(CapabilityNotFoundError);
  });
});

describe('JecpClient — auto-retry', () => {
  it('retries 5xx and succeeds', async () => {
    let calls = 0;
    const fakeFetch = vi.fn(async () => {
      calls++;
      if (calls < 3) {
        return jsonResponse({ status: 'failed', error: { code: 'INTERNAL', message: 'oops' } }, 500);
      }
      return jsonResponse(successEnvelope);
    });

    const c = new JecpClient({
      agentId: 'a', apiKey: 'b',
      fetch: fakeFetch as unknown as typeof fetch,
      retryConfig: { initialDelayMs: 1, maxDelayMs: 10, jitterFactor: 0 },
    });
    const r = await c.invoke('a/b', 'c', {});
    expect(r.attempts).toBe(2);   // failed twice, succeeded on 3rd (attempt index 2)
    expect(calls).toBe(3);
  });

  it('does NOT retry on 4xx (except 408/429)', async () => {
    let calls = 0;
    const fakeFetch = vi.fn(async () => {
      calls++;
      return jsonResponse(
        { status: 'failed', error: { code: 'INSUFFICIENT_BALANCE', message: 'x' } },
        402,
      );
    });
    const c = new JecpClient({
      agentId: 'a', apiKey: 'b',
      fetch: fakeFetch as unknown as typeof fetch,
      retryConfig: { initialDelayMs: 1, jitterFactor: 0 },
    });
    await expect(c.invoke('a/b', 'c', {})).rejects.toBeInstanceOf(InsufficientBalanceError);
    expect(calls).toBe(1);
  });

  it('retries 429 RateLimitError', async () => {
    let calls = 0;
    const fakeFetch = vi.fn(async () => {
      calls++;
      if (calls === 1) {
        return jsonResponse(
          { status: 'failed', error: { code: 'RATE_LIMITED', message: 'too many' } },
          429,
        );
      }
      return jsonResponse(successEnvelope);
    });
    const c = new JecpClient({
      agentId: 'a', apiKey: 'b',
      fetch: fakeFetch as unknown as typeof fetch,
      retryConfig: { initialDelayMs: 1, jitterFactor: 0 },
    });
    const r = await c.invoke('a/b', 'c', {});
    expect(r.attempts).toBe(1);
    expect(calls).toBe(2);
  });

  it('throws after maxRetries exhausted', async () => {
    let calls = 0;
    const fakeFetch = vi.fn(async () => {
      calls++;
      return jsonResponse({ status: 'failed', error: { code: 'INTERNAL', message: 'x' } }, 503);
    });
    const c = new JecpClient({
      agentId: 'a', apiKey: 'b',
      fetch: fakeFetch as unknown as typeof fetch,
      retryConfig: { maxRetries: 2, initialDelayMs: 1, jitterFactor: 0 },
    });
    await expect(c.invoke('a/b', 'c', {})).rejects.toBeInstanceOf(JecpError);
    expect(calls).toBe(3);  // initial + 2 retries
  });

  it('preserves the SAME request_id across retries (idempotency)', async () => {
    const ids: string[] = [];
    let calls = 0;
    const fakeFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      calls++;
      const body = JSON.parse((init?.body as string) ?? '{}');
      ids.push(body.id);
      if (calls < 3) {
        return jsonResponse({ status: 'failed', error: { code: 'INTERNAL', message: 'x' } }, 500);
      }
      return jsonResponse(successEnvelope);
    });
    const c = new JecpClient({
      agentId: 'a', apiKey: 'b',
      fetch: fakeFetch as unknown as typeof fetch,
      retryConfig: { initialDelayMs: 1, jitterFactor: 0 },
    });
    await c.invoke('a/b', 'c', {});
    expect(ids).toHaveLength(3);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[1]).toBe(ids[2]);
  });

  it('honors Retry-After header on 429', async () => {
    let calls = 0;
    const start = Date.now();
    const fakeFetch = vi.fn(async () => {
      calls++;
      if (calls === 1) {
        return jsonResponse(
          { status: 'failed', error: { code: 'RATE_LIMITED', message: 'x' } },
          429,
          { 'Retry-After': '1' },
        );
      }
      return jsonResponse(successEnvelope);
    });
    const c = new JecpClient({
      agentId: 'a', apiKey: 'b',
      fetch: fakeFetch as unknown as typeof fetch,
      retryConfig: { initialDelayMs: 1, jitterFactor: 0 },
    });
    await c.invoke('a/b', 'c', {});
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(900);  // honored 1s Retry-After (allow 100ms slack)
  });
});

describe('JecpClient — abort + timeout', () => {
  it('aborts mid-flight when external signal fires', async () => {
    const fakeFetch = async (_url: string, init?: RequestInit) => {
      // Simulate hanging fetch
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    };
    const c = new JecpClient({
      agentId: 'a', apiKey: 'b',
      fetch: fakeFetch as unknown as typeof fetch,
      retryConfig: { maxRetries: 0 },
    });

    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 20);
    try {
      await c.invoke('a/b', 'c', {}, { signal: ctl.signal });
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(JecpError);
      // Code can be either ABORTED or NETWORK_ERROR depending on order
      expect(['ABORTED', 'NETWORK_ERROR']).toContain((e as JecpError).code);
    }
  });

  it('times out after timeoutMs', async () => {
    const fakeFetch = async (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('timed out');
          err.name = 'AbortError';
          reject(err);
        });
      });
    const c = new JecpClient({
      agentId: 'a', apiKey: 'b',
      fetch: fakeFetch as unknown as typeof fetch,
      timeoutMs: 30,
      retryConfig: { maxRetries: 0 },
    });
    const start = Date.now();
    try {
      await c.invoke('a/b', 'c', {});
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(JecpError);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(200);   // not waiting forever
    }
  });

  it('per-call timeout overrides client default', async () => {
    let timeoutSeen = 0;
    const fakeFetch = async (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const t = setTimeout(() => {
          timeoutSeen = Date.now();
          reject(new Error('done'));
        }, 50);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(t);
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    const c = new JecpClient({
      agentId: 'a', apiKey: 'b',
      fetch: fakeFetch as unknown as typeof fetch,
      timeoutMs: 200,
      retryConfig: { maxRetries: 0 },
    });
    const start = Date.now();
    try {
      await c.invoke('a/b', 'c', {}, { timeoutMs: 10 });
      expect.fail('should have thrown');
    } catch {
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(50);  // per-call 10ms beat default 200ms
    }
    expect(timeoutSeen).toBe(0);  // never reached the 50ms in fakeFetch
  });
});

describe('JecpClient — topup validation', () => {
  it('rejects amounts other than 5/20/100', async () => {
    const c = new JecpClient({ agentId: 'a', apiKey: 'b' });
    // @ts-expect-error wrong type intentionally
    await expect(c.topup(7)).rejects.toThrow('amount must be 5, 20, or 100');
  });
});

describe('JecpClient — logger', () => {
  it('calls logger.warn on retry attempt', async () => {
    const warnings: string[] = [];
    let calls = 0;
    const fakeFetch = async () => {
      calls++;
      if (calls < 2) return jsonResponse({ status: 'failed', error: { code: 'X', message: 'x' } }, 503);
      return jsonResponse(successEnvelope);
    };
    const c = new JecpClient({
      agentId: 'a', apiKey: 'b',
      fetch: fakeFetch as unknown as typeof fetch,
      retryConfig: { initialDelayMs: 1, jitterFactor: 0 },
      logger: { warn: (m) => warnings.push(m) },
    });
    await c.invoke('a/b', 'c', {});
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toMatch(/retrying/);
  });

  it('calls logger.error on terminal failure', async () => {
    const errors: string[] = [];
    const fakeFetch = async () =>
      jsonResponse({ status: 'failed', error: { code: 'INSUFFICIENT_BALANCE', message: 'x' } }, 402);
    const c = new JecpClient({
      agentId: 'a', apiKey: 'b',
      fetch: fakeFetch as unknown as typeof fetch,
      retryConfig: { maxRetries: 0 },
      logger: { error: (m) => errors.push(m) },
    });
    await expect(c.invoke('a/b', 'c', {})).rejects.toBeInstanceOf(InsufficientBalanceError);
    expect(errors.length).toBe(1);
    expect(errors[0]).toMatch(/failed/);
  });
});

describe('JecpClient — catalog pagination (W3)', () => {
  it('catalog() passes pageSize / namespace / tags as query params', async () => {
    let capturedUrl = '';
    const fakeFetch = async (url: string, _init?: RequestInit) => {
      capturedUrl = url;
      return new Response(
        JSON.stringify({ jecp: '1.0', engine: 'jecp', capabilities: [], next_cursor: null, has_more: false }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };
    const c = new JecpClient({
      agentId: 'a', apiKey: 'b',
      fetch: fakeFetch as unknown as typeof fetch,
    });
    await c.catalog({ pageSize: 100, namespace: 'jobdonebot', tags: ['image', 'pdf'] });
    expect(capturedUrl).toContain('page_size=100');
    expect(capturedUrl).toContain('namespace=jobdonebot');
    expect(capturedUrl).toContain('tags=image%2Cpdf');
  });

  it('catalogPages() iterates until no more pages', async () => {
    let calls = 0;
    const fakeFetch = async (_url: string) => {
      calls++;
      if (calls === 1) {
        return new Response(JSON.stringify({
          jecp: '1.0', engine: 'jecp', capabilities: [],
          third_party_capabilities: [{ id: 'a/b' }],
          next_cursor: 'CURSOR_A', has_more: true, page_size: 1,
        }), { status: 200 });
      }
      if (calls === 2) {
        return new Response(JSON.stringify({
          jecp: '1.0', engine: 'jecp', capabilities: [],
          third_party_capabilities: [{ id: 'c/d' }],
          next_cursor: 'CURSOR_B', has_more: true, page_size: 1,
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        jecp: '1.0', engine: 'jecp', capabilities: [],
        third_party_capabilities: [{ id: 'e/f' }],
        next_cursor: null, has_more: false, page_size: 1,
      }), { status: 200 });
    };
    const c = new JecpClient({
      agentId: 'a', apiKey: 'b',
      fetch: fakeFetch as unknown as typeof fetch,
    });
    const ids: string[] = [];
    for await (const page of c.catalogPages({ pageSize: 1 })) {
      for (const cap of (page.third_party_capabilities ?? []) as { id: string }[]) {
        ids.push(cap.id);
      }
    }
    expect(ids).toEqual(['a/b', 'c/d', 'e/f']);
    expect(calls).toBe(3);
  });

  it('catalogAll() uses paginated=false', async () => {
    let capturedUrl = '';
    const fakeFetch = async (url: string) => {
      capturedUrl = url;
      return new Response(JSON.stringify({ jecp: '1.0', engine: 'jecp', capabilities: [] }), { status: 200 });
    };
    const c = new JecpClient({
      agentId: 'a', apiKey: 'b',
      fetch: fakeFetch as unknown as typeof fetch,
    });
    await c.catalogAll();
    expect(capturedUrl).toContain('paginated=false');
  });
});
