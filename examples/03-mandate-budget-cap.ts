/**
 * Example 3: Use Mandate to cap an autonomous agent's spend.
 *
 * Run: AGENT_ID=... AGENT_KEY=... npx tsx examples/03-mandate-budget-cap.ts
 *
 * What this shows:
 * - Pre-authorize a budget cap so a runaway loop can't drain the wallet
 * - Server-side enforcement: calls that would exceed the cap fail with INSUFFICIENT_BUDGET
 * - The agent decides whether the next call is worth the remaining budget
 *
 * In production, set `expires_at` so even an unused mandate dies eventually.
 */

import { JecpClient, InsufficientBudgetError } from '@jecpdev/sdk';

const jecp = new JecpClient({
  agentId: process.env.AGENT_ID!,
  apiKey: process.env.AGENT_KEY!,
});

async function main() {
  // Cap: $0.05 total spend, expires in 1 hour
  const mandate = {
    budget_usdc: 0.05,
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  };

  let totalSpent = 0;
  const phrases = [
    'Hello',
    'How are you',
    'The quick brown fox',
    'Goodbye',
    'See you tomorrow',
    'This call will likely fail because the cap is hit',
  ];

  for (const text of phrases) {
    try {
      const r = await jecp.invoke(
        'jobdonebot/content-factory',
        'translate',
        { text, target_lang: 'JA' },
        { mandate },
      );
      totalSpent += r.billing.amount_usdc;
      console.log(`OK   "${text}" → "${r.output}"  (spent $${r.billing.amount_usdc}, total $${totalSpent.toFixed(4)})`);
    } catch (e) {
      if (e instanceof InsufficientBudgetError) {
        console.log(`STOP "${text}" — mandate budget exhausted ($${mandate.budget_usdc} cap reached)`);
        console.log('     next_action:', e.nextAction);
        break;
      }
      throw e;
    }
  }

  console.log(`\nTotal spent under this mandate: $${totalSpent.toFixed(4)} / $${mandate.budget_usdc}`);
}

main().catch((e) => {
  console.error('Error:', e.message);
  process.exit(1);
});
