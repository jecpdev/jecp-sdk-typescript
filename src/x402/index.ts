/**
 * x402 payment integration for JECP SDK (v0.8.0).
 *
 * Public re-exports — see `client.ts` for the high-level `JecpClient`
 * integration (mode='auto'|'wallet'|'x402').
 *
 * Locked design: docs/jecp/x402-integration-locked-design.md §3 + §6.
 */

export type {
  PaymentMethod,
  PaymentMode,
  PaymentConfig,
  Signer,
  EIP3009AuthorizationParams,
  PaymentRequirement,
  StripeWalletRequirement,
  X402ExactRequirement,
  PaymentChallenge,
  X402PaymentPayload,
  X402PaymentResponse,
  X402Receipt,
  CostEstimate,
} from './types.js';

export {
  buildX402Payload,
  buildEIP3009Params,
  encodeXPaymentHeader,
  decodeXPaymentResponseHeader,
  findX402Requirement,
  networkToChainId,
  freshNonce,
  packSignature,
} from './payload.js';

// v0.8.2 — H-4.1 Signer helpers (panel-4 §A.3 / audit-D fix).
// Lazy-load `ethers` peer dep; not bundled into browser entry.
export {
  walletFromEnv,
  walletFromPrivateKey,
  type WalletFromEnvOptions,
} from './signers/index.js';
