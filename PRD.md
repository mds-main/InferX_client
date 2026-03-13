# PRD: InferX Client — x402 AI Inference CLI

## Goal

Build a **production-ready TypeScript CLI client** that consumes the InferX API for AI inference, paying with USDC on Base network via the x402 protocol. The client must support both payment modes (per-request x402 and prepaid balance) and be usable as both a CLI tool and an importable library.

## Context

- **InferX** is an OpenAI-compatible AI inference middleware powered by Venice AI
- Payment is via USDC on Base (chain ID 8453) using the x402 payment protocol
- No accounts, no API keys — your EVM wallet IS your identity
- Full protocol details are in [skill/SKILL.md](file:///c:/Users/d_ond/cursor/InferX/public/skill/SKILL.md) and [skill/PAYMENT.md](file:///c:/Users/d_ond/cursor/InferX/public/skill/PAYMENT.md)

## Tech Stack

| Layer | Choice |
|-------|--------|
| Runtime | Node.js 20+ |
| Language | TypeScript (strict mode) |
| Package manager | pnpm |
| EVM signing | `viem` (NOT ethers — use viem for modern EIP-712 support) |
| HTTP | Native `fetch` (no axios) |
| CLI parsing | `commander` |
| Build | [tsx](file:///c:/Users/d_ond/cursor/InferX/src/app/page.tsx) for direct execution |

## File Structure

```
inferx-client/
├── src/
│   ├── client.ts           # InferXClient class (importable library)
│   ├── payment.ts           # x402 payment signing (EIP-3009)
│   ├── types.ts             # TypeScript types for all API responses
│   └── cli.ts               # CLI entry point
├── skill/
│   ├── SKILL.md             # InferX API reference (provided)
│   └── PAYMENT.md           # x402 payment protocol guide (provided)
├── package.json
├── tsconfig.json
└── .env.example
```

## Core Requirements

### 1. InferXClient Class (`src/client.ts`)

A reusable class that encapsulates all InferX API interactions:

```typescript
class InferXClient {
  constructor(privateKey: string, options?: { endpoint?: string })

  // Per-request x402 inference
  async infer(params: InferParams): Promise<InferResult>

  // Prepaid balance: top up
  async topUp(amountUsdc: number): Promise<TopUpResult>

  // Prepaid balance: inference (zero settlement overhead)
  async inferWithBalance(params: InferParams): Promise<InferResult>

  // Check balance
  async getBalance(): Promise<BalanceResult>

  // Refresh auth token (EIP-191 signature, no top-up needed)
  async refreshAuthToken(): Promise<string>

  // List available models
  async listModels(): Promise<Model[]>
}
```

### 2. Payment Signing (`src/payment.ts`)

Implement the x402 payment flow exactly as documented in [skill/PAYMENT.md](file:///c:/Users/d_ond/cursor/InferX/public/skill/PAYMENT.md):

**⚠️ CRITICAL — Read These Before Writing Any Code:**

1. **`PAYMENT-REQUIRED` header is raw JSON** — parse with `JSON.parse(header)`. Do NOT `atob()` or base64-decode it.
2. **`validBefore` must be ≤ 10 minutes** from now (`Math.floor(Date.now() / 1000) + 600`). The server rejects anything longer.
3. **Spread all fields** from the 402 response's `accepts[0]` into your `accepted` object: `accepted: { ...offer }`. This preserves `extra`, `maxTimeoutSeconds`, etc.
4. **The `PAYMENT-SIGNATURE` header IS base64-encoded** — this is the outbound payload you send TO the server: `btoa(JSON.stringify(payload))`.

**Payment signing flow:**
1. Send request without payment → get 402 response
2. Parse `PAYMENT-REQUIRED` header (raw JSON) → extract `accepts[0]`
3. Sign EIP-3009 `TransferWithAuthorization` with `viem`'s `signTypedData`
4. Build payload: `{ x402Version: 2, accepted: { ...offer }, payload: { signature, authorization } }`
5. Base64-encode the payload → set as `PAYMENT-SIGNATURE` header
6. Re-send the original request with the payment header

**EIP-712 domain for USDC on Base:**
```typescript
const USDC_EIP712_DOMAIN = {
  name: 'USD Coin',
  version: '2',
  chainId: 8453,
  verifyingContract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
} as const;
```

### 3. Types (`src/types.ts`)

Define types for all API interactions:

```typescript
interface InferParams {
  model: string
  prompt: string                    // Shorthand: converted to messages array
  messages?: ChatMessage[]          // Or provide full messages array
  maxTokens?: number
  stream?: boolean
  task?: 'classify' | 'extract' | 'summarize' | 'analyze' | 'generate'
  responseFormat?: ResponseFormat   // For structured output
  tools?: Tool[]                    // For function calling
  toolChoice?: string | object
  temperature?: number
  veniceParameters?: VeniceParameters
}

interface InferResult {
  content: string
  model: string
  finishReason: string
  usage: { promptTokens: number; completionTokens: number; totalTokens: number }
  payment: {
    amountUsdc: string
    source: 'x402' | 'balance'
    balanceRemaining?: number
    tier: string
    discountPct: number
  }
  latencyMs: number
  truncated: boolean
  raw: any               // Full raw API response
}

interface TopUpResult {
  success: boolean
  wallet: string
  topupAmountUsdc: number
  balanceUsdc: number
  balanceAuthToken: string
  tokenExpiresInDays: number
}

interface BalanceResult {
  wallet: string
  balanceUsdc?: number       // Only present with valid auth token
  hasBalance: boolean
  totalTopups?: number
  lastTopupAt?: string
  createdAt?: string
}
```

### 4. CLI (`src/cli.ts`)

A CLI with subcommands:

```bash
# Per-request x402 inference
inferx infer --model llama-3.3-70b --prompt "Hello world" --max-tokens 256

# Streaming inference
inferx infer --model qwen3-4b --prompt "Write a haiku" --stream

# Dry-run: just check the price, don't pay
inferx infer --model deepseek-r1-671b --prompt "test" --dry-run

# Prepaid: top up balance
inferx topup --amount 5.00

# Prepaid: inference with balance
inferx balance-infer --model qwen3-4b --prompt "Hello" --max-tokens 128

# Check balance
inferx balance

# Refresh auth token
inferx refresh-token

# List models with pricing
inferx models

# Structured output
inferx infer --model llama-3.3-70b --prompt "Extract: John is 30 in NYC" \
  --response-format '{"type":"json_schema","json_schema":{"name":"person","strict":true,"schema":{"type":"object","properties":{"name":{"type":"string"},"age":{"type":"integer"},"city":{"type":"string"}},"required":["name","age","city"],"additionalProperties":false}}}'
```

**Environment:**
- `WALLET_PRIVATE_KEY` — Required. EVM private key (0x-prefixed hex)
- `INFERX_ENDPOINT` — Optional. Default: `https://ai-inferx.vercel.app`
- `INFERX_AUTH_TOKEN` — Optional. Persisted balance auth token

The CLI should load `.env` and `.env.local` files automatically.

### 5. Balance Auth Token Persistence

The client must persist the `balance_auth_token` across CLI invocations:

1. After `topup` or `refresh-token`, save the token to `~/.inferx/auth_token`
2. Before `balance-infer` or `balance`, load from `~/.inferx/auth_token`
3. If the token is expired (401 response), auto-refresh via EIP-191 and save the new token
4. The `INFERX_AUTH_TOKEN` env var overrides the file-based token

### 6. Streaming Support

When `--stream` is passed:
1. Set `stream: true` in the request body
2. Read the SSE response as a stream
3. Print tokens to stdout in real-time as they arrive
4. Parse the final `x_inferx` metadata chunk before `[DONE]`
5. Print payment summary after stream completes

### 7. Error Handling

- Parse error responses and show the `code` and `error` fields
- On [402](file:///c:/Users/d_ond/cursor/InferX/src/lib/x402/response.ts#7-83) after payment: show "Settlement failed" with actionable advice
- On `429`: show "Rate limited" with the specific type (IP/wallet/backend)
- On `503` with `diem_exhausted`: show reset time and suggest retrying later
- On `502` with `inference_failed_credited`: show credited amount and saved token
- On `401` (expired token): auto-refresh and retry once

## Acceptance Criteria

The following must work end-to-end against the live API at `https://ai-inferx.vercel.app`:

- [ ] `inferx models` lists available models with pricing
- [ ] `inferx infer --model qwen3-4b --prompt "What is 2+2?" --max-tokens 64` returns an inference response after x402 payment
- [ ] `inferx infer --model qwen3-4b --prompt "Write a haiku" --stream` streams tokens in real-time
- [ ] `inferx infer --model qwen3-4b --prompt "test" --dry-run` shows pricing without paying
- [ ] `inferx topup --amount 0.01` tops up $0.01 USDC and saves the auth token
- [ ] `inferx balance` shows the current balance (requires auth token)
- [ ] `inferx balance-infer --model qwen3-4b --prompt "Hello" --max-tokens 64` runs inference from prepaid balance
- [ ] `inferx refresh-token` gets a fresh auth token via EIP-191 signature
- [ ] Error responses are parsed and displayed with actionable messages
- [ ] Auth token is persisted in `~/.inferx/auth_token` across invocations

## ⚠️ Security Disclaimer: Private Key Storage

This client stores your EVM private key as a **plain-text environment variable** (`WALLET_PRIVATE_KEY` in `.env.local`). This is acceptable for development, testing, and low-value wallets, but carries real risk:

- **If your `.env.local` leaks** (accidental git commit, compromised machine, shared logs), anyone with the key can drain your wallet instantly.
- **Process environment is readable** by any code running in the same process, including dependencies.

**For production or high-value wallets, explore safer alternatives:**

| Approach | Security Level | Tradeoff |
|----------|---------------|----------|
| `.env.local` (this client) | ⚠️ Low | Simplest, fine for dev/test wallets |
| OS keychain (e.g., macOS Keychain, Windows Credential Manager) | 🟡 Medium | Encrypted at rest, unlocked per-session |
| Hardware wallet (Ledger/Trezor via WalletConnect) | 🟢 High | Physical confirmation per signature |
| Cloud KMS (AWS KMS, GCP Cloud HSM) | 🟢 High | Key never leaves secure enclave |
| MPC wallets (Fireblocks, Privy, Turnkey) | 🟢 High | Key sharded across multiple parties |

**Best practice:** Fund a dedicated hot wallet with only the USDC you plan to spend. Never use your primary wallet or cold storage private key.

---

## Non-Goals

- No web UI — CLI only
- No multi-wallet support — single wallet per invocation
- No conversation history / multi-turn — each call is stateless
- No image generation — text inference only (vision input IS supported)
