/**
 * Example 5: pay each invoke in USDC on Base via x402 — v0.8.2+.
 *
 * Run: npx tsx examples/05-x402-invoke.ts
 *
 * Prerequisites (see docs/x402-quickstart.md for the 4-step path):
 *   1. npm install @jecpdev/sdk ethers
 *   2. export AGENT_BASE_KEY=0x...   (private key for a Base EOA)
 *   3. Top up that wallet with USDC on Base (Coinbase Onramp / CDP)
 *   4. export JECP_AGENT_ID=jdb_ag_... + JECP_API_KEY=jdb_ak_...
 *
 * What this shows:
 *   - walletFromEnv() — zero-boilerplate Signer from process.env
 *   - SDK safety caps (Panel 4 §A.3 + Audit B): maxPerCallUsdc, maxPerHourUsdc, maxGasRatio
 *   - Settlement receipt decoding from X-Payment-Response header
 *   - Typed error handling for x402-specific failures
 *
 * Spec: https://github.com/jecpdev/jecp-spec/blob/main/spec/04-x402-integration.md
 */

import {
  JecpClient,
  walletFromEnv,
  X402AmountCapExceededError,
  X402HourlyCapExceededError,
  X402GasRatioExceededError,
  X402PaymentInvalidError,
  X402SettlementTimeoutError,
  X402FacilitatorUnreachableError,
  X402SettlementReusedError,
  InsufficientPaymentOptionsError,
  JecpError,
} from '@jecpdev/sdk';

async function main() {
  // Fail fast if env is misconfigured.
  for (const v of ['AGENT_BASE_KEY', 'JECP_AGENT_ID', 'JECP_API_KEY']) {
    if (!process.env[v]) {
      console.error(`Missing required env var: ${v}`);
      console.error('See docs/x402-quickstart.md for the 4-step setup.');
      process.exit(1);
    }
  }

  // walletFromEnv() reads AGENT_BASE_KEY by default, validates it, and
  // returns a Signer that produces canonical USDC EIP-712 signatures on
  // the Base chain. The SDK never sees the private key directly.
  const signer = walletFromEnv();
  console.log('Agent EOA:', await signer.getAddress());

  // Construct the client with safety caps. Caps are checked BEFORE signing,
  // so a hostile 402 cannot extract a signature for a too-large amount.
  const jecp = new JecpClient({
    agentId: process.env.JECP_AGENT_ID!,
    apiKey:  process.env.JECP_API_KEY!,
    payment: {
      mode: 'auto',                  // try x402 first; surface 402 if not supported
      signer,
      maxPerCallUsdc: 1_000_000n,    // $1 per invoke
      maxPerHourUsdc: 10_000_000n,   // $10 rolling 1h budget
      maxGasRatio: 0.05,             // gas <= 5% of invoke amount
      facilitatorTimeoutMs: 15_000,
    },
  });

  // Estimate cost before invoking. Pulls from catalog manifest.
  const cost = await jecp.estimateCost('jobdonebot/bg-remover-pro');
  console.log(`Estimated cost: $${cost.usd} USDC (gas ~$${cost.gasEstimateUsd})`);

  // Happy path — invoke a paid capability. SDK handles 402 → X-Payment retry.
  try {
    const result = await jecp.invoke(
      'jobdonebot/bg-remover-pro',
      'remove',
      { image_url: 'https://example.com/cat.png' },
    );

    console.log('\nInvocation success:');
    console.log('  output:', result.output);
    console.log('  request_id:', result.request_id);
    console.log('  attempts:', result.attempts);

    // Settlement receipt — populated when the call was paid via x402.
    if (result.payment) {
      console.log('\nx402 settlement:');
      console.log('  method:', result.payment.method);
      console.log('  txHash:', result.payment.txHash);
      console.log('  network:', result.payment.networkId);
      console.log('  amount: $', result.payment.amount_usd);
      console.log('  Basescan:', `https://basescan.org/tx/${result.payment.txHash}`);
    }
  } catch (e) {
    handleError(e);
    process.exit(1);
  }
}

/**
 * Typed error handling. Every x402-specific class exposes:
 *   - .subcause (when supplied by Hub/SDK)
 *   - .retryable (boolean)
 *   - .nextAction ({ type, hint }) — actionable recovery
 */
function handleError(e: unknown): void {
  if (e instanceof X402AmountCapExceededError) {
    console.error(`SDK refused: invoke amount ${e.requestedUsdc} > cap ${e.capUsdc}`);
    console.error(`  next action: ${e.nextAction?.type} — ${e.nextAction?.hint}`);
    return;
  }
  if (e instanceof X402HourlyCapExceededError) {
    console.error(`SDK refused: hourly budget would exceed cap`);
    console.error(`  cumulative: ${e.cumulativeUsdc}, requested: ${e.requestedUsdc}, cap: ${e.capUsdc}`);
    console.error(`  next action: ${e.nextAction?.type} — ${e.nextAction?.hint}`);
    return;
  }
  if (e instanceof X402GasRatioExceededError) {
    console.error(`SDK refused: gas ratio ${(e.observedRatio * 100).toFixed(2)}% > cap ${(e.capRatio * 100).toFixed(2)}%`);
    console.error(`  next action: ${e.nextAction?.type} — ${e.nextAction?.hint}`);
    return;
  }
  if (e instanceof X402PaymentInvalidError) {
    console.error(`Facilitator rejected payload (subcause: ${e.subcause})`);
    console.error(`  next action: ${e.nextAction?.type} — ${e.nextAction?.hint}`);
    return;
  }
  if (e instanceof X402SettlementTimeoutError) {
    console.error(`Settlement timed out (subcause: ${e.subcause}, retryable)`);
    console.error(`  Tip: retry with a fresh nonce after backoff.`);
    return;
  }
  if (e instanceof X402FacilitatorUnreachableError) {
    console.error(`Facilitator unreachable (subcause: ${e.subcause}, retryable: ${e.retryable})`);
    if (!e.retryable) console.error('  Trust pin mismatch — do NOT retry. Check for SDK update.');
    return;
  }
  if (e instanceof X402SettlementReusedError) {
    console.error(`Replay detected (subcause: ${e.subcause})`);
    console.error('  Re-sign with a fresh nonce and retry.');
    return;
  }
  if (e instanceof InsufficientPaymentOptionsError) {
    console.error(`No viable payment path: signerMissing=${e.signerMissing}, capabilityRejectedX402=${e.capabilityRejectedX402}`);
    console.error(`  next action: ${e.nextAction?.type} — ${e.nextAction?.hint}`);
    return;
  }
  if (e instanceof JecpError) {
    console.error(`JECP error [${e.code}] (status ${e.status}): ${e.message}`);
    if (e.nextAction) console.error(`  next action: ${JSON.stringify(e.nextAction)}`);
    return;
  }
  console.error('Unexpected error:', e);
}

main().catch(e => {
  handleError(e);
  process.exit(1);
});
