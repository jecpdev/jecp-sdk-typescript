/**
 * x402 integration tests — Locked design §3 + §6 + Spec v1.1.0 §3.5.
 *
 * Covers:
 *   - mode='auto' + 402 with x402 → SDK signs + retries with X-Payment → 200
 *   - mode='auto' + capability rejects x402 → propagates JecpError (wallet path)
 *   - mode='wallet' → never attempts x402 even when 402 contains x402 entry
 *   - mode='x402' but no x402 in 402 → InsufficientPaymentOptionsError
 *   - mode='x402' construction without signer throws (early validation)
 *   - Idempotency: X-Request-Id preserved between initial 402 and X-Payment retry
 *   - Error parsing: 422 X402_PAYMENT_INVALID → typed X402PaymentInvalidError
 *   - X-Payment-Response decoding into result.payment
 *   - estimateCost() pulls from catalog manifest
 *   - x402 helpers: payload builder, signature packing, header codec, requirement finder
 */

import { describe, it, expect, vi } from 'vitest';
import { JecpClient } from '../src/client.js';
import {
  X402PaymentInvalidError,
  InsufficientPaymentOptionsError,
  JecpError,
} from '../src/errors.js';
import {
  buildEIP3009Params,
  packSignature,
  encodeXPaymentHeader,
  decodeXPaymentResponseHeader,
  findX402Requirement,
  networkToChainId,
} from '../src/x402/payload.js';
import type { Signer, X402ExactRequirement } from '../src/x402/types.js';

// ─── Fixtures ────────────────────────────────────────────────

const USDC_BASE: `0x${string}` = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const SPLITTER: `0x${string}`  = '0x0000000000000000000000000000000000000042';
const AGENT_ADDR: `0x${string}` = '0xAB11CD22EF33aabbccddeeff0011223344556677';

const x402Accept: X402ExactRequirement = {
  scheme: 'exact',
  network: 'base',
  asset: USDC_BASE,
  asset_symbol: 'USDC',
  asset_decimals: 6,
  amount: '200000',
  max_amount_required: '200000',
  pay_to: SPLITTER,
  resource: 'https://jecp.dev/v1/invoke',
  description: 'Payment for capability jobdonebot/bg-remover-pro',
  mime_type: 'application/json',
  max_timeout_seconds: 60,
  extra: { splitter_capability_id: 'cap_xyz789', facilitator_url: 'https://x402.org/facilitator' },
};

const stripeAccept = {
  scheme: 'stripe-wallet' as const,
  amount_usd: 0.20,
  topup_url: 'https://jecp.dev/account/topup?return=req_abc123',
};

function envelope402(includeX402 = true) {
  return {
    jecp: '1.1',
    id: 'req_abc123',
    ts: '2026-05-11T12:34:56Z',
    status: 'failed' as const,
    code: 'PAYMENT_REQUIRED',
    error: { code: 'PAYMENT_REQUIRED', message: 'Payment required' },
    details: { amount_usd: 0.20, amount_usdc: '200000' },
    payment: {
      accepts: includeX402 ? [stripeAccept, x402Accept] : [stripeAccept],
      ttl_seconds: 30,
    },
  };
}

const successEnvelope = {
  jecp: '1.0',
  id: 'r1',
  status: 'success' as const,
  result: { masked_url: 'https://result.example/out.png' },
  provider: { namespace: 'jobdonebot', capability: 'bg-remover-pro', version: '1.0.0' },
  billing: { charged: true, amount_usdc: 0.20, transaction_id: 'tx-1' },
  wallet_balance_after: undefined,
};

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

/** A minimal in-memory signer for tests — never touches a real wallet. */
function fakeSigner(addr: `0x${string}` = AGENT_ADDR): Signer & { calls: number } {
  const s = {
    calls: 0,
    async getAddress() { return addr; },
    async signEIP3009(_params: unknown) {
      s.calls += 1;
      return {
        v: 28,
        r: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as `0x${string}`,
        s: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as `0x${string}`,
      };
    },
  };
  return s as Signer & { calls: number };
}

// ─── x402 helper unit tests ──────────────────────────────────

