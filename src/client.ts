/**
 * JECP Agent client — invoke capabilities, manage wallet, discover catalog.
 *
 * Usage:
 *   import { JecpClient } from '@jecpdev/sdk';
 *   const jecp = new JecpClient({ agentId, apiKey });
 *   const result = await jecp.invoke('jobdonebot/content-factory', 'translate', {
 *     text: 'Hello', target_lang: 'JA'
 *   });
 */

import type {
  AgentRegisterRequest,
  AgentRegisterResponse,
  BillingSummary,
  CatalogResponse,
  InvokeOptions,
  InvokeSuccess,
  JecpClientOptions,
  ProviderRef,
  TopupRequest,
  TopupResponse,
} from './types.js';
import { JecpError } from './errors.js';

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
}

export class JecpClient {
  public readonly baseUrl: string;
  private readonly agentId: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: JecpClientOptions) {
    if (!opts.agentId) throw new Error('JecpClient: agentId is required');
    if (!opts.apiKey) throw new Error('JecpClient: apiKey is required');
    this.agentId = opts.agentId;
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  /**
   * Invoke a JECP capability. Throws a typed JecpError on failure with `next_action`.
   *
   * @example
   * const result = await jecp.invoke('deepl/translate', 'translate', {
   *   text: 'Hello', target_lang: 'JA'
   * });
   * console.log(result.output);          // { translated: 'こんにちは' }
   * console.log(result.billing.charged); // true
   * console.log(result.wallet_balance_after); // 19.995
   */
  async invoke<T = unknown>(
    capability: string,
    action: string,
    input: unknown,
    options: InvokeOptions = {},
  ): Promise<InvokeResult<T>> {
    const body = {
      jecp: '1.0' as const,
      id: options.requestId ?? randomId(),
      capability,
      action,
      input,
      ...(options.mandate && {
        mandate: this.normalizeMandate(options.mandate),
      }),
    };

    const data = await this.post<InvokeSuccess<T>>('/v1/invoke', body, options.signal);

    return {
      output: data.result,
      billing: data.billing,
      provider: data.provider,
      wallet_balance_after: data.wallet_balance_after,
      envelope: data,
    };
  }

  /**
   * List all live capabilities (core + third-party).
   * No authentication required — this is a public catalog.
   */
  async catalog(): Promise<CatalogResponse> {
    return this.get<CatalogResponse>('/v1/capabilities');
  }

  /**
   * Create a Stripe Checkout session to top up the agent's wallet.
   * Returns a `url` to open in browser; balance is credited via webhook on payment.
   */
  async topup(amount: 5 | 20 | 100, returnTo?: string): Promise<TopupResponse> {
    const body: TopupRequest = { amount, ...(returnTo && { returnTo }) };
    return this.post<TopupResponse>('/api/agents/topup', body);
  }

  /**
   * Get a personalized share kit for spreading JECP to other agents/developers.
   * Includes referral URL, ethical guidelines, and pre-written messages.
   */
  async shareKit(): Promise<unknown> {
    return this.getAuthed<unknown>('/api/agents/share-kit');
  }

  // ─── static methods ────────────────────────────────────────

  /**
   * Register a new JECP agent. Returns agent_id + api_key (one-time only — save them).
   * No authentication required for registration itself.
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
      const errBody = await res.json().catch(() => ({}));
      throw JecpError.fromBody(
        { error: { code: 'REGISTER_FAILED', message: errBody.error || 'Registration failed' } },
        res.status,
      );
    }
    return res.json() as Promise<AgentRegisterResponse>;
  }

  /**
   * Fetch the JECP agent guide JSON — machine-readable spec for AI agents
   * to understand what JECP is and how to use/spread it.
   */
  static async agentGuide(baseUrl: string = DEFAULT_BASE_URL): Promise<unknown> {
    const url = `${baseUrl.replace(/\/+$/, '')}/.well-known/agent-guide.json`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`agent-guide.json not available: ${res.status}`);
    return res.json();
  }

  // ─── internals ─────────────────────────────────────────────

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      'X-Agent-ID': this.agentId,
      'X-API-Key': this.apiKey,
      'Content-Type': 'application/json',
      ...extra,
    };
  }

  private async post<T>(
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.request<T>('POST', path, body, signal);
  }

  private async get<T>(path: string, signal?: AbortSignal): Promise<T> {
    return this.request<T>('GET', path, undefined, signal);
  }

  private async getAuthed<T>(path: string, signal?: AbortSignal): Promise<T> {
    return this.request<T>('GET', path, undefined, signal, true);
  }

  private async request<T>(
    method: string,
    path: string,
    body: unknown,
    signal?: AbortSignal,
    authed: boolean = method !== 'GET' || path.includes('/agents/'),
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const ctl = new AbortController();
    const timeoutId = setTimeout(() => ctl.abort(), this.timeoutMs);
    if (signal) signal.addEventListener('abort', () => ctl.abort());

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: authed ? this.headers() : { 'Content-Type': 'application/json' },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctl.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    const text = await res.text();
    let data: any;
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
      throw JecpError.fromBody(data, res.status);
    }
    return data as T;
  }

  private normalizeMandate(
    m: NonNullable<InvokeOptions['mandate']>,
  ): { agent_id: string; api_key: string; budget_usdc?: number; expires_at?: string } {
    if ('agent_id' in m && 'api_key' in m) {
      return m;
    }
    return {
      agent_id: this.agentId,
      api_key: this.apiKey,
      ...(m.budget_usdc !== undefined && { budget_usdc: m.budget_usdc }),
      ...(m.expires_at && { expires_at: m.expires_at }),
    };
  }
}

// ─── helpers ─────────────────────────────────────────────────

function randomId(): string {
  // RFC4122 v4 lite — fine for request idempotency
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return (crypto as { randomUUID(): string }).randomUUID();
  }
  return 'jecp-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}
