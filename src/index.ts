/**
 * @jecpdev/sdk — Official TypeScript SDK for JECP
 * Joint Execution & Commerce Protocol — https://jecp.dev
 *
 * Default entry point: includes JecpClient + node-based JecpProvider.
 * For browser/edge runtimes, import from `@jecpdev/sdk/browser` instead.
 */

export { JecpClient } from './client.js';
export type { InvokeResult } from './client.js';

export { JecpProvider } from './provider.js';
export type {
  ProviderHandlerFn,
  ParsedJecpRequest,
  JecpProviderOptions,
} from './provider.js';

export {
  JecpError,
  InsufficientBalanceError,
  InsufficientBudgetError,
  MandateExpiredError,
  AuthError,
  RateLimitError,
  CapabilityNotFoundError,
  ActionNotFoundError,
  InsufficientTrustError,
  ProviderError,
  // v1.0.2 K2 wire-format errors:
  UnsupportedMediaTypeError,
  DuplicateRequestError,
  CapabilityDeprecatedError,
  InputSchemaViolationError,
  // v1.1.0 c10 security:
  UrlBlockedSsrfError,
  // v1.1.0 x402 (Locked design §3.5 + §6.3):
  X402PaymentInvalidError,
  X402NotAcceptedError,
  X402SettlementTimeoutError,
  X402FacilitatorUnreachableError,
  X402SettlementReusedError,
  InsufficientPaymentOptionsError,
  // v0.8.2 — H-6 SDK safety caps:
  X402AmountCapExceededError,
  X402HourlyCapExceededError,
  X402GasRatioExceededError,
  JecpErrorCode,
} from './errors.js';
export type { JecpErrorCodeValue, InputSchemaViolation } from './errors.js';

// ─── v1.1.0 x402 integration (Locked design §3 + §6) ─────────
export {
  buildX402Payload,
  buildEIP3009Params,
  encodeXPaymentHeader,
  decodeXPaymentResponseHeader,
  findX402Requirement,
  networkToChainId,
  freshNonce,
  packSignature,
} from './x402/payload.js';

// v0.8.2 — H-4.1 Signer helpers (Node-only; lazy-loads ethers peer dep).
export {
  walletFromEnv,
  walletFromPrivateKey,
} from './x402/signers/index.js';
export type { WalletFromEnvOptions } from './x402/signers/index.js';
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
} from './x402/types.js';

export {
  verifyWebhook,
  WebhookVerificationError,
} from './webhook.js';
export type { WebhookEvent, VerifyWebhookOptions } from './webhook.js';

export {
  computeProvenanceV2,
  computeProvenanceV1,
  verifyProvenanceV2,
  createReplayCache,
} from './provenance.js';
export type {
  ComputeProvenanceV2Input,
  VerifyProvenanceV2Input,
  VerifyProvenanceResult,
  ProvenanceSubcause,
  ReplayCache,
  ReplayCacheOptions,
} from './provenance.js';

export { JecpStream } from './streaming.js';
export type { StreamEvent, InvokeStreamOptions } from './streaming.js';

export {
  DEFAULT_RETRY,
  isRetriableError,
  delayForAttempt,
} from './retry.js';
export type { RetryConfig } from './retry.js';

export {
  noopLogger,
  consoleLogger,
} from './logger.js';
export type { Logger } from './logger.js';

export type {
  AgentRegisterRequest,
  AgentRegisterResponse,
  BillingSummary,
  CapabilityCatalogItem,
  CatalogResponse,
  CatalogQueryOptions,
  InvokeOptions,
  InvokeRequest,
  InvokeSuccess,
  JecpClientOptions,
  JecpErrorBody,
  Mandate,
  ManifestAction,
  ManifestData,
  NextAction,
  ProviderRef,
  TopupRequest,
  TopupResponse,
} from './types.js';
