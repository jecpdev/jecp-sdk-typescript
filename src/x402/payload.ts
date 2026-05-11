/**
 * x402 payload builder + codec.
 *
 * Given a `PaymentRequirement` (the `accepts[]` entry returned in a 402)
 * and a `Signer`, produce:
 *   - the EIP-3009 authorization
 *   - the v/r/s signature (via the injected Signer)
 *   - the X402 v1 PaymentPayload JSON
 *   - the base64-encoded `X-Payment` header value (≤8KB enforced)
 *
 * The SDK never holds private keys. The Signer adapter is responsible for
 * the EIP-712 typed-data hashing.
 *
 * Locked design §3.2; spec v1.1.0 §4-x402-integration.
 */

import type {
  Signer,
  X402ExactRequirement,
  X402PaymentPayload,
  EIP3009AuthorizationParams,
} from './types.js';

const X_PAYMENT_HEADER_MAX_BYTES = 8 * 1024; // 8KB cap per locked design §3.2

/** Map network string → EIP-155 chain id. */
export function networkToChainId(network: 'base' | 'base-sepolia'): number {
  if (network === 'base') return 8453;
  if (network === 'base-sepolia') return 84532;
  throw new Error(`x402: unsupported network "${network as string}"`);
}

/**
 * Generate a fresh 32-byte nonce as `0x{64 hex}`. Used as the EIP-3009 nonce
 * (replay defense). Backed by `crypto.getRandomValues` (works in Node 20+,
 * browsers, and edge runtimes).
 */
export function freshNonce(): `0x${string}` {
  const bytes = new Uint8Array(32);
  if (typeof crypto !== 'undefined' && 'getRandomValues' in crypto) {
    crypto.getRandomValues(bytes);
  } else {
    // Node.js fallback (very old runtimes; supports test mocking)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nodeCrypto = require('node:crypto') as typeof import('node:crypto');
    nodeCrypto.randomFillSync(bytes);
  }
  return ('0x' + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')) as `0x${string}`;
}

/**
 * Build the EIP-3009 authorization params from a 402 `accepts[]` entry.
 *
 * @param req - the x402 `exact`-scheme requirement
 * @param from - the agent's Base address (signer.getAddress())
 * @param nowSec - override `now` in unix seconds (testing); default `Date.now()/1000`
 */
export function buildEIP3009Params(
  req: X402ExactRequirement,
  from: `0x${string}`,
  nowSec: number = Math.floor(Date.now() / 1000),
): EIP3009AuthorizationParams {
  // validBefore = now + max_timeout_seconds. The Hub will reject if the
  // authorization is already expired by the time it reaches the facilitator.
  const validAfter = BigInt(0);
  const validBefore = BigInt(nowSec + req.max_timeout_seconds);
  return {
    from,
    to: req.pay_to,
    value: BigInt(req.amount),
    validAfter,
    validBefore,
    nonce: freshNonce(),
    chainId: networkToChainId(req.network),
    verifyingContract: req.asset,
  };
}

/**
 * Concatenate (r, s, v) into the 65-byte hex signature form expected by
 * the x402 facilitator's `payload.signature` field. v is 27 or 28 (or 0/1
 * normalized to 27/28).
 */
export function packSignature(v: number, r: `0x${string}`, s: `0x${string}`): `0x${string}` {
  const normalizedV = v < 27 ? v + 27 : v;
  const rHex = r.replace(/^0x/, '').padStart(64, '0');
  const sHex = s.replace(/^0x/, '').padStart(64, '0');
  const vHex = normalizedV.toString(16).padStart(2, '0');
  return ('0x' + rHex + sHex + vHex) as `0x${string}`;
}

/**
 * Sign the EIP-3009 authorization via the injected Signer, then build the
 * full X402 v1 PaymentPayload.
 */
export async function buildX402Payload(
  req: X402ExactRequirement,
  signer: Signer,
  opts: { nowSec?: number } = {},
): Promise<X402PaymentPayload> {
  const from = await signer.getAddress();
  const params = buildEIP3009Params(req, from, opts.nowSec);
  const { v, r, s } = await signer.signEIP3009(params);
  const signature = packSignature(v, r, s);

  return {
    x402Version: 1,
    scheme: 'exact',
    network: req.network,
    payload: {
      signature,
      authorization: {
        from: params.from,
        to: params.to,
        value: params.value.toString(),
        validAfter: params.validAfter.toString(),
        validBefore: params.validBefore.toString(),
        nonce: params.nonce,
      },
    },
  };
}

/**
 * Base64-encode the X402 PaymentPayload for the `X-Payment` header.
 * Enforces the 8KB cap (locked design §3.2). Uses URL-safe base64
 * (per RFC 7515 §C, which is what the x402 spec follows) — but x402.org
 * accepts standard base64 too, so we emit standard.
 *
 * Works in both Node and browsers (uses `Buffer` when available, falls
 * back to `btoa(escape(...))`).
 */
export function encodeXPaymentHeader(payload: X402PaymentPayload): string {
  const json = JSON.stringify(payload);
  let b64: string;
  if (typeof Buffer !== 'undefined') {
    b64 = Buffer.from(json, 'utf-8').toString('base64');
  } else {
    // Browser fallback — handles UTF-8 (signatures are hex so safe, but defensive)
    const bytes = new TextEncoder().encode(json);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
    b64 = btoa(bin);
  }
  if (b64.length > X_PAYMENT_HEADER_MAX_BYTES) {
    throw new Error(
      `x402: X-Payment header is ${b64.length} bytes, exceeds ${X_PAYMENT_HEADER_MAX_BYTES} cap (locked design §3.2)`
    );
  }
  return b64;
}

/**
 * Decode the `X-Payment-Response` header (base64 JSON) returned by Hub on
 * successful x402 settlement.
 *
 * @returns parsed `{ success, txHash, networkId }` or `undefined` if the
 * header was absent / malformed.
 */
export function decodeXPaymentResponseHeader(value: string | null | undefined): {
  success: true;
  txHash: `0x${string}`;
  networkId: string;
} | undefined {
  if (!value) return undefined;
  try {
    let json: string;
    if (typeof Buffer !== 'undefined') {
      json = Buffer.from(value, 'base64').toString('utf-8');
    } else {
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      const bin = atob(value);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      json = new TextDecoder().decode(bytes);
    }
    const parsed = JSON.parse(json) as {
      success?: boolean;
      txHash?: string;
      networkId?: string;
    };
    if (parsed.success === true && parsed.txHash && parsed.networkId) {
      return {
        success: true,
        txHash: parsed.txHash as `0x${string}`,
        networkId: parsed.networkId,
      };
    }
  } catch {
    // Malformed — return undefined; the caller will report success without receipt.
  }
  return undefined;
}

/**
 * Find the first x402 (`scheme: 'exact'`) entry in a 402's `accepts[]` array.
 * Returns `undefined` if the capability is wallet-only.
 */
export function findX402Requirement(
  accepts: ReadonlyArray<{ scheme: string }>,
): X402ExactRequirement | undefined {
  for (const entry of accepts) {
    if (entry.scheme === 'exact') {
      return entry as unknown as X402ExactRequirement;
    }
  }
  return undefined;
}
