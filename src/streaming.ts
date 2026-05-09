/**
 * Streaming response support (W5).
 *
 * SSE (text/event-stream) consumption with AsyncIterable interface.
 * Spec: see jobdonebot:docs/jecp/world-no1-roadmap/05-streaming-deep-design.md
 *
 * Stream events:
 *  - chunk      — incremental output ({ delta, index? })
 *  - meter      — billing metering update ({ tokens?, elapsed_ms?, ... })
 *  - completed  — terminal success ({ result, billing, transaction_id? })
 *  - error      — terminal failure ({ error: { code, message } })
 *  - cancelled  — terminal cancel (network drop, mandate exhausted, agent abort)
 */

import type { BillingSummary } from './types.js';

export type StreamEvent =
  | { type: 'chunk'; delta: string; index?: number; raw?: unknown }
  | { type: 'meter'; tokens?: number; elapsed_ms?: number; raw?: unknown }
  | { type: 'completed'; result: unknown; billing: BillingSummary; raw?: unknown }
  | { type: 'error'; error: { code: string; message: string }; raw?: unknown }
  | { type: 'cancelled'; reason?: string; billing?: BillingSummary; raw?: unknown };

export interface InvokeStreamOptions {
  /** Pre-authorized budget cap. */
  mandate?: { budget_usdc: number; expires_at?: string };
  /** Override request id (default: auto-generated UUID). */
  requestId?: string;
  /** AbortSignal — cancel the stream mid-flight. */
  signal?: AbortSignal;
  /** Per-call timeout in ms. Default: no timeout (stream may run up to 5 min). */
  timeoutMs?: number;
}

export class JecpStream implements AsyncIterable<StreamEvent> {
  private body: ReadableStream<Uint8Array>;
  private signal?: AbortSignal;

  constructor(body: ReadableStream<Uint8Array>, signal?: AbortSignal) {
    this.body = body;
    this.signal = signal;
  }

  [Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    const reader = this.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    const queue: StreamEvent[] = [];
    let terminated = false;
    let upstreamDone = false;
    const signal = this.signal;

    function drainBuffer(): void {
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) >= 0) {
        const rawEvent = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const parsed = parseSseEvent(rawEvent);
        if (parsed) queue.push(parsed);
      }
    }

    return {
      async next(): Promise<IteratorResult<StreamEvent>> {
        if (terminated) return { value: undefined as unknown as StreamEvent, done: true };

        while (queue.length === 0 && !upstreamDone) {
          if (signal?.aborted) {
            try { await reader.cancel(); } catch { /* ignore */ }
            terminated = true;
            return {
              value: { type: 'cancelled', reason: 'AbortSignal fired' } as StreamEvent,
              done: false,
            };
          }
          let readResult: ReadableStreamReadResult<Uint8Array>;
          try {
            readResult = await readWithSignal(reader, signal);
          } catch (e) {
            terminated = true;
            const err = e as Error;
            if (err.name === 'AbortError') {
              return { value: { type: 'cancelled', reason: 'AbortSignal fired' } as StreamEvent, done: false };
            }
            return {
              value: {
                type: 'error',
                error: { code: 'NETWORK_ERROR', message: err.message ?? String(e) },
              } as StreamEvent,
              done: false,
            };
          }
          if (readResult.done) {
            upstreamDone = true;
            buffer += decoder.decode(undefined, { stream: false });
            drainBuffer();
            break;
          }
          buffer += decoder.decode(readResult.value, { stream: true });
          drainBuffer();
        }

        if (queue.length > 0) {
          const ev = queue.shift()!;
          if (ev.type === 'completed' || ev.type === 'error' || ev.type === 'cancelled') {
            terminated = true;
          }
          return { value: ev, done: false };
        }

        terminated = true;
        return {
          value: { type: 'cancelled', reason: 'connection closed' } as StreamEvent,
          done: false,
        };
      },
      async return(): Promise<IteratorResult<StreamEvent>> {
        try { await reader.cancel(); } catch { /* ignore */ }
        terminated = true;
        return { value: undefined as unknown as StreamEvent, done: true };
      },
    };
  }

  async toArray(): Promise<StreamEvent[]> {
    const out: StreamEvent[] = [];
    for await (const ev of this) out.push(ev);
    return out;
  }

  async toText(): Promise<string> {
    let text = '';
    for await (const ev of this) {
      if (ev.type === 'chunk') text += ev.delta;
      if (ev.type === 'error' || ev.type === 'cancelled') break;
    }
    return text;
  }

  async final(): Promise<{ result?: unknown; billing?: BillingSummary; cancelled: boolean; error?: { code: string; message: string } }> {
    for await (const ev of this) {
      if (ev.type === 'completed') return { result: ev.result, billing: ev.billing, cancelled: false };
      if (ev.type === 'cancelled') return { cancelled: true, billing: ev.billing };
      if (ev.type === 'error') return { cancelled: false, error: ev.error };
    }
    return { cancelled: true };
  }
}

async function readWithSignal<T>(
  reader: ReadableStreamDefaultReader<T>,
  signal?: AbortSignal,
): Promise<ReadableStreamReadResult<T>> {
  if (!signal) return reader.read();
  if (signal.aborted) {
    const err = new Error('Aborted');
    err.name = 'AbortError';
    throw err;
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      try { reader.cancel().catch(() => {}); } catch { /* ignore */ }
      const err = new Error('Aborted');
      err.name = 'AbortError';
      reject(err);
    };
    signal.addEventListener('abort', onAbort);
    reader.read().then(
      (r) => {
        signal.removeEventListener('abort', onAbort);
        resolve(r);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

function parseSseEvent(raw: string): StreamEvent | null {
  if (!raw.trim()) return null;
  let eventType = 'message';
  const dataLines: string[] = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith(':')) continue;
    if (line.startsWith('event:')) eventType = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0) return null;

  const dataStr = dataLines.join('\n');
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(dataStr);
  } catch {
    return { type: 'chunk', delta: dataStr, raw: dataStr };
  }

  switch (eventType) {
    case 'chunk':
      return {
        type: 'chunk',
        delta: typeof data.delta === 'string' ? data.delta : '',
        index: typeof data.index === 'number' ? data.index : undefined,
        raw: data,
      };
    case 'meter':
      return {
        type: 'meter',
        tokens: typeof data.tokens === 'number' ? data.tokens : undefined,
        elapsed_ms: typeof data.elapsed_ms === 'number' ? data.elapsed_ms : undefined,
        raw: data,
      };
    case 'completed':
      return {
        type: 'completed',
        result: data.result,
        billing: (data.billing as BillingSummary) ?? { charged: false, amount_usdc: 0 },
        raw: data,
      };
    case 'error':
      return {
        type: 'error',
        error: (data.error as { code: string; message: string }) ?? { code: 'UNKNOWN', message: 'unknown' },
        raw: data,
      };
    case 'cancelled':
      return {
        type: 'cancelled',
        reason: typeof data.reason === 'string' ? data.reason : undefined,
        billing: data.billing as BillingSummary | undefined,
        raw: data,
      };
    default:
      return null;
  }
}
