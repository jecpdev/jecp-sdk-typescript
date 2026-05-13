/**
 * `@jecpdev/sdk/x402/signers` — convenience Signer adapters.
 *
 * The SDK does NOT hard-depend on any wallet library. These helpers wrap
 * common patterns (env-var private key via ethers v6) so callers can avoid
 * the 18-line EIP-712 boilerplate documented in audit-D §A.3.
 *
 * Each helper lazy-loads its peer dep via `require()` — missing libraries
 * throw an actionable error rather than crash on import.
 */

export {
  walletFromEnv,
  walletFromPrivateKey,
  type WalletFromEnvOptions,
} from './from-env.js';
