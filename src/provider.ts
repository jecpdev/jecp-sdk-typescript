/**
 * JECP Provider helper — verify HMAC signatures and create endpoint handlers.
 *
 * Usage (Express / Next.js / Hono / Bun.serve):
 *   import { JecpProvider } from '@jecp/sdk';
 *
 *   const provider = new JecpProvider({
 *     hmacSecret: process.env.JECP_HMAC_SECRET!,
 *   });
 *
 *   const handler = provider.createHandler(async (req) => {
 *     // your business logic here
 *     return { translated: await translate(req.input.text) };
 *   });
 *
 *   app.post('/jecp', handler);  // Express
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export interface JecpProviderOptions {
  /** HMAC secret as base64 (issued at Provider registration). */
  hmacSecret: string;
  /** Replay window in seconds (default 300 = ±5 min). */
  replayWindowSec?: number;
}

export interface ParsedJecpRequest {
  jecp: string;
  id: string;
  capability: string;
  action: string;
  input: unknown;
  /** Validated headers from the inbound request. */
  signature: string;
  timestamp: number;
  namespace?: string;
}

export type ProviderHandlerFn<T = unknown> = (
  req: ParsedJecpRequest,
) => Promise<T> | T;

const DEFAULT_REPLAY_WINDOW = 300;

export class JecpProvider {
  private readonly hmacSecretBytes: Buffer;
  private readonly replayWindowSec: number;

  constructor(opts: JecpProviderOptions) {
    if (!opts.hmacSecret) {
      throw new Error('JecpProvider: hmacSecret is required');
    }
    this.hmacSecretBytes = Buffer.from(opts.hmacSecret, 'base64');
    this.replayWindowSec = opts.replayWindowSec ?? DEFAULT_REPLAY_WINDOW;
  }

  /**
   * Verify the HMAC signature on an inbound JECP request.
   * Returns true if signature is valid AND timestamp is within replay window.
   */
  verifySignature(opts: {
    signature: string;
    timestamp: string | number;
    body: string | Buffer;
  }): boolean {
    const tsNum =
      typeof opts.timestamp === 'string'
        ? parseInt(opts.timestamp, 10)
        : opts.timestamp;
    if (Number.isNaN(tsNum)) return false;

    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - tsNum) > this.replayWindowSec) return false;

    const mac = createHmac('sha256', this.hmacSecretBytes);
    mac.update(String(tsNum));
    mac.update('.');
    mac.update(opts.body);
    const expected = `v1=${mac.digest('base64')}`;

    if (expected.length !== opts.signature.length) return false;
    return timingSafeEqual(
      Buffer.from(expected),
      Buffer.from(opts.signature),
    );
  }

  /**
   * Build a fetch-API compatible request handler that:
   * - reads X-JECP-Signature / X-JECP-Timestamp headers
   * - verifies HMAC
   * - parses the JECP envelope
   * - calls your processFn with the parsed request
   * - wraps the result in a JECP envelope response
   *
   * Works with: Bun.serve, Cloudflare Workers, Next.js Route Handlers,
   * Hono, or any framework where you have access to a Request object.
   */
  createHandler<T = unknown>(processFn: ProviderHandlerFn<T>) {
    return async (req: Request): Promise<Response> => {
      const sig = req.headers.get('x-jecp-signature') ?? '';
      const ts = req.headers.get('x-jecp-timestamp') ?? '';
      const ns = req.headers.get('x-jecp-namespace') ?? undefined;

      if (!sig || !ts) {
        return jsonResponse(
          {
            jecp: '1.0',
            status: 'failed',
            error: { code: 'MISSING_SIGNATURE', message: 'X-JECP-Signature and X-JECP-Timestamp required' },
          },
          401,
        );
      }

      const bodyText = await req.text();

      if (!this.verifySignature({ signature: sig, timestamp: ts, body: bodyText })) {
        return jsonResponse(
          {
            jecp: '1.0',
            status: 'failed',
            error: { code: 'INVALID_SIGNATURE', message: 'HMAC verification failed' },
          },
          401,
        );
      }

      let envelope: ParsedJecpRequest;
      try {
        const raw = JSON.parse(bodyText);
        envelope = {
          jecp: raw.jecp,
          id: raw.id,
          capability: raw.capability,
          action: raw.action,
          input: raw.input,
          signature: sig,
          timestamp: parseInt(ts, 10),
          namespace: ns,
        };
      } catch {
        return jsonResponse(
          {
            jecp: '1.0',
            status: 'failed',
            error: { code: 'PARSE_ERROR', message: 'invalid JSON' },
          },
          400,
        );
      }

      try {
        const result = await processFn(envelope);
        return jsonResponse({
          jecp: '1.0',
          id: envelope.id,
          status: 'success',
          result,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return jsonResponse(
          {
            jecp: '1.0',
            id: envelope.id,
            status: 'failed',
            error: { code: 'PROVIDER_INTERNAL_ERROR', message: msg },
          },
          500,
        );
      }
    };
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
