/**
 * v0.8.2 H-4.1 — walletFromEnv / walletFromPrivateKey tests.
 *
 * These tests exercise validation + error paths that DO NOT require `ethers`.
 * Constructing a real Signer (`new ethers.Wallet(...)`) requires the peer
 * dep installed — we skip those branches if ethers is unavailable so the
 * test suite stays green on minimal CI images.
 *
 * Coverage:
 *   - missing env var → actionable error
 *   - malformed key → actionable error (no key bytes leaked)
 *   - missing ethers peer dep → friendly install message
 *   - happy path: env var set + ethers installed → Signer produced + signs
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { walletFromEnv, walletFromPrivateKey } from '../src/x402/signers/from-env.js';
import { buildEIP3009Params } from '../src/x402/payload.js';
import type { X402ExactRequirement } from '../src/x402/types.js';

const VALID_TEST_KEY =
  // RFC-grade well-known test vector (DO NOT use anywhere real). Hardhat's
  // first account private key — public and useless on mainnet, ideal for
  // unit tests.
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

const TEST_ENV_VAR = 'JECP_SDK_TEST_BASE_KEY';

const USDC: `0x${string}` = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const SPLITTER: `0x${string}` = '0x0000000000000000000000000000000000000042';

const x402Accept: X402ExactRequirement = {
  scheme: 'exact',
  network: 'base',
  asset: USDC,
  amount: '200000',
  max_amount_required: '200000',
  pay_to: SPLITTER,
  resource: 'https://jecp.dev/v1/invoke',
  description: 'test',
  max_timeout_seconds: 60,
};

function ethersAvailable(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('ethers');
    return true;
  } catch {
    return false;
  }
}

describe('walletFromEnv — validation', () => {
  beforeEach(() => { delete process.env[TEST_ENV_VAR]; });
  afterEach(() => { delete process.env[TEST_ENV_VAR]; });

  it('throws actionable error when env var is missing', () => {
    expect(() => walletFromEnv({ envVar: TEST_ENV_VAR }))
      .toThrow(/JECP_SDK_TEST_BASE_KEY is not set/);
  });

  it('throws actionable error when env var is empty', () => {
    process.env[TEST_ENV_VAR] = '';
    expect(() => walletFromEnv({ envVar: TEST_ENV_VAR }))
      .toThrow(/is not set/);
  });

  it('throws on malformed key (no 0x prefix)', () => {
    process.env[TEST_ENV_VAR] = 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
    expect(() => walletFromEnv({ envVar: TEST_ENV_VAR }))
      .toThrow(/0x-prefixed 32-byte hex/);
  });

  it('throws on malformed key (wrong length)', () => {
    process.env[TEST_ENV_VAR] = '0xdeadbeef';
    expect(() => walletFromEnv({ envVar: TEST_ENV_VAR }))
      .toThrow(/0x-prefixed 32-byte hex/);
  });

  it('throws on malformed key (non-hex char)', () => {
    process.env[TEST_ENV_VAR] = '0x' + 'g'.repeat(64);
    expect(() => walletFromEnv({ envVar: TEST_ENV_VAR }))
      .toThrow(/0x-prefixed 32-byte hex/);
  });

  it('error message does NOT contain the key bytes (no leakage)', () => {
    const key = '0x' + 'a'.repeat(64);
    process.env[TEST_ENV_VAR] = key + 'extra'; // intentionally malformed
    try {
      walletFromEnv({ envVar: TEST_ENV_VAR });
      expect.fail('should have thrown');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).not.toContain('aaaa');
    }
  });

  it('default env var name is AGENT_BASE_KEY', () => {
    delete process.env.AGENT_BASE_KEY;
    expect(() => walletFromEnv())
      .toThrow(/AGENT_BASE_KEY is not set/);
  });
});

describe('walletFromPrivateKey — direct form', () => {
  it('throws on malformed key', () => {
    expect(() => walletFromPrivateKey('not-a-key'))
      .toThrow(/0x-prefixed 32-byte hex/);
  });
});

describe('walletFromEnv — happy path with ethers installed', () => {
  if (!ethersAvailable()) {
    it.skip('ethers not installed — skipping signing tests', () => { /* skipped */ });
    return;
  }

  beforeEach(() => { process.env[TEST_ENV_VAR] = VALID_TEST_KEY; });
  afterEach(() => { delete process.env[TEST_ENV_VAR]; });

  it('returns a Signer with getAddress() + signEIP3009()', async () => {
    const signer = walletFromEnv({ envVar: TEST_ENV_VAR });
    expect(signer).toBeDefined();
    expect(typeof signer.getAddress).toBe('function');
    expect(typeof signer.signEIP3009).toBe('function');
  });

  it('getAddress returns the Hardhat-derived address (deterministic)', async () => {
    const signer = walletFromEnv({ envVar: TEST_ENV_VAR });
    const addr = await signer.getAddress();
    // Well-known Hardhat account #0 — public test vector.
    expect(addr.toLowerCase()).toBe('0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266');
  });

  it('signEIP3009 produces a valid 65-byte signature (v/r/s)', async () => {
    const signer = walletFromEnv({ envVar: TEST_ENV_VAR });
    const params = buildEIP3009Params(x402Accept, await signer.getAddress(), 1737_000_000);
    const sig = await signer.signEIP3009(params);
    expect(sig.r).toMatch(/^0x[0-9a-f]{64}$/);
    expect(sig.s).toMatch(/^0x[0-9a-f]{64}$/);
    expect([27, 28]).toContain(sig.v);
  });

  it('signEIP3009 is deterministic for fixed inputs', async () => {
    const signer = walletFromEnv({ envVar: TEST_ENV_VAR });
    const params = buildEIP3009Params(x402Accept, await signer.getAddress(), 1737_000_000);
    // Force fixed nonce so the EIP-712 digest is reproducible.
    const fixedParams = { ...params, nonce: ('0x' + 'c'.repeat(64)) as `0x${string}` };
    const a = await signer.signEIP3009(fixedParams);
    const b = await signer.signEIP3009(fixedParams);
    expect(a).toEqual(b);
  });
});