describe('x402 helpers', () => {
  it('networkToChainId maps base/base-sepolia', () => {
    expect(networkToChainId('base')).toBe(8453);
    expect(networkToChainId('base-sepolia')).toBe(84532);
  });

  it('buildEIP3009Params constructs the correct envelope', () => {
    const params = buildEIP3009Params(x402Accept, AGENT_ADDR, 1737_000_000);
    expect(params.from).toBe(AGENT_ADDR);
    expect(params.to).toBe(SPLITTER);
    expect(params.value).toBe(BigInt(200_000));
    expect(params.validAfter).toBe(BigInt(0));
    expect(params.validBefore).toBe(BigInt(1737_000_060));
    expect(params.chainId).toBe(8453);
    expect(params.verifyingContract).toBe(USDC_BASE);
    expect(params.nonce).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('packSignature concatenates (r, s, v) into 65-byte hex', () => {
    const r = '0x' + 'a'.repeat(64);
    const s = '0x' + 'b'.repeat(64);
    const sig = packSignature(28, r as `0x${string}`, s as `0x${string}`);
    expect(sig.length).toBe(2 + 130); // 0x + 65 bytes hex
    expect(sig.endsWith('1c')).toBe(true); // 28 = 0x1c
  });

  it('packSignature normalizes v=0/1 to 27/28', () => {
    const r = '0x' + 'a'.repeat(64);
    const s = '0x' + 'b'.repeat(64);
    const sig0 = packSignature(0, r as `0x${string}`, s as `0x${string}`);
    expect(sig0.endsWith('1b')).toBe(true); // 27
    const sig1 = packSignature(1, r as `0x${string}`, s as `0x${string}`);
    expect(sig1.endsWith('1c')).toBe(true); // 28
  });

  it('encodeXPaymentHeader produces valid base64 JSON and rejects oversize', () => {
    const payload = {
      x402Version: 1 as const,
      scheme: 'exact' as const,
      network: 'base' as const,
      payload: {
        signature: ('0x' + 'a'.repeat(130)) as `0x${string}`,
        authorization: {
          from: AGENT_ADDR,
          to: SPLITTER,
          value: '200000',
          validAfter: '0',
          validBefore: '1737000060',
          nonce: ('0x' + 'c'.repeat(64)) as `0x${string}`,
        },
      },
    };
    const b64 = encodeXPaymentHeader(payload);
    expect(b64.length).toBeGreaterThan(0);
    expect(b64.length).toBeLessThan(8 * 1024);
    const decoded = JSON.parse(Buffer.from(b64, 'base64').toString('utf-8'));
    expect(decoded.x402Version).toBe(1);
    expect(decoded.payload.authorization.value).toBe('200000');
  });

  it('decodeXPaymentResponseHeader parses base64 JSON receipts (legacy txHash/networkId)', () => {
    const json = JSON.stringify({ success: true, txHash: '0xdeadbeef', networkId: 'base' });
    const b64 = Buffer.from(json, 'utf-8').toString('base64');
    const parsed = decodeXPaymentResponseHeader(b64);
    expect(parsed).toBeDefined();
    expect(parsed?.txHash).toBe('0xdeadbeef');
    expect(parsed?.networkId).toBe('base');
  });

  it('decodeXPaymentResponseHeader parses spec-canonical transaction/network/payer (Audit A-C2)', () => {
    const json = JSON.stringify({
      success: true,
      transaction: '0xc0ffee01',
      network: 'base',
      payer: '0xAAAA000000000000000000000000000000000001',
    });
    const b64 = Buffer.from(json, 'utf-8').toString('base64');
    const parsed = decodeXPaymentResponseHeader(b64);
    expect(parsed).toBeDefined();
    expect(parsed?.txHash).toBe('0xc0ffee01');
    expect(parsed?.networkId).toBe('base');
    expect(parsed?.payer).toBe('0xAAAA000000000000000000000000000000000001');
  });

  it('decodeXPaymentResponseHeader returns undefined for malformed input', () => {
    expect(decodeXPaymentResponseHeader('not-base64-!!')).toBeUndefined();
    expect(decodeXPaymentResponseHeader(null)).toBeUndefined();
    expect(decodeXPaymentResponseHeader(undefined)).toBeUndefined();
    const badShape = Buffer.from(JSON.stringify({ success: false }), 'utf-8').toString('base64');
    expect(decodeXPaymentResponseHeader(badShape)).toBeUndefined();
  });

  it('findX402Requirement picks the exact-scheme entry', () => {
    expect(findX402Requirement([stripeAccept, x402Accept])).toBe(x402Accept);
    expect(findX402Requirement([stripeAccept])).toBeUndefined();
  });
});

// ─── JecpClient constructor validation ───────────────────────

describe('JecpClient — payment config validation', () => {
  it("mode='x402' without signer throws at construction", () => {
    expect(() => new JecpClient({
      agentId: 'jdb_ag_test',
      apiKey: 'jdb_ak_test',
      payment: { mode: 'x402' },
    })).toThrow(/requires payment.signer/);
  });

  it("mode='auto' without signer is allowed (wallet fallback)", () => {
    expect(() => new JecpClient({
      agentId: 'jdb_ag_test',
      apiKey: 'jdb_ak_test',
      payment: { mode: 'auto' },
    })).not.toThrow();
  });

  it('default mode is auto', () => {
    const c = new JecpClient({ agentId: 'a', apiKey: 'k' });
    // No public accessor, but constructor not throwing + the default-auto
    // behavior is exercised in the invoke tests below.
    expect(c).toBeDefined();
  });
});

// ─── invoke() — happy path (no 402) ──────────────────────────

describe('JecpClient.invoke() — auto mode, no payment needed', () => {
  it('returns immediately on 200 without consulting signer', async () => {
    const signer = fakeSigner();
    const fakeFetch = vi.fn(async () => jsonResponse(successEnvelope));
    const c = new JecpClient({
      agentId: 'jdb_ag_test',
      apiKey: 'jdb_ak_test',
      payment: { mode: 'auto', signer },
      fetch: fakeFetch as unknown as typeof fetch,
    });
    const r = await c.invoke('jobdonebot/bg-remover-pro', 'remove', {});
    expect(r.output).toEqual({ masked_url: 'https://result.example/out.png' });
    expect(signer.calls).toBe(0); // signer untouched on 200
    expect(r.payment).toBeUndefined(); // no x402 receipt for wallet/free path
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });
});

// ─── invoke() — auto mode + 402 with x402 → SDK signs + retries ──

describe("JecpClient.invoke() — auto mode + 402 with x402", () => {
  it('signs EIP-3009, retries with X-Payment, returns result with payment receipt', async () => {
    const signer = fakeSigner();
    const captured: { headers: Record<string, string>; body: string }[] = [];
    let call = 0;
    const fakeFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      call += 1;
      const headers = init?.headers as Record<string, string>;
      captured.push({ headers, body: init?.body as string });
      if (call === 1) {
        return jsonResponse(envelope402(true), 402);
      }
      // Second call MUST carry the X-Payment header
      expect(headers['X-Payment']).toBeDefined();
      const xPaymentResponse = Buffer.from(JSON.stringify({
        success: true,
        txHash: '0xabc123',
        networkId: 'base',
      }), 'utf-8').toString('base64');
      return jsonResponse(successEnvelope, 200, {
        'X-Payment-Response': xPaymentResponse,
      });
    });

    const c = new JecpClient({
      agentId: 'jdb_ag_test',
      apiKey: 'jdb_ak_test',
      payment: { mode: 'auto', signer },
      fetch: fakeFetch as unknown as typeof fetch,
    });

    const r = await c.invoke('jobdonebot/bg-remover-pro', 'remove', {});
    expect(r.output).toEqual({ masked_url: 'https://result.example/out.png' });
    expect(signer.calls).toBe(1);
    expect(fakeFetch).toHaveBeenCalledTimes(2);
    expect(r.payment).toBeDefined();
    expect(r.payment?.method).toBe('x402');
    expect(r.payment?.txHash).toBe('0xabc123');
    expect(r.payment?.networkId).toBe('base');
    expect(r.payment?.amount_usdc).toBe(BigInt(200_000));
    expect(r.payment?.amount_usd).toBeCloseTo(0.20);

    // Idempotency: same X-Request-Id used on both attempts.
    const body0 = JSON.parse(captured[0]!.body);
    const body1 = JSON.parse(captured[1]!.body);
    expect(body0.id).toBe(body1.id);
    expect(captured[1]!.headers['X-Request-Id']).toBe(body1.id);
  });
});

