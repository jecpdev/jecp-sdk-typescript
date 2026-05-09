/**
 * Example 4: Run a JECP Provider endpoint.
 *
 * Run: JECP_HMAC_SECRET=... npx tsx examples/04-provider-server.ts
 *
 * What this shows:
 * - JecpProvider verifies HMAC + replay window automatically
 * - createHandler() returns a fetch-API compatible handler that runs anywhere
 * - Switch on `req.action` to route to your business logic
 *
 * Works on:
 *   - Bun.serve (most direct, used here)
 *   - Cloudflare Workers (just export the handler)
 *   - Next.js Route Handlers (assign to POST)
 *   - Express (with a small adapter — see README)
 */

import { JecpProvider } from '@jecpdev/sdk';

const provider = new JecpProvider({
  hmacSecret: process.env.JECP_HMAC_SECRET!,
  // replayWindowSec: 300, // default ±5 min
});

const handler = provider.createHandler(async (req) => {
  console.log(`[${new Date().toISOString()}] ${req.action} from ${req.namespace ?? 'unknown'}`);

  switch (req.action) {
    case 'echo':
      return { echoed: req.input };

    case 'translate': {
      const input = req.input as { text: string; target_lang: string };
      // Replace this with your real translation logic
      const translated = `[${input.target_lang}] ${input.text}`;
      return { translated };
    }

    case 'ping':
      return { pong: true, server_time: Date.now() };

    default:
      throw new Error(`unknown action: ${req.action}`);
  }
});

// Bun.serve example
if (typeof Bun !== 'undefined') {
  Bun.serve({
    port: 3000,
    fetch: handler,
  });
  console.log('Provider running on http://localhost:3000');
  console.log('Test with: curl -X POST http://localhost:3000 -H "X-JECP-Signature: ..." -H "X-JECP-Timestamp: ..." -d \'...\'');
} else {
  console.log('This example expects Bun. For Node.js, wrap `handler` with a Node http server, or use a framework adapter.');
}

// Type guard for Bun global
declare const Bun: typeof globalThis & { serve(opts: { port: number; fetch: typeof handler }): unknown };
