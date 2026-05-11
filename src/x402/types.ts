/**
 * x402 payment types — JECP Spec v1.1.0 (Locked Design §3, §6.1, §6.3).
 *
 * x402 is the parallel-mode payment path on `/v1/invoke`:
 *   1. Hub returns 402 with `payment.accepts[]` listing schemes
 *   2. Agent signs EIP-3009 transferWithAuthorization → base64 → X-Payment header
 *   3. Hub verifies + settles via facilitator → on-chain 85/10/5 split → 200 OK
 *
 * The SDK is library-agnostic: callers inject a `Signer` adapter (ethers,
 * viem, AWS KMS, etc.) that knows how to produce an ECDSA v/r/s for the
 * EIP-712 typed-data hash. The SDK never holds raw private keys.
 *
 * Spec: https://github.com/jecpdev/jecp-spec/blob/main/spec/04-x402-integration.md
 * Locked design: docs/jecp/x402-integration-locked-design.md
 */

/** Which payment rail to use for a given invoke call. */
export type PaymentMethod = 'wallet' | 'x402';

/**
 * SDK payment mode.
 * - `wallet`: Stripe wallet path only; never attempt x402.
 * - `x402`: x402 (USDC on Base) only; throw if signer absent or capability rejects.
 * - `auto` (default): try x402 first if a `Signer` is configured AND the 402's
 *   `accepts[]` exposes an x402 entry; fall back to wallet on x402 failure if
 *   wallet has balance. Per admiral E (locked-design §2).
 */
export type PaymentMode = 'wallet' | 'x402' | 'auto';

/**
 * EIP-3009 `transferWithAuthorization` parameters (Locked design §3.2).
 *
 * The Signer adapter is responsible for producing the EIP-712 typed-data
 * digest from these fields and signing it with the agent's Base wallet key.
 *
 * Reference: https://eips.ethereum.org/EIPS/eip-3009
 */
export interface EIP3009AuthorizationParams {
  /** Payer EOA (the agent's Base address). */
  from: `0x${string}`;
  /** Recipient — the JECP Splitter contract address (from 402 `pay_to`). */
  to: `0x${string}`;
  /** USDC amount in micros (1 USDC = 1_000_000). Spec §3.1 `amount`. */
  value: bigint;
  /** Unix seconds — earliest the authorization is valid (typically 0 or `now`). */
  validAfter: bigint;
  /** Unix seconds — latest the authorization is valid (typically `now + max_timeout_seconds`). */
  validBefore: bigint;
  /** 32-byte random hex (replay defense). */
  nonce: `0x${string}`;
  /** EIP-155 chain id — 8453 for Base mainnet, 84532 for Base Sepolia. */
  chainId: number;
  /** USDC ERC-20 contract address — from 402 `asset`. */
  verifyingContract: `0x${string}`;
}

/**
 * Signer adapter — bring-your-own wallet, the SDK never sees the private key.
 *
 * Implementations exist as thin wrappers around:
 * - `ethers.Wallet` (via `signTypedData`)
 * - `viem` `WalletClient` (via `signTypedData`)
 * - AWS KMS / GCP KMS / hardware wallets (via vendor SDKs)
 *
 * The Signer's only job is to compute the ECDSA signature over the EIP-3009
 * typed-data digest and return `{ v, r, s }`. The SDK assembles the rest.
 */
export interface Signer {
  /** Return the EOA address this signer signs for. */
  getAddress(): Promise<`0x${string}`>;

  /**
   * Sign the EIP-3009 `transferWithAuthorization` typed-data digest.
   *
   * The signer is responsible for:
   * 1. Building the EIP-712 domain from `chainId` + `verifyingContract`
   * 2. Hashing the `TransferWithAuthorization` struct
   * 3. Producing the ECDSA signature
   *
   * Returns the canonical `{ v, r, s }` components. The SDK serializes
   * these into `signature = "0x" + r + s + v.toString(16).padStart(2, '0')`
   * for the X-Payment payload (the x402 spec accepts the concatenated form).
   */
  signEIP3009(params: EIP3009AuthorizationParams): Promise<{
    v: number;
    r: `0x${string}`;
    s: `0x${string}`;
  }>;
}

/**
 * One entry in the 402 response's `payment.accepts[]` array (Locked §3.1).
 * Stripe-wallet entry is listed first per admiral D; x402 entries follow.
 */
