/**
 * @jecpdev/sdk/browser — browser/edge runtime entry point.
 *
 * Imports the JecpClient (which uses fetch — works everywhere) plus
 * the WebCrypto-based JecpProvider, and skips the node:crypto-based one.
 *
 * Use this in:
 * - Cloudflare Workers
 * - Deno
 * - Vite/webpack browser builds
 * - Bun browser-side
 *
 * @example
 *   import { JecpClient, JecpProvider } from '@jecpdev/sdk/browser';
 */

export { JecpClient } from './client.js';
export type { InvokeResult } from './client.js';

export { JecpProvider } from './provider-browser.js';
export type {
  ProviderHandlerFn,
  ParsedJecpRequest,
  JecpProviderOptions,
} from './provider-browser.js';

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
  DEFAULT_RETRY,
  isRetriableError,
  delayForAttempt,
} from './retry.js';
export type { RetryConfig } from './retry.js';

export { JecpStream } from './streaming.js';
export type { StreamEvent, InvokeStreamOptions } from './streaming.js';

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
