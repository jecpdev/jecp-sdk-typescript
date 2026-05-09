/**
 * JECP Agent client — invoke capabilities, manage wallet, discover catalog.
 *
 * v0.2: auto-retry, AbortSignal, per-call timeout, logger injection.
 *
 * @example
 *   import { JecpClient } from '@jecpdev/sdk';
 *   const jecp = new JecpClient({ agentId, apiKey });
 *   const result = await jecp.invoke('jobdonebot/content-factory', 'translate', {
 *     text: 'Hello', target_lang: 'JA'
 *   });
 */

import type {
  AgentRegisterRequest,
  AgentRegisterResponse,
  CatalogResponse,
  CatalogQueryOptions,
  InvokeOptions,
  InvokeSuccess,
  JecpClientOptions,
  ProviderRef,
  BillingSummary,
  TopupRequest,
  TopupResponse,
} from './types.js';
import { JecpError } from './errors.js';
import {
  DEFAULT_RETRY,
  delayForAttempt,
  isRetriableError,
  sleep,
  type RetryConfig,
} from './retry.js';
import { noopLogger, type Logger } from './logger.js';

const DEFAULT_BASE_URL = 'https://jecp.dev';
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * The result returned by `JecpClient.invoke()`. Convenience wrapper around
 * the JECP envelope so users can read `.output` directly while still having
 * `.billing` and `.provider` available.
 */
export interface InvokeResult<T = unknown> {
  /** Provider's `result` field — the actual output. */
  output: T;
  /** Billing details (charged, amount, balance after, revenue split). */
  billing: BillingSummary;
  /** Which provider/capability/version handled the call. */
  provider: ProviderRef;
  /** Wallet balance after this call (if charged). */
  wallet_balance_after?: number;
  /** Original JECP envelope (for advanced cases). */
  envelope: InvokeSuccess<T>;
  /** Number of retry attempts taken before this call succeeded (0 = first try). */
  attempts: number;
  /** Idempotency key actually sent (the JECP `id` field). */
  request_id: string;
}

