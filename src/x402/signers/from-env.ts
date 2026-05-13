/**
 * Environment-based Signer helpers (v0.8.2, audit-D §A.3 / H-4.1).
 *
 * The locked-design §6.1 + panel-4 §A.3 promised a 10-line x402 agent. Before
 * v0.8.2, callers had to hand-roll ~18 lines of ethers EIP-712 boilerplate to
 * build a `Signer`. This module ships the missing convenience: read a private
 * key from `process.env`, return a ready `Signer` whose `signEIP3009()`
 * produces the canonical USDC EIP-712 domain.
 *
 * ## Dependency policy
 *
 * `ethers` is loaded via `require()` so that:
 *   1. Bundlers tree-shake it out of browser bundles when callers don't use
 *      these helpers (the file isn't reachable from `index-browser.ts` either,
 *      keeping the browser surface lean).
 *   2. The SDK does NOT depend on ethers in `package.json`. Callers install
 *      `ethers` themselves (`npm install ethers`). When missing, the helper
 *      throws a precise actionable error.
 *
 * Targets ethers v6 (the only LTS at v0.8.2 ship time). v5 callers must
 * supply their own Signer adapter — see `walletFromPrivateKey()`'s docstring
 * for the minimal pattern.
 *
 * ## EIP-712 domain — canonical USDC values
 *
 * Per Circle's USDC contract on Base (mainnet & sepolia), `transferWithAuthorization`
 * uses:
 *   - name: "USD Coin"
 *   - version: "2"
 *   - chainId: 8453 (base) | 84532 (base-sepolia)
 *   - verifyingContract: the USDC ERC-20 address from the 402 `accepts[].asset`
 *
 * These match the EIP-3009 spec + Coinbase's facilitator expectations.
 */

import type { Signer, EIP3009AuthorizationParams } from '../types.js';

/** Options for {@link walletFromEnv}. */
export interface WalletFromEnvOptions {
  /** Env var name to read. Default: `AGENT_BASE_KEY`. */
  envVar?: string;
  /**
   * Optional Base RPC URL. Not required for signing (EIP-712 is offline),
   * but a provider can be useful if callers later extend this Signer with
   * read-only chain calls. Currently unused inside this module.
   */
  rpcUrl?: string;
}

/**
 * Lazy ethers loader. Throws a clear, actionable error if ethers isn't
 * installed. Kept out of the module top-level so missing-ethers does not
 * crash the whole SDK at import time.
 *
 * @internal
 */
function loadEthers(): typeof import('ethers') {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('ethers') as typeof import('ethers');
  } catch {
    throw new Error(
      "@jecpdev/sdk: walletFromEnv() / walletFromPrivateKey() require " +
      "the 'ethers' peer dependency. Install it with `npm install ethers` " +
      "(v6 or newer). The SDK does not ship ethers itself to keep browser " +
      "bundles lean — see docs/x402-quickstart.md for the canonical setup."
    );
  }
}

/** Validate `0x` + 64 hex char private key. Throws on bad input. */
function assertPrivateKey(key: string): asserts key is `0x${string}` {
  const trimmed = key.trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(trimmed)) {
    throw new Error(
      'walletFromEnv: expected a 0x-prefixed 32-byte hex string ' +
      '(66 chars total). Refusing to use the configured key.'
    );
  }
}

/**
 * Build a `Signer` directly from a hex private key. Pure programmatic form;
 * pair with `walletFromEnv()` for env-driven flows.
 *
 * @param privateKeyHex `0x` + 64 hex chars. Validated, never logged.
 * @param rpcUrl Optional Base RPC URL (currently unused; reserved for future
 *   chain-reading extensions).
 */
export function walletFromPrivateKey(
  privateKeyHex: string,
  rpcUrl?: string,
): Signer {
  assertPrivateKey(privateKeyHex);
  const ethers = loadEthers();

  // Provider is optional — EIP-712 typed-data signing is offline.
  const provider = rpcUrl ? new ethers.JsonRpcProvider(rpcUrl) : undefined;
  const wallet = new ethers.Wallet(privateKeyHex, provider);

  return {
    async getAddress() {
      const addr = await wallet.getAddress();
      return addr as `0x${string}`;
    },
    async signEIP3009(params: EIP3009AuthorizationParams) {
      // Canonical USDC EIP-712 domain (Circle's contract on Base).
      const domain = {
        name: 'USD Coin',
        version: '2',
        chainId: params.chainId,
        verifyingContract: params.verifyingContract,
      };
      const types = {
        TransferWithAuthorization: [
          { name: 'from',        type: 'address' },
          { name: 'to',          type: 'address' },
          { name: 'value',       type: 'uint256' },
          { name: 'validAfter',  type: 'uint256' },
          { name: 'validBefore', type: 'uint256' },
          { name: 'nonce',       type: 'bytes32' },
        ],
      };
      const message = {
        from:        params.from,
        to:          params.to,
        value:       params.value,
        validAfter:  params.validAfter,
        validBefore: params.validBefore,
        nonce:       params.nonce,
      };

      // ethers v6 returns a 0x-prefixed 65-byte hex signature: r(32) || s(32) || v(1).
      const sigHex = await wallet.signTypedData(domain, types, message);
      const stripped = sigHex.startsWith('0x') ? sigHex.slice(2) : sigHex;
      if (stripped.length !== 130) {
        throw new Error(
          `walletFromEnv: ethers returned a malformed signature (${stripped.length} hex chars; expected 130).`
        );
      }
      const r = ('0x' + stripped.slice(0, 64)) as `0x${string}`;
      const s = ('0x' + stripped.slice(64, 128)) as `0x${string}`;
      const v = parseInt(stripped.slice(128, 130), 16);
      return { v, r, s };
    },
  };
}

/**
 * Construct a `Signer` from a private key in `process.env`.
 *
 * Reads `opts.envVar` (default `'AGENT_BASE_KEY'`), validates the `0x` + 64
 * hex format, and returns a `Signer` ready to plug into
 * `JecpClient({ payment: { signer } })`.
 *
 * @example
 *   // 10-line agent (panel-4 §A.3 target):
 *   import { JecpClient } from '@jecpdev/sdk';
 *   import { walletFromEnv } from '@jecpdev/sdk/x402/signers';
 *
 *   const jecp = new JecpClient({
 *     agentId: process.env.JECP_AGENT_ID!,
 *     apiKey:  process.env.JECP_API_KEY!,
 *     payment: { mode: 'x402', signer: walletFromEnv() },
 *   });
 *   const r = await jecp.invoke('jobdonebot/bg-remover-pro', 'remove', { image_url });
 *   console.log(r.payment?.txHash);
 *
 * @throws Error with actionable message when the env var is missing,
 *   malformed, or `ethers` is not installed.
 */
export function walletFromEnv(opts: WalletFromEnvOptions = {}): Signer {
  const envVar = opts.envVar ?? 'AGENT_BASE_KEY';
  const raw = process.env[envVar];
  if (!raw || raw.length === 0) {
    throw new Error(
      `walletFromEnv: environment variable ${envVar} is not set. ` +
      `Set it to your Base wallet's private key (0x-prefixed 64 hex chars). ` +
      `See docs/x402-quickstart.md for setup.`
    );
  }
  return walletFromPrivateKey(raw, opts.rpcUrl);
}