export type PaymentRequirement =
  | StripeWalletRequirement
  | X402ExactRequirement;

export interface StripeWalletRequirement {
  scheme: 'stripe-wallet';
  /** Charge in USD. Mirror of `details.amount_usd`. */
  amount_usd: number;
  /** Hub-hosted Stripe Checkout deep-link to top up. */
  topup_url: string;
}

/** x402 v1 "exact" scheme — single, fixed amount in a single ERC-20. */
export interface X402ExactRequirement {
  scheme: 'exact';
  /** "base" for Base mainnet (8453); "base-sepolia" for testnet (84532). */
  network: 'base' | 'base-sepolia';
  /** ERC-20 contract address (USDC). */
  asset: `0x${string}`;
  /** Friendly symbol — typically "USDC". */
  asset_symbol?: string;
  /** Decimals — 6 for USDC. */
  asset_decimals?: number;
  /** Required amount in atomic units (string for safe JSON; convert to bigint). */
  amount: string;
  /** Convenience copy of `amount`. */
  max_amount_required: string;
  /** Splitter contract address — the EIP-3009 `to`. */
  pay_to: `0x${string}`;
  /** Echo of the invoke URL (replay-binding context). */
  resource: string;
  description: string;
  mime_type?: string;
  /** Seconds the authorization is valid for. SDK uses this for `validBefore`. */
  max_timeout_seconds: number;
  /** Out-of-band hints. */
  extra?: {
    /** On-chain bytes32 capability id (split-params lookup key). */
    splitter_capability_id?: string;
    /** Facilitator HTTP base URL. */
    facilitator_url?: string;
  };
}

/** The full `payment` field on a 402 envelope. */
export interface PaymentChallenge {
  accepts: PaymentRequirement[];
  /** Seconds the challenge is valid for (SDK should re-fetch if exceeded). */
  ttl_seconds?: number;
}

/**
 * X402 v1 PaymentPayload — base64-encoded and sent as `X-Payment` header.
 * Locked design §3.2.
 */
export interface X402PaymentPayload {
  x402Version: 1;
  scheme: 'exact';
  network: 'base' | 'base-sepolia';
  payload: {
    /** Concatenated ECDSA signature: `0x` + r + s + v (65 bytes hex). */
    signature: `0x${string}`;
    authorization: {
      from: `0x${string}`;
      to: `0x${string}`;
      value: string;       // bigint serialized as decimal string
      validAfter: string;  // bigint serialized as decimal string
      validBefore: string; // bigint serialized as decimal string
      nonce: `0x${string}`;
    };
  };
}

/**
 * Decoded `X-Payment-Response` header (base64 JSON) — Locked design §3.4.
 * Returned by Hub on successful x402 invoke; attached to InvokeResult.payment.
 */
export interface X402PaymentResponse {
  success: true;
  /** Settlement transaction hash on Base. */
  txHash: `0x${string}`;
  /** Network identifier — typically "base". */
  networkId: string;
}

/**
 * Receipt attached to InvokeResult when the call was paid via x402.
 * Per locked design §6.3 (Panel 4 receipt shape).
 */
export interface X402Receipt {
  method: 'x402';
  /** Settlement tx hash on Base. */
  txHash: `0x${string}`;
  /** Network id from X-Payment-Response. */
  networkId: string;
  /** USD-equivalent of the settled amount. */
  amount_usd: number;
  /** USDC micros sent. */
  amount_usdc: bigint;
}

/** Cost estimate returned by `JecpClient.estimateCost()` — Locked §6.3. */
export interface CostEstimate {
  /** USD per call. */
  usd: number;
  /** USDC in atomic units (1 USDC = 1_000_000 micros). */
  usdc: bigint;
  /**
   * Rough Base-chain gas estimate for the settlement, in USD.
   * Typical range $0.001-0.01 at 2026 Base gas prices.
   */
  gasEstimateUsd: number;
}

/** SDK payment config (Locked design §6.1 constructor). */
export interface PaymentConfig {
  /** Default `'auto'`. See `PaymentMode` for behavior. */
  mode?: PaymentMode;
  /** Required if mode='x402' OR mode='auto' AND you want x402 attempted. */
  signer?: Signer;
  /** Default 30_000ms. Aborts facilitator round-trip if exceeded. */
  facilitatorTimeoutMs?: number;
}
