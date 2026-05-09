/**
 * Retry policy — exponential backoff with full jitter.
 *
 * Matches the patterns used by Stripe / Anthropic / OpenAI SDKs:
 * - Retries on transient errors (5xx, 408, 429, network failures)
 * - Respects server's `Retry-After` header when present
 * - Idempotency-Key (the JECP `id` field) preserved across retries
 * - Honors AbortSignal between attempts
 */

export interface RetryConfig {
  /** Maximum retry attempts on top of the initial request. Default 3. */
  maxRetries: number;
  /** Initial delay in ms. Default 250. */
  initialDelayMs: number;
  /** Maximum delay between attempts in ms. Default 8000. */
  maxDelayMs: number;
  /** Backoff multiplier per attempt. Default 2 (so: 250 → 500 → 1000 → 2000…). */
  backoffMultiplier: number;
  /** Jitter as fraction of delay (0..1). Default 0.3 (±30%). */
  jitterFactor: number;
}

export const DEFAULT_RETRY: RetryConfig = {
  maxRetries: 3,
  initialDelayMs: 250,
  maxDelayMs: 8000,
  backoffMultiplier: 2,
  jitterFactor: 0.3,
};

/**
 * True if a status/code combination indicates a transient error worth retrying.
 *
 * Retriable:
 * - 408 (timeout), 429 (rate limit), 5xx (server)
 * - code='NETWORK_ERROR' (fetch failed)
 * - code='RATE_LIMITED' (regardless of status — server returned a structured rate-limit)
 *
 * Non-retriable: client errors (4xx except 408/429), business errors (e.g. INSUFFICIENT_BALANCE).
 */
export function isRetriableError(status: number, code?: string): boolean {
  if (status === 408 || status === 429) return true;
  if (status >= 500 && status < 600) return true;
  if (code === 'NETWORK_ERROR') return true;
  if (code === 'RATE_LIMITED') return true;
  return false;
}

/**
 * Compute delay (ms) before the next retry attempt.
 *
 * @param attempt - 0 for first retry, 1 for second, etc.
 * @param cfg - retry configuration
 * @param retryAfterSec - if server returned `Retry-After` header (in seconds), honor it as a floor
 */
export function delayForAttempt(
  attempt: number,
  cfg: RetryConfig = DEFAULT_RETRY,
  retryAfterSec?: number,
): number {
  const exp = cfg.initialDelayMs * Math.pow(cfg.backoffMultiplier, attempt);
  const capped = Math.min(exp, cfg.maxDelayMs);
  // Full jitter: [capped*(1-jitter), capped*(1+jitter)]
  const jitter = capped * cfg.jitterFactor * (Math.random() * 2 - 1);
  const computed = Math.max(0, capped + jitter);

  if (retryAfterSec !== undefined && retryAfterSec > 0) {
    return Math.max(computed, retryAfterSec * 1000);
  }
  return computed;
}

/**
 * Sleep for the given number of milliseconds, abortable via AbortSignal.
 * Throws an AbortError if the signal fires while waiting.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort);
  });
}

function abortError(): Error {
  const err = new Error('Aborted');
  err.name = 'AbortError';
  return err;
}
