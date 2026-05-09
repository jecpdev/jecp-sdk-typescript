/**
 * Optional logger interface — set on JecpClient to observe retries, timeouts, and errors.
 */

export interface Logger {
  debug?(msg: string, meta?: Record<string, unknown>): void;
  info?(msg: string, meta?: Record<string, unknown>): void;
  warn?(msg: string, meta?: Record<string, unknown>): void;
  error?(msg: string, meta?: Record<string, unknown>): void;
}

export const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** Console logger — useful for local development. */
export const consoleLogger: Logger = {
  debug: (msg, meta) => console.debug('[jecp]', msg, meta ?? ''),
  info: (msg, meta) => console.info('[jecp]', msg, meta ?? ''),
  warn: (msg, meta) => console.warn('[jecp]', msg, meta ?? ''),
  error: (msg, meta) => console.error('[jecp]', msg, meta ?? ''),
};
