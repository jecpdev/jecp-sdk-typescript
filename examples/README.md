# Examples

Runnable TypeScript examples for `@jecpdev/sdk`.

## Setup

```bash
npm install @jecpdev/sdk
npm install -D tsx        # for running .ts files directly
```

## Examples

| File | What it does | Requires |
|------|--------------|----------|
| `01-register-and-invoke.ts` | Full first-time agent flow: register → invoke → read billing | nothing (registers a new agent) |
| `02-error-recovery.ts` | Discriminated-union branching on `next_action` to recover from common errors | `AGENT_ID` + `AGENT_KEY` env vars |
| `03-mandate-budget-cap.ts` | Use Mandate to cap an autonomous agent's total spend | `AGENT_ID` + `AGENT_KEY` env vars |
| `04-provider-server.ts` | Build a Provider endpoint with HMAC verification baked in | `JECP_HMAC_SECRET` env var, Bun runtime |

## Running

```bash
# Example 1 — register + invoke (no credentials needed)
npx tsx examples/01-register-and-invoke.ts

# Example 2 — error recovery
AGENT_ID=jdb_ag_... AGENT_KEY=jdb_ak_... npx tsx examples/02-error-recovery.ts

# Example 3 — mandate
AGENT_ID=jdb_ag_... AGENT_KEY=jdb_ak_... npx tsx examples/03-mandate-budget-cap.ts

# Example 4 — Provider endpoint (needs Bun)
JECP_HMAC_SECRET=... bun run examples/04-provider-server.ts
```

## Saving credentials

After running example 1, save the `agent_id` and `api_key` somewhere safe (a `.env` file or a password manager). They are **not recoverable** if lost — you'd have to register a new agent.

```bash
# .env
AGENT_ID=jdb_ag_a1b2c3...
AGENT_KEY=jdb_ak_xxxxxxxxxxxx
JECP_HMAC_SECRET=...        # only if you're running a Provider
```

## More

- Full API: [README.md](../README.md)
- Spec: [github.com/jecpdev/jecp-spec](https://github.com/jecpdev/jecp-spec)
- Live catalog: [https://jecp.dev/v1/capabilities](https://jecp.dev/v1/capabilities)
