import { describe, it, expect } from 'vitest';
import { createHmac, randomBytes } from 'node:crypto';
import { JecpProvider as BrowserProvider } from '../src/provider-browser.js';

// Test the WebCrypto-based provider on Node 20+ (which has globalThis.crypto.subtle).

const SECRET_BYTES = randomBytes(32);
const SECRET_B64 = SECRET_BYTES.toString('base64');

function signBody(body: string, ts = Math.floor(Date.now() / 1000)) {
  const mac = createHmac('sha256', SECRET_BYTES);
  mac.update(String(ts));
  mac.update('.');
  mac.update(body);
  return { signature: `v1=${mac.digest('base64')}`, timestamp: ts };
}

describe('JecpProvider (browser/edge — WebCrypto)', () => {
  it('verifies a valid signature', async () => {
    const body = JSON.stringify({
      jecp: '1.0', id: 'r1', capability: 'a/b', action: 'c', input: {},
    });
    const { signature, timestamp } = signBody(body);

    const provider = new BrowserProvider({ hmacSecret: SECRET_B64 });
    const ok = await provider.verifySignature({ signature, timestamp, body });
    expect(ok).toBe(true);
  });

  it('rejects a tampered body', async () => {
    const body = '{"jecp":"1.0","id":"r1"}';
    const { signature, timestamp } = signBody(body);
    const tampered = body.replace('r1', 'r2');

    const provider = new BrowserProvider({ hmacSecret: SECRET_B64 });
    const ok = await provider.verifySignature({ signature, timestamp, body: tampered });
    expect(ok).toBe(false);
  });

  it('rejects stale timestamp', async () => {
    const body = '{}';
    const old = Math.floor(Date.now() / 1000) - 600;
    const { signature } = signBody(body, old);

    const provider = new BrowserProvider({ hmacSecret: SECRET_B64 });
    const ok = await provider.verifySignature({ signature, timestamp: old, body });
    expect(ok).toBe(false);
  });

  it('createHandler returns success envelope', async () => {
    const provider = new BrowserProvider({ hmacSecret: SECRET_B64 });

    const body = JSON.stringify({
      jecp: '1.0', id: 'r1', capability: 'tufe/echo', action: 'echo', input: { hi: 'there' },
    });
    const { signature, timestamp } = signBody(body);

    const handler = provider.createHandler(async (req) => ({ echoed: req.input }));
    const req = new Request('https://example.com/jecp', {
      method: 'POST',
      headers: {
        'X-JECP-Signature': signature,
        'X-JECP-Timestamp': String(timestamp),
        'Content-Type': 'application/json',
      },
      body,
    });

    const res = await handler(req);
    expect(res.status).toBe(200);
    const json = await res.json() as { status: string; result: { echoed: unknown } };
    expect(json.status).toBe('success');
    expect(json.result.echoed).toEqual({ hi: 'there' });
  });

  it('createHandler rejects on missing signature header', async () => {
    const provider = new BrowserProvider({ hmacSecret: SECRET_B64 });
    const handler = provider.createHandler(async () => ({ ok: true }));

    const req = new Request('https://example.com/jecp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });

    const res = await handler(req);
    expect(res.status).toBe(401);
    const json = await res.json() as { error: { code: string } };
    expect(json.error.code).toBe('MISSING_SIGNATURE');
  });

  it('caches the imported CryptoKey across calls', async () => {
    const provider = new BrowserProvider({ hmacSecret: SECRET_B64 });

    // Call twice — second should be faster due to caching, but both must succeed
    const body = '{"jecp":"1.0","id":"r1"}';
    const { signature, timestamp } = signBody(body);

    const a = await provider.verifySignature({ signature, timestamp, body });
    const b = await provider.verifySignature({ signature, timestamp, body });
    expect(a).toBe(true);
    expect(b).toBe(true);
  });
});
