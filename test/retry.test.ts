import { describe, it, expect } from 'vitest';
import {
  DEFAULT_RETRY,
  delayForAttempt,
  isRetriableError,
  sleep,
} from '../src/retry.js';

describe('isRetriableError', () => {
  it('retries on 5xx status', () => {
    expect(isRetriableError(500)).toBe(true);
    expect(isRetriableError(502)).toBe(true);
    expect(isRetriableError(503)).toBe(true);
    expect(isRetriableError(599)).toBe(true);
  });

  it('retries on 408 timeout', () => {
    expect(isRetriableError(408)).toBe(true);
  });

  it('retries on 429 rate limit', () => {
    expect(isRetriableError(429)).toBe(true);
  });

  it('does NOT retry on 4xx client errors', () => {
    expect(isRetriableError(400)).toBe(false);
    expect(isRetriableError(401)).toBe(false);
    expect(isRetriableError(402)).toBe(false);
    expect(isRetriableError(403)).toBe(false);
    expect(isRetriableError(404)).toBe(false);
  });

  it('retries on NETWORK_ERROR code regardless of status', () => {
    expect(isRetriableError(0, 'NETWORK_ERROR')).toBe(true);
  });

  it('retries on RATE_LIMITED code', () => {
    expect(isRetriableError(429, 'RATE_LIMITED')).toBe(true);
    expect(isRetriableError(200, 'RATE_LIMITED')).toBe(true);
  });

  it('does NOT retry on 200 status with no special code', () => {
    expect(isRetriableError(200)).toBe(false);
  });
});

describe('delayForAttempt', () => {
  it('grows exponentially without jitter', () => {
    const cfg = { ...DEFAULT_RETRY, jitterFactor: 0 };
    expect(delayForAttempt(0, cfg)).toBe(250);
    expect(delayForAttempt(1, cfg)).toBe(500);
    expect(delayForAttempt(2, cfg)).toBe(1000);
    expect(delayForAttempt(3, cfg)).toBe(2000);
    expect(delayForAttempt(4, cfg)).toBe(4000);
  });

  it('caps at maxDelayMs', () => {
    const cfg = { ...DEFAULT_RETRY, jitterFactor: 0 };
    expect(delayForAttempt(10, cfg)).toBe(8000); // would be 256000 without cap
    expect(delayForAttempt(20, cfg)).toBe(8000);
  });

  it('jitter stays within ±jitterFactor of base', () => {
    const cfg = { ...DEFAULT_RETRY, jitterFactor: 0.3 };
    for (let i = 0; i < 100; i++) {
      const d = delayForAttempt(2, cfg); // base 1000
      expect(d).toBeGreaterThanOrEqual(700);  // 1000 - 300
      expect(d).toBeLessThanOrEqual(1300);    // 1000 + 300
    }
  });

  it('honors retryAfterSec as floor', () => {
    const cfg = { ...DEFAULT_RETRY, jitterFactor: 0 };
    const d = delayForAttempt(0, cfg, 5); // base 250 ms, but retry_after says 5s
    expect(d).toBe(5000);
  });

  it('uses computed delay when retryAfterSec is smaller', () => {
    const cfg = { ...DEFAULT_RETRY, jitterFactor: 0 };
    const d = delayForAttempt(3, cfg, 1); // base 2000 ms, retry_after says 1s
    expect(d).toBe(2000);
  });
});

describe('sleep', () => {
  it('resolves after ms', async () => {
    const start = Date.now();
    await sleep(50);
    expect(Date.now() - start).toBeGreaterThanOrEqual(45);
  });

  it('rejects with AbortError when signal aborts', async () => {
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 20);
    await expect(sleep(1000, ctl.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects immediately if signal is already aborted', async () => {
    const ctl = new AbortController();
    ctl.abort();
    await expect(sleep(1000, ctl.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});
