/**
 * Example 1: Register an agent and invoke a capability.
 *
 * Run: npx tsx examples/01-register-and-invoke.ts
 *
 * What this shows:
 * - One-time agent registration → agent_id + api_key (save these forever)
 * - Wallet usage with the 100 free calls included on registration
 * - Reading billing summary + balance after the call
 */

import { JecpClient } from '@jecpdev/sdk';

async function main() {
  // Step 1: register a new agent (skip this if you already have credentials)
  const registration = await JecpClient.register({
    name: 'ExampleAgent',
    agent_type: 'demo',
    description: 'Example agent for the @jecpdev/sdk quickstart',
  });

  console.log('Agent registered:');
  console.log('  agent_id:', registration.agent_id);
  console.log('  api_key:', registration.api_key.slice(0, 16) + '...');
  console.log('  free_calls_remaining:', registration.free_calls_remaining);

  // Step 2: build the client
  const jecp = new JecpClient({
    agentId: registration.agent_id,
    apiKey: registration.api_key,
  });

  // Step 3: invoke a capability
  const result = await jecp.invoke(
    'jobdonebot/content-factory',
    'translate',
    { text: 'Hello, world!', target_lang: 'JA' },
  );

  console.log('\nInvocation result:');
  console.log('  output:', result.output);
  console.log('  charged:', result.billing.charged);
  console.log('  amount_usdc:', result.billing.amount_usdc);
  console.log('  balance_after:', result.wallet_balance_after);
  console.log('  provider:', result.provider.namespace + '/' + result.provider.capability);
}

main().catch((e) => {
  console.error('Error:', e.message);
  if (e.code) console.error('Code:', e.code);
  if (e.nextAction) console.error('Next action:', e.nextAction);
  process.exit(1);
});
