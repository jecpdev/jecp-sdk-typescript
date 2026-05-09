import { describe, it, expect } from 'vitest';
import { createHmac, randomBytes } from 'node:crypto';
import { verifyWebhook, WebhookVerificationError } from '../src/webhook.js';

const SECRET_BYTES = randomBytes(32);
const SECRET_B64 = SECRET_BYTES.toString('base64');

function signEvent(body: string, ts = Math.floor(Date.now() / 1000)) {
  const mac = createHmac('sha256', SECRET_BYTES);
  mac.update(String(ts));
  mac.update('.');
  mac.update(body);
  return { signature: `v1=${mac.digest('base64')}`, timestamp: ts };
}

describe('verifyWebhook', () => {
  it('returns the parsed event when signature is valid', async () => {
    const body = JSON.stringify({
      type: 'invocation.completed',
      id: 'evt_abc123',
      created_at: '2026-05-09T01:00:00Z',
      data: { transaction_id: 'tx-9999', amount_usdc: 0.005 },
    });
    const { signature, timestamp } = signEvent(body);

    const event = await verifyWebhook<{ transaction_id: string; amount_usdc: number }>({
      body,
      signature,
      timestamp,
      secret: SECRET_B64,
    });

    expect(event.type).toBe('invocation.completed');
    expect(event.id).toBe('evt_abc123');
    expect(event.data.amount_usdc).toBe(0.005);
  });

  it('rejects when timestamp is stale (outside replay window)', async () => {
    const body = '{}';
    const oldTs = Math.floor(Date.now() / 1000) - 600;
    const { signature } = signEvent(body, oldTs);

    await expect(
      verifyWebhook({ body, signature, timestamp: oldTs, secret: SECRET_B64 }),
    ).rejects.toThrow(WebhookVerificationError);
  });

  it('rejects when signature is wrong (different secret)', async () => {
    const body = '{"type":"invocation.completed","id":"e1","created_at":"x","data":{}}';
    const { signature, timestamp } = signEvent(body);

    const otherSecret = randomBytes(32).toString('base64');
    await expect(
      verifyWebhook({ body, signature, timestamp, secret: otherSecret }),
    ).rejects.toThrow('signature mismatch');
  });

  it('rejects when body is tampered', async () => {
    const body = '{"type":"invocation.completed","id":"e1","created_at":"x","data":{}}';
    const { signature, timestamp } = signEvent(body);
    const tampered = body.replace('"e1"', '"e2"');

    await expect(
      verifyWebhook({ body: tampered, signature, timestamp, secret: SECRET_B64 }),
    ).rejects.toThrow(WebhookVerificationError);
  });

  it('rejects when timestamp is non-numeric', async () => {
    await expect(
      verifyWebhook({
        body: '{}',
        signature: 'v1=xyz',
        timestamp: 'not-a-number',
        secret: SECRET_B64,
      }),
    ).rejects.toThrow('invalid timestamp');
  });

  it('rejects when body is not valid JSON (after sig check)', async () => {
    const body = 'not json at all';
    const { signature, timestamp } = signEvent(body);

    await expect(
      verifyWebhook({ body, signature, timestamp, secret: SECRET_B64 }),
    ).rejects.toThrow('not valid JSON');
  });

  it('rejects when event is missing required fields', async () => {
    const body = JSON.stringify({ data: { whatever: true } }); // no type/id/created_at
    const { signature, timestamp } = signEvent(body);

    await expect(
      verifyWebhook({ body, signature, timestamp, secret: SECRET_B64 }),
    ).rejects.toThrow('missing type/id/created_at');
  });

  it('honors custom replayWindowSec', async () => {
    const body = '{"type":"e","id":"i","created_at":"x","data":{}}';
    const old = Math.floor(Date.now() / 1000) - 60;
    const { signature } = signEvent(body, old);

    // 30s window — 60s ago should fail
    await expect(
      verifyWebhook({
        body, signature, timestamp: old, secret: SECRET_B64,
        replayWindowSec: 30,
      }),
    ).rejects.toThrow();

    // 120s window — should pass
    const event = await verifyWebhook({
      body, signature, timestamp: old, secret: SECRET_B64,
      replayWindowSec: 120,
    });
    expect(event.type).toBe('e');
  });
});
