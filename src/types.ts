/**
 * JECP type definitions — JSON shapes for the Joint Execution & Commerce Protocol.
 * Spec: https://github.com/jecpdev/jecp-spec
 */

// ─── Mandate (Spec §4) ───────────────────────────────────────

export interface Mandate {
  agent_id: string;
  api_key: string;
  /** Optional budget cap in USDC. If set, calls exceeding this fail with 402. */
  budget_usdc?: number;
  /** ISO 8601 expiry. Mandate ignored / rejected after this time. */
  expires_at?: string;
  /** Optional provenance hash for identity proof. */
  provenance_hash?: string;
}

// ─── Invoke ──────────────────────────────────────────────────

export interface InvokeRequest {
  jecp: '1.0';
  id: string;
  capability: string; // "namespace/capability"
  action: string;
  input: unknown;
  mandate?: Mandate;
}

export interface BillingSummary {
  charged: boolean;
  amount_usdc: number;
  transaction_id?: string;
  balance_after?: number;
  provider_share_usdc?: number;
  hub_fee_usdc?: number;
  payment_fee_usdc?: number;
}

export interface ProviderRef {
  namespace: string;
  capability: string;
  version: string;
}

export interface InvokeSuccess<T = unknown> {
  jecp: '1.0';
  id: string;
  status: 'success';
  result: T;
  provider: ProviderRef;
  billing: BillingSummary;
  wallet_balance_after?: number;
}

export interface JecpErrorBody {
  jecp: '1.0';
  status: 'failed';
  error: { code: string; message: string };
  next_action?: NextAction;
}

// ─── next_action (Spec §6 — machine-readable error recovery) ──

export type NextAction =
  | { type: 'topup';                 ui?: string; api?: string; hint?: string }
  | { type: 'register';              ui?: string; api?: string; hint?: string }
  | { type: 'increase_mandate';      hint?: string }
  | { type: 'refresh_mandate';       hint?: string }
  | { type: 'retry_after';           hint?: string }
  | { type: 'discover';              api?: string; hint?: string }
  | { type: 'see_manifest';          api?: string; hint?: string }
  | { type: 'earn_trust';            hint?: string }
  | { type: 'try_alternative_provider'; api?: string; hint?: string }
  | { type: 'upgrade_client';        spec?: string; hint?: string };

// ─── Catalog ─────────────────────────────────────────────────

export interface CapabilityCatalogItem {
  id: string;            // "namespace/capability"
  namespace: string;
  name?: string;
  version: string;
  description?: string;
  tags?: string[];
  total_calls?: number;
  source?: 'core' | 'third_party';
  manifest?: ManifestData;
}

export interface ManifestData {
  namespace: string;
  capability: string;
  version: string;
  description: string;
  endpoint: string;
  actions: ManifestAction[];
  tags?: string[];
}

export interface ManifestAction {
  id: string;
  name?: string;
  description: string;
  pricing: { base: string | number; currency?: string; model?: string };
  rate_limit_rpm?: number;
  trust_tier_required?: 'bronze' | 'silver' | 'gold' | 'platinum';
  input_schema?: unknown;
  output_schema?: unknown;
  examples?: unknown[];
}

export interface CatalogResponse {
  jecp: string;
  engine: string;
  capabilities: unknown[]; // hardcoded core (variable schema)
  third_party_capabilities?: CapabilityCatalogItem[];
  third_party_count?: number;
}

// ─── Agent registration & topup ─────────────────────────────

export interface AgentRegisterRequest {
  name: string;
  agent_type?: string;
  description?: string;
  capabilities?: string[];
  homepage?: string;
  referred_by?: string;
}

export interface AgentRegisterResponse {
  agent_id: string;
  api_key: string;
  name: string;
  free_calls_remaining: number;
  endpoints?: Record<string, string>;
  spread_the_word?: unknown;
}

export interface TopupRequest {
  amount: 5 | 20 | 100;
  returnTo?: string;
}

export interface TopupResponse {
  url: string;
  sessionId: string;
}

// ─── SDK options ─────────────────────────────────────────────

export interface JecpClientOptions {
  agentId: string;
  apiKey: string;
  /** Defaults to https://jecp.dev */
  baseUrl?: string;
  /** Default 30000 ms */
  timeoutMs?: number;
  /** Custom fetch impl (e.g. for testing) */
  fetch?: typeof fetch;
}

export interface InvokeOptions {
  mandate?: Mandate | { budget_usdc: number; expires_at?: string };
  /** Override request id (default: auto-generated UUID v4) */
  requestId?: string;
  signal?: AbortSignal;
}
