/**
 * Webhook event verification (Hub → Provider/Agent async notifications).
 *
 * Verifies the HMAC signature on inbound webhook events sent by the JECP Hub.
 * Used by Providers/Agents to receive async notifications for:
 *
 * - `invocation.completed` — billing finalized
 * - `invocation.refunded` — refund processed
 * - `wallet.low_balance` — agent wallet under threshold
 * - `provider.kyc_status_changed` — Stripe Connect KYC update
 *
 * Spec §8 (Observability — webhook events) extends the HMAC scheme used in §6 (auth).
 *
 * @example
 *   import { verifyWebhook } from '@jecpdev/sdk';
 *
 *   app.post('/jecp/webhook', async (req) => {
 *     const event = await verifyWebhook({
 *       body: req.rawBody,
 *       signature: req.headers['x-jecp-webhook-signature'],
 *       timestamp: req.headers['x-jecp-webhook-timestamp'],
 *       secret: process.env.JECP_WEBHOOK_SECRET!,
 *     });
 *     switch (event.type) {
 *       case 'invocation.completed': ...
 *     }
 *   });
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export interface WebhookEvent<T = unknown> {
  /** Event type, e.g. 'invocation.completed' */
  type: string;
  /** ISO 8601 timestamp when the event was generated */
  created_at: string;
  /** Unique event id — use for idempotency */
  id: string;
  /** Event-specific payload */
  data: T;
}

export interface VerifyWebhookOptions {
  /** Raw request body (string or Buffer). MUST be the raw bytes — not a JSON-parsed object. */
  body: string | Buffer;
  /** Value of the `X-JECP-Webhook-Signature` header (e.g. `v1=base64...`) */
  signature: string;
  /** Value of the `X-JECP-Webhook-Timestamp` header (unix seconds, string or number) */
  timestamp: string | number;
  /** Webhook secret as base64 (issued by the Hub on subscription) */
  secret: string;
  /** Replay window in seconds. Default 300 (±5 min). */
  replayWindowSec?: number;
}

export class WebhookVerificationError extends Error {
  public readonly reason: string;
  constructor(reason: string) {
    super(`Webhook verification failed: ${reason}`);
    this.name = 'WebhookVerificationError';
    this.reason = reason;
  }
}

/**
 * Verify an inbound webhook event and return the parsed `WebhookEvent`.
 * Throws `WebhookVerificationError` on any verification failure.
 */
export async function verifyWebhook<T = unknown>(
  opts: VerifyWebhookOptions,
): Promise<WebhookEvent<T>> {
  const replayWindowSec = opts.replayWindowSec ?? 300;

  const tsNum =
    typeof opts.timestamp === 'string'
      ? parseInt(opts.timestamp, 10)
      : opts.timestamp;
  if (Number.isNaN(tsNum)) {
    throw new WebhookVerificationError('invalid timestamp');
  }

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - tsNum) > replayWindowSec) {
    throw new WebhookVerificationError(
      `timestamp outside replay window (${Math.abs(now - tsNum)}s > ${replayWindowSec}s)`,
    );
  }

  const secretBytes = Buffer.from(opts.secret, 'base64');
  const mac = createHmac('sha256', secretBytes);
  mac.update(String(tsNum));
  mac.update('.');
  mac.update(opts.body);
  const expected = `v1=${mac.digest('base64')}`;

  if (expected.length !== opts.signature.length) {
    throw new WebhookVerificationError('signature length mismatch');
  }
  if (
    !timingSafeEqual(
      Buffer.from(expected, 'utf-8'),
      Buffer.from(opts.signature, 'utf-8'),
    )
  ) {
    throw new WebhookVerificationError('signature mismatch');
  }

  let event: WebhookEvent<T>;
  try {
    event = JSON.parse(typeof opts.body === 'string' ? opts.body : opts.body.toString());
  } catch {
    throw new WebhookVerificationError('body is not valid JSON');
  }

  if (!event.type || !event.id || !event.created_at) {
    throw new WebhookVerificationError('event is missing type/id/created_at');
  }
  return event;
}