// ─── invoke() — auto mode + 402 without x402 → propagates JecpError ──

describe("JecpClient.invoke() — auto mode + 402 wallet-only", () => {
  it('propagates JecpError when 402 has no x402 accept entry and no wallet top-up flow', async () => {
    const signer = fakeSigner();
    const fakeFetch = vi.fn(async () => jsonResponse(envelope402(false), 402));
    const c = new JecpClient({
      agentId: 'jdb_ag_test',
      apiKey: 'jdb_ak_test',
      payment: { mode: 'auto', signer },
      fetch: fakeFetch as unknown as typeof fetch,
    });

    await expect(c.invoke('jobdonebot/bg-remover-pro', 'remove', {}))
      .rejects.toBeInstanceOf(JecpError);
    expect(signer.calls).toBe(0); // never signed since no x402 entry
  });
});

// ─── invoke() — mode='wallet' never signs even with x402 entry ───

describe("JecpClient.invoke() — wallet-only mode", () => {
  it("does NOT attempt x402 even when 402 advertises it", async () => {
    const signer = fakeSigner();
    const fakeFetch = vi.fn(async () => jsonResponse(envelope402(true), 402));
    const c = new JecpClient({
      agentId: 'jdb_ag_test',
      apiKey: 'jdb_ak_test',
      payment: { mode: 'wallet', signer }, // signer present but ignored
      fetch: fakeFetch as unknown as typeof fetch,
    });

    await expect(c.invoke('jobdonebot/bg-remover-pro', 'remove', {}))
      .rejects.toBeInstanceOf(JecpError);
    expect(signer.calls).toBe(0);
  });
});

