/**
 * v1.0.2 K2 wire-format error subclasses (SDK 0.7.1).
 *
 * Verifies that JecpError.fromBody dispatches to the right subclass for each
 * v1.0.2 error code AND that the typed accessors expose details correctly.
 */
import { describe, it, expect } from 'vitest';
import {
  JecpError,
  JecpErrorCode,
  RateLimitError,
  UnsupportedMediaTypeError,
  DuplicateRequestError,
  CapabilityDeprecatedError,
  InputSchemaViolationError,
  UrlBlockedSsrfError,
} from '../src/errors.js';

describe('JecpErrorCode constants', () => {
  it('exposes v1.0.2 K2 codes as string literals', () => {
    expect(JecpErrorCode.UNSUPPORTED_MEDIA_TYPE).toBe('UNSUPPORTED_MEDIA_TYPE');
    expect(JecpErrorCode.DUPLICATE_REQUEST).toBe('DUPLICATE_REQUEST');
    expect(JecpErrorCode.CAPABILITY_DEPRECATED).toBe('CAPABILITY_DEPRECATED');
    expect(JecpErrorCode.RATE_LIMITED).toBe('RATE_LIMITED');
    expect(JecpErrorCode.INPUT_SCHEMA_VIOLATION).toBe('INPUT_SCHEMA_VIOLATION');
  });

  it('exposes legacy codes (no regression)', () => {
    expect(JecpErrorCode.AUTH_REQUIRED).toBe('AUTH_REQUIRED');
    expect(JecpErrorCode.CAPABILITY_NOT_FOUND).toBe('CAPABILITY_NOT_FOUND');
  });
});

