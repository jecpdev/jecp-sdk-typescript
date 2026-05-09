import { describe, it, expect } from 'vitest';
import { JecpStream } from '../src/streaming.js';

/** Build a ReadableStream<Uint8Array> from a string of SSE events. */
function fromSse(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

const FULL_STREAM = `event: chunk
data: {"delta":"Hello","index":0}

event: chunk
data: {"delta":" world","index":1}

event: meter
data: {"tokens":12,"elapsed_ms":340}

event: completed
data: {"result":{"text":"Hello world"},"billing":{"charged":true,"amount_usdc":0.0023,"transaction_id":"tx-1"}}

`;

describe('JecpStream', () => {
  it('parses chunk + completed events in order', async () => {
    const s = new JecpStream(fromSse(FULL_STREAM));
    const events = await s.toArray();

    expect(events.length).toBe(4);
    expect(events[0]).toMatchObject({ type: 'chunk', delta: 'Hello', index: 0 });
    expect(events[1]).toMatchObject({ type: 'chunk', delta: ' world', index: 1 });
    expect(events[2]).toMatchObject({ type: 'meter', tokens: 12 });
    expect(events[3].type).toBe('completed');
  });

  it('toText() concatenates only chunks', async () => {
    const s = new JecpStream(fromSse(FULL_STREAM));
    const text = await s.toText();
    expect(text).toBe('Hello world');
  });

  it('final() returns the completed billing summary', async () => {
    const s = new JecpStream(fromSse(FULL_STREAM));
    const f = await s.final();
    expect(f.cancelled).toBe(false);
    expect(f.billing?.charged).toBe(true);
    expect(f.billing?.amount_usdc).toBe(0.0023);
    expect(f.result).toEqual({ text: 'Hello world' });
  });

  it('handles error event and stops iteration', async () => {
    const s = new JecpStream(fromSse(`event: chunk
data: {"delta":"foo"}

event: error
data: {"error":{"code":"PROVIDER_ERROR","message":"upstream failed"}}

`));
    const events = await s.toArray();
    expect(events.length).toBe(2);
    expect(events[1].type).toBe('error');
    if (events[1].type === 'error') {
      expect(events[1].error.code).toBe('PROVIDER_ERROR');
    }
  });

  it('handles cancelled event with billing', async () => {
    const s = new JecpStream(fromSse(`event: cancelled
data: {"reason":"mandate exhausted","billing":{"charged":true,"amount_usdc":0.001}}

`));
    const f = await s.final();
    expect(f.cancelled).toBe(true);
    expect(f.billing?.amount_usdc).toBe(0.001);
  });

  it('synthesizes cancelled when stream ends without terminal event', async () => {
    const s = new JecpStream(fromSse(`event: chunk
data: {"delta":"hi"}

`));
    const events = await s.toArray();
    expect(events[events.length - 1].type).toBe('cancelled');
  });

  it('responds to AbortSignal', async () => {
    const ctl = new AbortController();
    // Stream that never completes
    const neverEnding = new ReadableStream({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode(`event: chunk\ndata: {"delta":"a"}\n\n`));
        // Wait without sending anything more
        await new Promise(() => { /* hang */ });
      },
    });

    const s = new JecpStream(neverEnding, ctl.signal);
    setTimeout(() => ctl.abort(), 30);
    const events = await s.toArray();
    const lastType = events[events.length - 1]?.type;
    expect(['cancelled', 'error']).toContain(lastType);
  });

  it('treats unknown event types as no-op (forward compatibility)', async () => {
    const s = new JecpStream(fromSse(`event: future_unknown_type
data: {"foo":"bar"}

event: completed
data: {"result":{},"billing":{"charged":false,"amount_usdc":0}}

`));
    const events = await s.toArray();
    expect(events.length).toBe(1);
    expect(events[0].type).toBe('completed');
  });
});
