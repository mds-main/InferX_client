# InferX Client ⚡

**Production-ready TypeScript CLI client** for [InferX](https://ai-inferx.vercel.app) — x402 AI inference with USDC payments on Base network. No accounts, no API keys — your EVM wallet IS your identity.

## Features

- **Per-request x402 payments** — EIP-3009 signed USDC transfers, no gas
- **Prepaid balance mode** — Top up once, ~0.1ms overhead per request
- **Streaming** — Real-time SSE token output
- **Auto token refresh** — Expired auth tokens refreshed automatically on 401
- **Structured output** — JSON Schema validated responses
- **Dry-run** — Check pricing without paying
- **Importable library** — Use `InferXClient` class in your own code

## Setup

```bash
# Install dependencies
pnpm install

# Configure wallet (create .env.local)
cp .env.example .env.local
# Edit .env.local and set WALLET_PRIVATE_KEY=0x...
```

> ⚠️ **Security:** Use a dedicated hot wallet with limited USDC. Never use your primary/cold storage key.

## CLI Commands

All commands are run via `pnpm inferx <command>`.

### List Models (Free — no payment needed)

```bash
pnpm inferx models
```

### Inference (Per-request x402 payment)

```bash
# Basic inference
pnpm inferx infer --model qwen3-5-35b-a3b --prompt "What is 2+2?" --max-tokens 64

# Streaming
pnpm inferx infer --model claude-opus-4-6 --prompt "Write a haiku" --stream

# Dry-run (price check only, no payment)
pnpm inferx infer --model gemini-3-1-pro-preview --prompt "test" --dry-run

# With task hint (auto-resolves max tokens)
pnpm inferx infer --model zai-org-glm-5 --prompt "Is this spam?" --task classify

# Structured output
pnpm inferx infer --model minimax-m25 --prompt "Extract: John is 30 in NYC" --response-format '{"type":"json_schema","json_schema":{"name":"person","strict":true,"schema":{"type":"object","properties":{"name":{"type":"string"},"age":{"type":"integer"},"city":{"type":"string"}},"required":["name","age","city"],"additionalProperties":false}}}'
```

### Prepaid Balance

```bash
# Top up (pays USDC on-chain once)
pnpm inferx topup --amount 5.00

# Check balance
pnpm inferx balance

# Inference from balance (~0.1ms overhead)
pnpm inferx balance-infer --model zai-org-glm-4.7-flash --prompt "Hello" --max-tokens 128

# Refresh auth token (when it expires after 30 days)
pnpm inferx refresh-token
```

## Testing

### Run Tests

```bash
# All tests (51 tests across payment + client suites)
pnpm test

# Watch mode
pnpm test:watch

# Type check
pnpm typecheck
```

### Test the API (Live)

```bash
# 1. Free — list models
pnpm inferx models

# 2. Free — dry-run price discovery
pnpm inferx infer --model gemini-3-1-pro-preview --prompt "test" --max-tokens 32 --dry-run

# 3. Paid — real inference ($0.001 minimum)
pnpm inferx infer --model qwen3-5-35b-a3b --prompt "What is 2+2?" --max-tokens 64

# 4. Paid — streaming inference
pnpm inferx infer --model claude-opus-4-6 --prompt "Write a haiku about code" --stream

# 5. Paid — top up prepaid balance
pnpm inferx topup --amount 0.01

# 6. Free — check balance (after top-up)
pnpm inferx balance

# 7. Paid — inference from balance 
pnpm inferx balance-infer --model zai-org-glm-4.7-flash --prompt "Hello" --max-tokens 64

# 8. Free — refresh auth token
pnpm inferx refresh-token
```

## Library Usage

```typescript
import { InferXClient } from './src/client.js';

const client = new InferXClient(process.env.WALLET_PRIVATE_KEY!);

// Per-request x402 inference
const result = await client.infer({
  model: 'gemini-3-1-pro-preview',
  prompt: 'Explain quantum computing in one sentence',
  maxTokens: 128,
});
console.log(result.content);
console.log(`Paid: $${result.payment.amountUsdc} USDC`);

// Top up and use balance
await client.topUp(5.0);
const fast = await client.inferWithBalance({
  model: 'zai-org-glm-5',
  prompt: 'Hello!',
  maxTokens: 64,
});
console.log(`Remaining: $${fast.payment.balanceRemaining} USDC`);
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `WALLET_PRIVATE_KEY` | Yes | EVM private key (0x-prefixed hex) |
| `INFERX_ENDPOINT` | No | API base URL (default: `https://ai-inferx.vercel.app`) |
| `INFERX_AUTH_TOKEN` | No | Balance auth token (overrides `~/.inferx/auth_token`) |

## Architecture

```
src/
├── types.ts      # TypeScript interfaces for all API types
├── payment.ts    # x402 signing (EIP-3009 + EIP-191) via viem
├── client.ts     # InferXClient class — all API methods
├── cli.ts        # Commander CLI entry point
└── __tests__/
    ├── payment.test.ts  # 23 payment signing tests
    └── client.test.ts   # 28 client integration tests
```

## License

MIT