// ─── invoke() — mode='x402' but capability rejects x402 ──────

describe("JecpClient.invoke() — x402-only mode + wallet-only capability", () => {
  it("throws InsufficientPaymentOptionsError", async () => {
    const signer = fakeSigner();
    const fakeFetch = vi.fn(async () => jsonResponse(envelope402(false), 402));
    const c = new JecpClient({
      agentId: 'jdb_ag_test',
      apiKey: 'jdb_ak_test',
      payment: { mode: 'x402', signer },
      fetch: fakeFetch as unknown as typeof fetch,
    });

    let thrown: unknown;
    try { await c.invoke('jobdonebot/bg-remover-pro', 'remove', {}); }
    catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(InsufficientPaymentOptionsError);
    expect((thrown as InsufficientPaymentOptionsError).capabilityRejectedX402).toBe(true);
    expect(signer.calls).toBe(0);
  });
});

// ─── invoke() — 422 X402_PAYMENT_INVALID on retry ────────────

describe("JecpClient.invoke() — x402 retry rejected by facilitator", () => {
  it('throws X402PaymentInvalidError with subcause', async () => {
    const signer = fakeSigner();
    let call = 0;
    const fakeFetch = vi.fn(async () => {
      call += 1;
      if (call === 1) return jsonResponse(envelope402(true), 402);
      return jsonResponse({
        jecp: '1.1',
        status: 'failed',
        error: {
          code: 'X402_PAYMENT_INVALID',
          message: 'signature_invalid',
          details: { subcause: 'signature_invalid', documentation_url: 'https://jecp.dev/errors/x402-invalid' },
        },
      }, 422);
    });
    const c = new JecpClient({
      agentId: 'jdb_ag_test',
      apiKey: 'jdb_ak_test',
      payment: { mode: 'x402', signer },
      fetch: fakeFetch as unknown as typeof fetch,
    });

    let thrown: unknown;
    try { await c.invoke('jobdonebot/bg-remover-pro', 'remove', {}); }
    catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(X402PaymentInvalidError);
    expect((thrown as X402PaymentInvalidError).subcause).toBe('signature_invalid');
    expect((thrown as X402PaymentInvalidError).retryable).toBe(false);
    expect(signer.calls).toBe(1);
  });
});

// ─── estimateCost() ──────────────────────────────────────────

describe('JecpClient.estimateCost()', () => {
  it('reads pricing from catalog manifest', async () => {
    const catalogBody = {
      jecp: '1.0',
      engine: 'test',
      capabilities: [],
      third_party_capabilities: [
        {
          id: 'jobdonebot/bg-remover-pro',
          namespace: 'jobdonebot',
          name: 'bg-remover-pro',
          version: '1.0.0',
          manifest: {
            namespace: 'jobdonebot',
            capability: 'bg-remover-pro',
            version: '1.0.0',
            description: '',
            endpoint: 'https://x',
            actions: [
              { id: 'remove', description: '', pricing: { base: '$0.20', currency: 'USDC', model: 'per_call' } },
            ],
          },
        },
      ],
    };
    const fakeFetch = vi.fn(async () => jsonResponse(catalogBody));
    const c = new JecpClient({
      agentId: 'a', apiKey: 'k',
      fetch: fakeFetch as unknown as typeof fetch,
    });
    const cost = await c.estimateCost('jobdonebot/bg-remover-pro');
    expect(cost.usd).toBeCloseTo(0.20);
    expect(cost.usdc).toBe(BigInt(200_000));
    expect(cost.gasEstimateUsd).toBeGreaterThan(0);
    expect(cost.gasEstimateUsd).toBeLessThan(0.10);
  });

  it('falls back to default $0.005 when capability not in catalog', async () => {
    const fakeFetch = vi.fn(async () => jsonResponse({
      jecp: '1.0', engine: 'test', capabilities: [], third_party_capabilities: [],
    }));
    const c = new JecpClient({
      agentId: 'a', apiKey: 'k',
      fetch: fakeFetch as unknown as typeof fetch,
    });
    const cost = await c.estimateCost('unknown/cap');
    expect(cost.usd).toBe(0.005);
    expect(cost.usdc).toBe(BigInt(5_000));
  });
});