describe('JecpError.fromBody dispatches to v1.0.2 subclasses', () => {
  it('UNSUPPORTED_MEDIA_TYPE → UnsupportedMediaTypeError', () => {
    const err = JecpError.fromBody({
      error: {
        code: 'UNSUPPORTED_MEDIA_TYPE',
        message: 'Content-Type must be application/json',
        details: {
          received: 'text/plain',
          expected: 'application/json',
          documentation_url: 'https://jecp.dev/errors/unsupported_media_type',
        },
      },
    }, 415);
    expect(err).toBeInstanceOf(UnsupportedMediaTypeError);
    const u = err as UnsupportedMediaTypeError;
    expect(u.status).toBe(415);
    expect(u.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    expect(u.receivedContentType).toBe('text/plain');
    expect(u.expectedContentType).toBe('application/json');
    expect(u.documentationUrl).toBe('https://jecp.dev/errors/unsupported_media_type');
  });

  it('DUPLICATE_REQUEST → DuplicateRequestError', () => {
    const err = JecpError.fromBody({
      error: {
        code: 'DUPLICATE_REQUEST',
        message: 'request_id already used with different payload',
        details: {
          documentation_url: 'https://jecp.dev/errors/duplicate_request',
        },
      },
    }, 409);
    expect(err).toBeInstanceOf(DuplicateRequestError);
    expect(err.status).toBe(409);
    expect(err.documentationUrl).toBe('https://jecp.dev/errors/duplicate_request');
  });

  it('CAPABILITY_DEPRECATED → CapabilityDeprecatedError exposes sunset_at + successor', () => {
    const err = JecpError.fromBody({
      error: {
        code: 'CAPABILITY_DEPRECATED',
        message: 'jecp-test/deprecated-echo is sunset',
        details: {
          sunset_at: '2020-01-01T00:00:00Z',
          successor_version: 'jecp-test/echo',
          documentation_url: 'https://jecp.dev/errors/capability_deprecated',
        },
      },
    }, 410);
    expect(err).toBeInstanceOf(CapabilityDeprecatedError);
    const d = err as CapabilityDeprecatedError;
    expect(d.sunsetAt).toBe('2020-01-01T00:00:00Z');
    expect(d.successorVersion).toBe('jecp-test/echo');
    expect(d.documentationUrl).toBe('https://jecp.dev/errors/capability_deprecated');
  });

  it('RATE_LIMITED carries retryAfterSeconds (K2.4)', () => {
    const err = JecpError.fromBody({
      error: {
        code: 'RATE_LIMITED',
        message: 'too many requests',
        details: {
          retry_after_seconds: 27,
          documentation_url: 'https://jecp.dev/errors/rate_limited',
        },
      },
    }, 429);
    expect(err).toBeInstanceOf(RateLimitError);
    const r = err as RateLimitError;
    expect(r.retryAfterSeconds).toBe(27);
    expect(r.documentationUrl).toBe('https://jecp.dev/errors/rate_limited');
  });

  it('RATE_LIMITED without retry_after_seconds returns undefined', () => {
    const err = JecpError.fromBody({
      error: { code: 'RATE_LIMITED', message: 'rate limit', details: {} },
    }, 429) as RateLimitError;
    expect(err.retryAfterSeconds).toBeUndefined();
  });

  it('INPUT_SCHEMA_VIOLATION exposes errors[] array (K2.5)', () => {
    const err = JecpError.fromBody({
      error: {
        code: 'INPUT_SCHEMA_VIOLATION',
        message: 'Input schema violation: "items" is a required property',
        details: {
          errors: [
            {
              instance_path: '',
              schema_path: '/required',
              reason: '"items" is a required property',
            },
            {
              instance_path: '/client_name',
              schema_path: '/properties/client_name/type',
              reason: '42 is not of type "string"',
            },
          ],
          documentation_url: 'https://jecp.dev/errors/input_schema_violation',
        },
      },
    }, 400);
    expect(err).toBeInstanceOf(InputSchemaViolationError);
    const v = err as InputSchemaViolationError;
    expect(v.status).toBe(400);
    expect(v.errors).toHaveLength(2);
    expect(v.errors[0].instance_path).toBe('');
    expect(v.errors[0].schema_path).toBe('/required');
    expect(v.errors[0].reason).toContain('items');
    expect(v.errors[1].instance_path).toBe('/client_name');
  });

  it('INPUT_SCHEMA_VIOLATION returns [] when errors absent', () => {
    const err = JecpError.fromBody({
      error: { code: 'INPUT_SCHEMA_VIOLATION', message: 'bad input', details: {} },
    }, 400) as InputSchemaViolationError;
    expect(err.errors).toEqual([]);
  });

  it('INPUT_SCHEMA_VIOLATION filters malformed entries from errors[]', () => {
    const err = JecpError.fromBody({
      error: {
        code: 'INPUT_SCHEMA_VIOLATION',
        message: 'bad',
        details: {
          errors: [
            { instance_path: '/a', schema_path: '/x', reason: 'good' },
            // malformed: missing reason
            { instance_path: '/b', schema_path: '/y' },
            // malformed: not an object
            'oops',
            null,
          ],
        },
      },
    }, 400) as InputSchemaViolationError;
    expect(err.errors).toHaveLength(1);
    expect(err.errors[0].instance_path).toBe('/a');
  });
});

describe('UrlBlockedSsrfError (v1.1.0 c10)', () => {
  it('URL_BLOCKED_SSRF dispatches to UrlBlockedSsrfError with field/url/reason accessors', () => {
    const err = JecpError.fromBody({
      error: {
        code: 'URL_BLOCKED_SSRF',
        message: 'URL blocked by SSRF policy: webhook_destination_url resolved_to_deny_cidr',
        details: {
          field:             'webhook_destination_url',
          blocked_url:       'https://127.0.0.1/webhook',
          reason:            'resolved_to_deny_cidr',
          documentation_url: 'https://jecp.dev/errors/url_blocked_ssrf#resolved_to_deny_cidr',
        },
      },
    }, 422);
    expect(err).toBeInstanceOf(UrlBlockedSsrfError);
    const u = err as UrlBlockedSsrfError;
    expect(u.status).toBe(422);
    expect(u.code).toBe('URL_BLOCKED_SSRF');
    expect(u.field).toBe('webhook_destination_url');
    expect(u.blockedUrl).toBe('https://127.0.0.1/webhook');
    expect(u.reason).toBe('resolved_to_deny_cidr');
    expect(u.documentationUrl).toContain('/errors/url_blocked_ssrf');
  });

  it('JecpErrorCode.URL_BLOCKED_SSRF is "URL_BLOCKED_SSRF"', () => {
    expect(JecpErrorCode.URL_BLOCKED_SSRF).toBe('URL_BLOCKED_SSRF');
  });

  it('returns undefined accessors when details missing', () => {
    const err = JecpError.fromBody({
      error: { code: 'URL_BLOCKED_SSRF', message: 'blocked', details: {} },
    }, 422) as UrlBlockedSsrfError;
    expect(err.field).toBeUndefined();
    expect(err.blockedUrl).toBeUndefined();
    expect(err.reason).toBeUndefined();
  });

  it('handles every documented subcause without throwing', () => {
    const subcauses = ['parse_error', 'scheme', 'host_syntax',
                       'resolved_to_deny_cidr', 'dns_resolve_failed',
                       'connect_pin_violation'];
    for (const subcause of subcauses) {
      const err = JecpError.fromBody({
        error: {
          code: 'URL_BLOCKED_SSRF',
          message: `blocked: ${subcause}`,
          details: { field: 'endpoint_url', blocked_url: 'https://x', reason: subcause },
        },
      }, 422) as UrlBlockedSsrfError;
      expect(err.reason).toBe(subcause);
    }
  });
});

describe('JecpError.documentationUrl', () => {
  it('returns the URL from details when present', () => {
    const err = JecpError.fromBody({
      error: {
        code: 'INVALID_AGENT',
        message: 'bad',
        details: { documentation_url: 'https://jecp.dev/errors/invalid_agent' },
      },
    }, 401);
    expect(err.documentationUrl).toBe('https://jecp.dev/errors/invalid_agent');
  });

  it('returns undefined when details missing', () => {
    const err = JecpError.fromBody({
      error: { code: 'UNKNOWN', message: 'something' },
    }, 500);
    expect(err.documentationUrl).toBeUndefined();
  });
});
