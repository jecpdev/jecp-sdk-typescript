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
} from './errors.js';

export {
  verifyWebhook,
  WebhookVerificationError,
} from './webhook.js';
export type { WebhookEvent, VerifyWebhookOptions } from './webhook.js';

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
