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
} from './errors.js';

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
