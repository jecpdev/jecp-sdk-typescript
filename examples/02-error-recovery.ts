/**
 * Example 2: Auto-recover from errors using `next_action`.
 *
 * Run: AGENT_ID=... AGENT_KEY=... npx tsx examples/02-error-recovery.ts
 *
 * What this shows:
 * - Discriminated-union narrowing on `e.nextAction?.type`
 * - Concrete recovery strategies for the most common error codes
 * - Why `next_action` makes autonomous agents possible
 */

import {
  JecpClient,
  JecpError,
  InsufficientBalanceError,
  RateLimitError,
  CapabilityNotFoundError,
} from '@jecpdev/sdk';

const jecp = new JecpClient({
  agentId: process.env.AGENT_ID!,
  apiKey: process.env.AGENT_KEY!,
});

async function invokeWithRecovery(capability: string, action: string, input: unknown) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await jecp.invoke(capability, action, input);
      return result;
    } catch (e) {
      if (!(e instanceof JecpError)) throw e;

      // Branch on the structured next_action type
      switch (e.nextAction?.type) {
        case 'topup':
          // Wallet too low — open Stripe checkout
          if (e instanceof InsufficientBalanceError) {
            console.log('Wallet low. Topping up $20...');
            const { url } = await jecp.topup(20);
            console.log('Open this to pay:', url);
            // In a real agent, wait until balance > amount before retrying
          }
          throw e;

        case 'retry_after':
          // Rate-limited (60 RPM/agent default)
          if (e instanceof RateLimitError) {
            const sleepMs = 60_000;
            console.log(`Rate limited. Sleeping ${sleepMs}ms before retry...`);
            await new Promise((r) => setTimeout(r, sleepMs));
            continue;
          }
          throw e;

        case 'discover':
          // Capability typo — query catalog and fail fast
          if (e instanceof CapabilityNotFoundError) {
            const cat = await jecp.catalog();
            console.error('Capability not found. Did you mean one of:');
            cat.third_party_capabilities?.slice(0, 5).forEach((c) => console.error('  -', c.id));
            throw e;
          }
          throw e;

        case 'increase_mandate':
          // Mandate budget cap exceeded — bump or fail
          console.error('Mandate budget exceeded. Increasing for retry...');
          // In a real agent, decide whether the operation is worth more spend
          throw e;

        case 'register':
          // Auth failed entirely — the credentials must be wrong
          console.error('Auth failed. Re-register the agent or check your env vars.');
          throw e;

        default:
          // Unknown / no recovery hint — surface to operator
          throw e;
      }
    }
  }
  throw new Error('Max retries exhausted');
}

async function main() {
  const r = await invokeWithRecovery(
    'jobdonebot/content-factory',
    'translate',
    { text: 'Hello', target_lang: 'JA' },
  );
  console.log('Success:', r.output);
}

main().catch((e) => {
  console.error('Final error:', e.code ?? e.name, e.message);
  process.exit(1);
});
