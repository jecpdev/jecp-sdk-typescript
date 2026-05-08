import { describe, it, expect } from 'vitest';
import { createHmac, randomBytes } from 'node:crypto';
import { JecpProvider } from '../src/provider.js';

const SECRET_BYTES = randomBytes(32);
const SECRET_B64 = SECRET_BYTES.toString('base64');

function signBody(body: string, ts: number = Math.floor(Date.now() / 1000)) {
  const mac = createHmac('sha256', SECRET_BYTES);
  mac.update(String(ts));
  mac.update('.');
  mac.update(body);
  return { signature: `v1=${mac.digest('base64')}`, timestamp: ts };
}

describe('JecpProvider', () => {
  it('verifies a valid signature', () => {
    const body = '{"jecp":"1.0","id":"r1","capability":"a/b","action":"c","input":{}}';
    const { signature, timestamp } = signBody(body);

    const provider = new JecpProvider({ hmacSecret: SECRET_B64 });
    expect(provider.verifySignature({ signature, timestamp, body })).toBe(true);
  });

  it('rejects a tampered body', () => {
    const body = '{"jecp":"1.0","id":"r1","capability":"a/b","action":"c","input":{}}';
    const { signature, timestamp } = signBody(body);
    const tampered = body.replace('r1', 'r2');

    const provider = new JecpProvider({ hmacSecret: SECRET_B64 });
    expect(provider.verifySignature({ signature, timestamp, body: tampered })).toBe(
      false,
    );
  });

  it('rejects stale timestamp (outside replay window)', () => {
    const body = '{}';
    const old = Math.floor(Date.now() / 1000) - 600; // 10 min ago
    const { signature } = signBody(body, old);

    const provider = new JecpProvider({ hmacSecret: SECRET_B64 });
    expect(provider.verifySignature({ signature, timestamp: old, body })).toBe(false);
  });

  it('createHandler responds with success envelope', async () => {
    const provider = new JecpProvider({ hmacSecret: SECRET_B64 });

    const body = JSON.stringify({
      jecp: '1.0',
      id: 'r1',
      capability: 'tufe/echo',
      action: 'echo',
      input: { hello: 'world' },
    });
    const { signature, timestamp } = signBody(body);

    const handler = provider.createHandler(async (req) => {
      return { echoed: req.input };
    });

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
    const json = await res.json();
    expect(json.status).toBe('success');
    expect(json.id).toBe('r1');
    expect(json.result).toEqual({ echoed: { hello: 'world' } });
  });

  it('createHandler rejects on missing signature', async () => {
    const provider = new JecpProvider({ hmacSecret: SECRET_B64 });
    const handler = provider.createHandler(async () => ({ ok: true }));

    const req = new Request('https://example.com/jecp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });

    const res = await handler(req);
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error.code).toBe('MISSING_SIGNATURE');
  });

  it('createHandler rejects on bad signature', async () => {
    const provider = new JecpProvider({ hmacSecret: SECRET_B64 });
    const handler = provider.createHandler(async () => ({ ok: true }));

    const req = new Request('https://example.com/jecp', {
      method: 'POST',
      headers: {
        'X-JECP-Signature': 'v1=wrong-signature',
        'X-JECP-Timestamp': String(Math.floor(Date.now() / 1000)),
        'Content-Type': 'application/json',
      },
      body: '{}',
    });

    const res = await handler(req);
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error.code).toBe('INVALID_SIGNATURE');
  });
});
