/**
 * JECP Provider helper — Browser / Edge runtime version (Web Crypto API).
 *
 * Drop-in replacement for the Node version in `src/provider.ts`, using
 * `crypto.subtle` instead of `node:crypto`. Works on:
 *
 * - Cloudflare Workers
 * - Deno
 * - Bun (browser-side)
 * - Vite/webpack browser builds
 * - Modern browsers
 *
 * @example
 *   import { JecpProvider } from '@jecpdev/sdk/browser';
 *
 *   export default {
 *     async fetch(req: Request, env: Env) {
 *       const provider = new JecpProvider({ hmacSecret: env.JECP_HMAC_SECRET });
 *       const handler = provider.createHandler(async (parsed) => ({ result: '...' }));
 *       return handler(req);
 *     },
 *   };
 */

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
  signature: string;
  timestamp: number;
  namespace?: string;
}

export type ProviderHandlerFn<T = unknown> = (
  req: ParsedJecpRequest,
) => Promise<T> | T;

const DEFAULT_REPLAY_WINDOW = 300;

export class JecpProvider {
  private readonly hmacSecretB64: string;
  private readonly replayWindowSec: number;
  private cachedKey?: CryptoKey;

  constructor(opts: JecpProviderOptions) {
    if (!opts.hmacSecret) {
      throw new Error('JecpProvider: hmacSecret is required');
    }
    this.hmacSecretB64 = opts.hmacSecret;
    this.replayWindowSec = opts.replayWindowSec ?? DEFAULT_REPLAY_WINDOW;
  }

  private async getKey(): Promise<CryptoKey> {
    if (this.cachedKey) return this.cachedKey;
    const raw = base64Decode(this.hmacSecretB64);
    // Copy into a fresh ArrayBuffer to satisfy strict BufferSource typing across runtimes.
    const ab = new ArrayBuffer(raw.byteLength);
    new Uint8Array(ab).set(raw);
    this.cachedKey = await crypto.subtle.importKey(
      'raw',
      ab,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign', 'verify'],
    );
    return this.cachedKey;
  }

  /**
   * Verify the HMAC signature on an inbound JECP request.
   * Returns true iff signature is valid AND timestamp is within replay window.
   */
  async verifySignature(opts: {
    signature: string;
    timestamp: string | number;
    body: string | ArrayBuffer | Uint8Array;
  }): Promise<boolean> {
    const tsNum =
      typeof opts.timestamp === 'string'
        ? parseInt(opts.timestamp, 10)
        : opts.timestamp;
    if (Number.isNaN(tsNum)) return false;

    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - tsNum) > this.replayWindowSec) return false;

    const enc = new TextEncoder();
    const tsBytes = enc.encode(String(tsNum) + '.');
    const bodyBytes =
      typeof opts.body === 'string'
        ? enc.encode(opts.body)
        : opts.body instanceof ArrayBuffer
        ? new Uint8Array(opts.body)
        : opts.body;

    const total = tsBytes.length + bodyBytes.length;
    const messageAb = new ArrayBuffer(total);
    const messageView = new Uint8Array(messageAb);
    messageView.set(tsBytes, 0);
    messageView.set(bodyBytes, tsBytes.length);

    const key = await this.getKey();
    const sig = await crypto.subtle.sign('HMAC', key, messageAb);
    const expected = `v1=${base64Encode(new Uint8Array(sig))}`;

    return constantTimeEquals(expected, opts.signature);
  }

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

      const ok = await this.verifySignature({ signature: sig, timestamp: ts, body: bodyText });
      if (!ok) {
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

// ─── helpers ─────────────────────────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function base64Encode(bytes: Uint8Array): string {
  if (typeof btoa === 'function') {
    let bin = '';
    for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]!);
    return btoa(bin);
  }
  // Node fallback (the browser build is meant for non-Node, but stay safe)
  return Buffer.from(bytes).toString('base64');
}

function base64Decode(b64: string): Uint8Array {
  if (typeof atob === 'function') {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

/** Constant-time string equality. */
function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
