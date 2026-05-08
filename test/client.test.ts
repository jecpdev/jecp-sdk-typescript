import { describe, it, expect } from 'vitest';
import { JecpClient } from '../src/client.js';
import {
  JecpError,
  InsufficientBalanceError,
  CapabilityNotFoundError,
  RateLimitError,
} from '../src/errors.js';

describe('JecpClient', () => {
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

  it('invoke() uses fetch and returns parsed result', async () => {
    const fakeFetch = async () =>
      new Response(
        JSON.stringify({
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
            provider_share_usdc: 0.00425,
            hub_fee_usdc: 0.0005,
            payment_fee_usdc: 0.00025,
          },
          wallet_balance_after: 19.995,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );

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
    expect(result.provider.namespace).toBe('deepl');
  });

  it('invoke() throws InsufficientBalanceError with next_action on 402', async () => {
    const fakeFetch = async () =>
      new Response(
        JSON.stringify({
          jecp: '1.0',
          status: 'failed',
          error: { code: 'INSUFFICIENT_BALANCE', message: 'wallet 0 USDC < 0.005' },
          next_action: {
            type: 'topup',
            ui: 'https://jecp.dev/topup',
            api: 'https://jecp.dev/api/agents/topup',
            hint: 'Top up via Stripe.',
          },
        }),
        { status: 402, headers: { 'Content-Type': 'application/json' } },
      );

    const c = new JecpClient({
      agentId: 'jdb_ag_test',
      apiKey: 'jdb_ak_test',
      fetch: fakeFetch as unknown as typeof fetch,
    });

    try {
      await c.invoke('any/cap', 'any-action', {});
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(JecpError);
      expect(e).toBeInstanceOf(InsufficientBalanceError);
      const err = e as InsufficientBalanceError;
      expect(err.code).toBe('INSUFFICIENT_BALANCE');
      expect(err.status).toBe(402);
      expect(err.nextAction?.type).toBe('topup');
      if (err.nextAction?.type === 'topup') {
        expect(err.nextAction.api).toBe('https://jecp.dev/api/agents/topup');
      }
    }
  });

  it('invoke() throws CapabilityNotFoundError on 404', async () => {
    const fakeFetch = async () =>
      new Response(
        JSON.stringify({
          jecp: '1.0',
          status: 'failed',
          error: { code: 'CAPABILITY_NOT_FOUND', message: 'fake/x not found' },
          next_action: { type: 'discover', api: 'https://jecp.dev/v1/capabilities' },
        }),
        { status: 404, headers: { 'Content-Type': 'application/json' } },
      );

    const c = new JecpClient({
      agentId: 'jdb_ag_test',
      apiKey: 'jdb_ak_test',
      fetch: fakeFetch as unknown as typeof fetch,
    });

    await expect(c.invoke('fake/x', 'y', {})).rejects.toBeInstanceOf(
      CapabilityNotFoundError,
    );
  });

  it('invoke() throws RateLimitError on 429', async () => {
    const fakeFetch = async () =>
      new Response(
        JSON.stringify({
          jecp: '1.0',
          status: 'failed',
          error: { code: 'RATE_LIMITED', message: 'too many requests' },
          next_action: { type: 'retry_after', hint: '60 RPM cap' },
        }),
        { status: 429, headers: { 'Content-Type': 'application/json' } },
      );

    const c = new JecpClient({
      agentId: 'jdb_ag_test',
      apiKey: 'jdb_ak_test',
      fetch: fakeFetch as unknown as typeof fetch,
    });

    await expect(c.invoke('a/b', 'c', {})).rejects.toBeInstanceOf(RateLimitError);
  });

  it('invoke() builds mandate with agent credentials', async () => {
    let capturedBody = '';
    const fakeFetch = async (_url: string, init?: RequestInit) => {
      capturedBody = (init?.body as string) ?? '';
      return new Response(
        JSON.stringify({
          jecp: '1.0',
          id: 'r1',
          status: 'success',
          result: { ok: true },
          provider: { namespace: 'a', capability: 'b', version: '1.0.0' },
          billing: { charged: true, amount_usdc: 0.001 },
        }),
        { status: 200 },
      );
    };

    const c = new JecpClient({
      agentId: 'jdb_ag_test',
      apiKey: 'jdb_ak_test',
      fetch: fakeFetch as unknown as typeof fetch,
    });

    await c.invoke('a/b', 'c', {}, { mandate: { budget_usdc: 5.0 } });

    const sent = JSON.parse(capturedBody);
    expect(sent.mandate).toBeDefined();
    expect(sent.mandate.agent_id).toBe('jdb_ag_test');
    expect(sent.mandate.api_key).toBe('jdb_ak_test');
    expect(sent.mandate.budget_usdc).toBe(5.0);
  });
});
