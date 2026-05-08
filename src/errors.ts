/**
 * JECP error classes — typed exceptions with next_action metadata for auto-recovery.
 */

import type { NextAction } from './types.js';

export class JecpError extends Error {
  public readonly code: string;
  public readonly status: number;
  public readonly nextAction?: NextAction;
  public readonly raw?: unknown;

  constructor(opts: {
    code: string;
    message: string;
    status: number;
    nextAction?: NextAction;
    raw?: unknown;
  }) {
    super(opts.message);
    this.name = 'JecpError';
    this.code = opts.code;
    this.status = opts.status;
    this.nextAction = opts.nextAction;
    this.raw = opts.raw;
  }

  /**
   * Factory: build the most specific subclass for a given error code.
   * Falls back to plain JecpError for unknown codes.
   */
  static fromBody(body: {
    error?: { code?: string; message?: string };
    next_action?: NextAction;
  }, status: number): JecpError {
    const code = body.error?.code ?? 'UNKNOWN';
    const message = body.error?.message ?? 'Unknown error';
    const nextAction = body.next_action;
    const opts = { code, message, status, nextAction, raw: body };

    switch (code) {
      case 'INSUFFICIENT_BALANCE':
        return new InsufficientBalanceError(opts);
      case 'INSUFFICIENT_BUDGET':
        return new InsufficientBudgetError(opts);
      case 'MANDATE_EXPIRED':
        return new MandateExpiredError(opts);
      case 'AUTH_REQUIRED':
      case 'INVALID_AGENT':
        return new AuthError(opts);
      case 'RATE_LIMITED':
        return new RateLimitError(opts);
      case 'CAPABILITY_NOT_FOUND':
        return new CapabilityNotFoundError(opts);
      case 'ACTION_NOT_FOUND':
        return new ActionNotFoundError(opts);
      case 'INSUFFICIENT_TRUST':
        return new InsufficientTrustError(opts);
      case 'PROVIDER_UNREACHABLE':
      case 'PROVIDER_ERROR':
        return new ProviderError(opts);
      default:
        return new JecpError(opts);
    }
  }
}

export class InsufficientBalanceError extends JecpError {
  constructor(opts: ConstructorParameters<typeof JecpError>[0]) {
    super(opts);
    this.name = 'InsufficientBalanceError';
  }
}
export class InsufficientBudgetError extends JecpError {
  constructor(opts: ConstructorParameters<typeof JecpError>[0]) {
    super(opts);
    this.name = 'InsufficientBudgetError';
  }
}
export class MandateExpiredError extends JecpError {
  constructor(opts: ConstructorParameters<typeof JecpError>[0]) {
    super(opts);
    this.name = 'MandateExpiredError';
  }
}
export class AuthError extends JecpError {
  constructor(opts: ConstructorParameters<typeof JecpError>[0]) {
    super(opts);
    this.name = 'AuthError';
  }
}
export class RateLimitError extends JecpError {
  constructor(opts: ConstructorParameters<typeof JecpError>[0]) {
    super(opts);
    this.name = 'RateLimitError';
  }
}
export class CapabilityNotFoundError extends JecpError {
  constructor(opts: ConstructorParameters<typeof JecpError>[0]) {
    super(opts);
    this.name = 'CapabilityNotFoundError';
  }
}
export class ActionNotFoundError extends JecpError {
  constructor(opts: ConstructorParameters<typeof JecpError>[0]) {
    super(opts);
    this.name = 'ActionNotFoundError';
  }
}
export class InsufficientTrustError extends JecpError {
  constructor(opts: ConstructorParameters<typeof JecpError>[0]) {
    super(opts);
    this.name = 'InsufficientTrustError';
  }
}
export class ProviderError extends JecpError {
  constructor(opts: ConstructorParameters<typeof JecpError>[0]) {
    super(opts);
    this.name = 'ProviderError';
  }
}