export class JecpClient {
  public readonly baseUrl: string;
  private readonly agentId: string;
  private readonly apiKey: string;
  private readonly defaultTimeoutMs: number;
  private readonly retryConfig: RetryConfig;
  private readonly logger: Logger;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: JecpClientOptions) {
    if (!opts.agentId) throw new Error('JecpClient: agentId is required');
    if (!opts.apiKey) throw new Error('JecpClient: apiKey is required');
    this.agentId = opts.agentId;
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.defaultTimeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retryConfig = { ...DEFAULT_RETRY, ...(opts.retryConfig ?? {}) };
    this.logger = opts.logger ?? noopLogger;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  /**
   * Invoke a JECP capability. Auto-retries transient failures (5xx, 408, 429, network).
   * Throws a typed JecpError on terminal failure with `.nextAction` for recovery.
   *
   * @example
   *   const r = await jecp.invoke('deepl/translate', 'translate', input, {
   *     mandate: { budget_usdc: 1.00 },
   *     timeoutMs: 60_000,
   *     signal: abortController.signal,
   *   });
   */
  async invoke<T = unknown>(
    capability: string,
    action: string,
    input: unknown,
    options: InvokeOptions = {},
  ): Promise<InvokeResult<T>> {
    const request_id = options.requestId ?? randomId();
    const body = {
      jecp: '1.0' as const,
      id: request_id,
      capability,
      action,
      input,
      ...(options.mandate && {
        mandate: this.normalizeMandate(options.mandate),
      }),
    };

    const { data, attempts } = await this.requestWithRetry<InvokeSuccess<T>>({
      method: 'POST',
      path: '/v1/invoke',
      body,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      authed: true,
    });

    return {
      output: data.result,
      billing: data.billing,
      provider: data.provider,
      wallet_balance_after: data.wallet_balance_after,
      envelope: data,
      attempts,
      request_id,
    };
  }

  /**
   * List capabilities (W3 — cursor-paginated by default since 2026-05-09).
   *
   * For all-in-one fetch (legacy / simple cases), use `.catalogAll()`.
   * For iteration over pages, use `.catalogPages()` async iterator.
   *
   * @example
   *   const page1 = await jecp.catalog({ pageSize: 50 });
   *   if (page1.has_more) {
   *     const page2 = await jecp.catalog({ cursor: page1.next_cursor!, pageSize: 50 });
   *   }
   */
  async catalog(options: CatalogQueryOptions = {}): Promise<CatalogResponse> {
    const params = new URLSearchParams();
    if (options.cursor) params.set('cursor', options.cursor);
    if (options.pageSize !== undefined) params.set('page_size', String(options.pageSize));
    if (options.namespace) params.set('namespace', options.namespace);
    if (options.tags && options.tags.length > 0) params.set('tags', options.tags.join(','));
    const qs = params.toString();
    const path = qs ? `/v1/capabilities?${qs}` : '/v1/capabilities';
    const { data } = await this.requestWithRetry<CatalogResponse>({
      method: 'GET',
      path,
      authed: false,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    });
    return data;
  }

  /**
   * Fetch the entire catalog at once via legacy mode (`?paginated=false`).
   * Returns up to 200 items in a single response. Use `.catalogPages()` for true pagination.
   */
  async catalogAll(options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<CatalogResponse> {
    const { data } = await this.requestWithRetry<CatalogResponse>({
      method: 'GET',
      path: '/v1/capabilities?paginated=false',
      authed: false,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    });
    return data;
  }

  /**
   * Async iterator over catalog pages. Continues until `next_cursor` is null.
   *
   * @example
   *   for await (const page of jecp.catalogPages({ pageSize: 100 })) {
   *     for (const cap of page.third_party_capabilities ?? []) {
   *       console.log(cap.id);
   *     }
   *   }
   */
  async *catalogPages(options: Omit<CatalogQueryOptions, 'cursor'> = {}): AsyncIterableIterator<CatalogResponse> {
    let cursor: string | undefined;
    while (true) {
      const page = await this.catalog({ ...options, ...(cursor && { cursor }) });
      yield page;
      if (!page.has_more || !page.next_cursor) break;
      cursor = page.next_cursor;
    }
  }

  /**
   * Create a Stripe Checkout session to top up the agent's wallet.
   */
  async topup(
    amount: 5 | 20 | 100,
    options: { returnTo?: string; signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<TopupResponse> {
    if (![5, 20, 100].includes(amount)) {
      throw new Error('JecpClient.topup: amount must be 5, 20, or 100');
    }
    const body: TopupRequest = { amount, ...(options.returnTo && { returnTo: options.returnTo }) };
    const { data } = await this.requestWithRetry<TopupResponse>({
      method: 'POST',
      path: '/api/agents/topup',
      body,
      authed: true,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    });
    return data;
  }

  /**
   * Get a personalized share kit for spreading JECP to other agents/developers.
   */
  async shareKit(options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<unknown> {
    const { data } = await this.requestWithRetry<unknown>({
      method: 'GET',
      path: '/api/agents/share-kit',
      authed: true,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    });
    return data;
  }

  // ─── static methods ────────────────────────────────────────

  /**
   * Register a new JECP agent. Returns agent_id + api_key — save them, they're
   * shown only once.
   */
  static async register(
    request: AgentRegisterRequest,
    baseUrl: string = DEFAULT_BASE_URL,
  ): Promise<AgentRegisterResponse> {
    const url = `${baseUrl.replace(/\/+$/, '')}/api/agents/register`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
    if (!res.ok) {
      const errBody = (await res.json().catch(() => ({}))) as { error?: string };
      throw JecpError.fromBody(
        { error: { code: 'REGISTER_FAILED', message: errBody.error || 'Registration failed' } },
        res.status,
      );
    }
    return res.json() as Promise<AgentRegisterResponse>;
  }

  /**
   * Fetch /.well-known/agent-guide.json — machine-readable spec for AI agents.
   */
  static async agentGuide(baseUrl: string = DEFAULT_BASE_URL): Promise<unknown> {
    const url = `${baseUrl.replace(/\/+$/, '')}/.well-known/agent-guide.json`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`agent-guide.json not available: ${res.status}`);
    return res.json();
  }

  // ─── internals ─────────────────────────────────────────────

  private headers(authed: boolean, extra: Record<string, string> = {}): Record<string, string> {
    const base: Record<string, string> = { 'Content-Type': 'application/json', ...extra };
    if (authed) {
      base['X-Agent-ID'] = this.agentId;
      base['X-API-Key'] = this.apiKey;
    }
    return base;
  }

  private async requestWithRetry<T>(opts: {
    method: string;
    path: string;
    body?: unknown;
    authed: boolean;
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<{ data: T; attempts: number }> {
    const maxAttempts = this.retryConfig.maxRetries + 1;
    let lastError: JecpError | undefined;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const data = await this.requestOnce<T>(opts);
        return { data, attempts: attempt };
      } catch (e) {
        if (!(e instanceof JecpError)) throw e;
        lastError = e;

        const retriable = isRetriableError(e.status, e.code);
        const isLast = attempt === maxAttempts - 1;
        if (!retriable || isLast) {
          this.logger.error?.(`request failed (attempt ${attempt + 1}/${maxAttempts})`, {
            method: opts.method,
            path: opts.path,
            code: e.code,
            status: e.status,
            retriable,
          });
          throw e;
        }

        // Compute next-attempt delay (honor Retry-After header from RateLimitError context)
        const retryAfterSec = (e.raw as { retry_after_sec?: number } | undefined)?.retry_after_sec;
        const delayMs = delayForAttempt(attempt, this.retryConfig, retryAfterSec);
        this.logger.warn?.(`retrying after ${Math.round(delayMs)}ms`, {
          method: opts.method,
          path: opts.path,
          attempt: attempt + 1,
          maxAttempts,
          code: e.code,
        });
        await sleep(delayMs, opts.signal);
      }
    }

    // Unreachable — loop always returns or throws
    throw lastError ?? new Error('JecpClient: retry loop exhausted unexpectedly');
  }

  private async requestOnce<T>(opts: {
    method: string;
    path: string;
    body?: unknown;
    authed: boolean;
    signal?: AbortSignal;
    timeoutMs?: number;
  }): Promise<T> {
    const url = `${this.baseUrl}${opts.path}`;
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;

    const internalCtl = new AbortController();
    const timeoutId = setTimeout(() => internalCtl.abort(), timeoutMs);
    const onExternalAbort = () => internalCtl.abort();
    if (opts.signal) opts.signal.addEventListener('abort', onExternalAbort);

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: opts.method,
        headers: this.headers(opts.authed),
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: internalCtl.signal,
      });
    } catch (e) {
      // Distinguish abort from network error
      const wasAborted = opts.signal?.aborted;
      const wasTimedOut = !wasAborted && internalCtl.signal.aborted;
      const message =
        wasAborted ? 'Request aborted by caller' :
        wasTimedOut ? `Request timed out after ${timeoutMs}ms` :
        e instanceof Error ? e.message : 'Network error';
      throw new JecpError({
        code: wasAborted ? 'ABORTED' : (wasTimedOut ? 'TIMEOUT' : 'NETWORK_ERROR'),
        message,
        status: 0,
        raw: e,
      });
    } finally {
      clearTimeout(timeoutId);
      opts.signal?.removeEventListener('abort', onExternalAbort);
    }

    const text = await res.text();
    let data: { status?: string; error?: { code?: string; message?: string }; next_action?: unknown };
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new JecpError({
        code: 'INVALID_RESPONSE',
        message: `Non-JSON response: ${text.slice(0, 200)}`,
        status: res.status,
        raw: text,
      });
    }

    if (!res.ok || data.status === 'failed') {
      // Capture Retry-After header for rate limit handling
      const retryAfter = res.headers.get('retry-after');
      const enrichedRaw = retryAfter
        ? { ...(data as object), retry_after_sec: parseInt(retryAfter, 10) }
        : data;
      throw JecpError.fromBody(
        { ...(data as object), ...(retryAfter && { retry_after_sec: parseInt(retryAfter, 10) }) } as Parameters<typeof JecpError.fromBody>[0],
        res.status,
      );
    }
    return data as T;
  }

  private normalizeMandate(
    m: NonNullable<InvokeOptions['mandate']>,
  ): { agent_id: string; api_key: string; budget_usdc?: number; expires_at?: string } {
    if ('agent_id' in m && 'api_key' in m) {
      return m;
    }
    const out: { agent_id: string; api_key: string; budget_usdc?: number; expires_at?: string } = {
      agent_id: this.agentId,
      api_key: this.apiKey,
    };
    if (m.budget_usdc !== undefined) out.budget_usdc = m.budget_usdc;
    if (m.expires_at) out.expires_at = m.expires_at;
    return out;
  }
}

// ─── helpers ─────────────────────────────────────────────────

function randomId(): string {
  // RFC4122 v4 — fine for request idempotency
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return (crypto as { randomUUID(): string }).randomUUID();
  }
  return 'jecp-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}
