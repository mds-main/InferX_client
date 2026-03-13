---
name: inferx
version: 1.1.0
description: x402-native AI inference middleware for Venice.ai. OpenAI-compatible chat completions with USDC payments , no accounts, no API keys.
homepage: https://ai-inferx.vercel.app
metadata: {"inferx":{"emoji":"⚡","category":"ai-inference","api_base":"https://ai-inferx.vercel.app/api/v1"}}
---

# InferX , AI Inference for Agents

**OpenAI-compatible AI inference** powered by Venice.ai with permissionless x402 crypto payments. No accounts, no API keys , your wallet address IS your identity.

## Skill Files

| File | Description |
|------|-------------|
| **SKILL.md** (this file) | Main reference , endpoints, payment modes, examples |
| **PAYMENT.md** | x402 payment protocol implementation details |
| **package.json** | Skill metadata |

**Base URL:** `https://ai-inferx.vercel.app/api/v1`

---

## How It Works

InferX wraps Venice.ai models behind an OpenAI-compatible API. You pay with USDC on Base network , two modes available:

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│   Mode A: Per-Request (x402)                                │
│   Send request → Get 402 + price → Sign EIP-3009 →          │
│   Re-send with PAYMENT-SIGNATURE → Get inference result     │
│   ~1-2s settlement overhead per request                     │
│                                                             │
│   Mode B: Prepaid Balance                                   │
│   Top up once with x402 → Receive balance_auth_token →       │
│   Authorization: Bearer <token> header → ~0.1ms overhead     │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## Quick Start: Your Wallet

You need an EVM wallet with USDC on Base network:

```python
from eth_account import Account

# Generate a new wallet (save this key securely!)
account = Account.create()
print(f"Address: {account.address}")
print(f"Private Key: {account.key.hex()}")
```

**Fund your wallet** with USDC on Base (chain ID: 8453).

**Pricing:** Zero markup , Venice's exact published per-token rates. Price = f(model pricing, max_completion_tokens, input estimate). Minimum $0.001 per transaction.

---

## 1. List Models (Free)

No authentication required!

```bash
curl "https://ai-inferx.vercel.app/api/v1/models"
```

**Response:**
```json
{
  "data": [
    {
      "id": "llama-3.3-70b",
      "object": "model",
      "pricing": {
        "input_per_million": "0.35",
        "output_per_million": "0.40"
      }
    },
    {
      "id": "deepseek-r1-671b",
      "object": "model",
      "pricing": {
        "input_per_million": "2.50",
        "output_per_million": "7.50"
      }
    }
  ],
  "x402": {
    "network": "eip155:8453",
    "scheme": "exact",
    "currency": "USDC"
  }
}
```

---

## 2. Run Inference , Per-Request (x402)

### Step 1: Discover Price

Send a request without payment to get the price:

```bash
curl -X POST https://ai-inferx.vercel.app/api/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "llama-3.3-70b",
    "messages": [{"role": "user", "content": "Hello!"}],
    "max_completion_tokens": 512
  }'

# Returns 402 with PAYMENT-REQUIRED header (raw JSON, NOT base64):
# {"x402Version":2,"accepts":[{"scheme":"exact","network":"eip155:8453",
#   "amount":"1783","asset":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
#   "payTo":"0x...","maxTimeoutSeconds":30,"extra":{"name":"USD Coin","version":"2"}}]}
```

> ⚠️ The `PAYMENT-REQUIRED` header is **raw JSON** (not base64-encoded). Parse it with `JSON.parse()` / `json.loads()` directly.

### Step 2: Sign Payment & Execute

Sign an EIP-3009 `TransferWithAuthorization` for the required amount, then re-send with the `PAYMENT-SIGNATURE` header:

```bash
curl -X POST https://ai-inferx.vercel.app/api/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "PAYMENT-SIGNATURE: <base64-encoded-payment-payload>" \
  -d '{ ... same body ... }'

# Returns 200 with inference result + x_inferx metadata
# x_inferx.payment_source = "x402"
```

See **PAYMENT.md** for the complete signing implementation.

---

## 3. Run Inference , Prepaid Balance

### Step 1: Top Up

Top up your wallet with a single x402 payment. You choose how much , $1, $5, $50, etc.

To top up, you first need the treasury address. Get it from any 402 response (e.g., send a dummy inference request), then sign an EIP-3009 payment for your desired top-up amount:

```bash
curl -X POST https://ai-inferx.vercel.app/api/v1/wallet/topup \
  -H "PAYMENT-SIGNATURE: <base64-encoded-payment-payload>"

# Response:
# {
#   "success": true,
#   "wallet": "0x49b6...8c68",
#   "topup_amount_usdc": 5.0,
#   "balance_usdc": 5.0,
#   "balance_auth_token": "0x49b6...8c68.1741234567.a1b2c3d4...",
#   "token_expires_in_days": 30,
#   "request_id": "..."
# }
```

> 💡 **Save the `balance_auth_token`!** You'll use it for all subsequent inference requests and balance checks. It's HMAC-signed and bound to your wallet. Persist it across sessions (e.g., in a config file or environment variable).

### Step 2: Check Balance

```bash
curl "https://ai-inferx.vercel.app/api/v1/wallet/balance?wallet=0x49b6...8c68" \
  -H "Authorization: Bearer 0x49b6...8c68.1741234567.a1b2c3d4..."

# With auth token → exact balance:
# {
#   "wallet": "0x49b6...8c68",
#   "balance_usdc": 5.0,
#   "has_balance": true,
#   "total_topups": 1,
#   "last_topup_at": "2026-03-12T09:00:00Z",
#   "created_at": "2026-03-12T09:00:00Z"
# }

# Without auth token → only boolean (privacy protection):
# { "wallet": "0x49b6...8c68", "has_balance": true }
```

> ⚠️ **Auth token required for exact balance.** Without the `Authorization: Bearer` header, the endpoint only returns `has_balance: boolean` (no numeric amount). This prevents third parties from scanning wallet balances.

### Step 3: Run Inference (Authenticated)

Send requests with the `Authorization: Bearer` header using the `balance_auth_token` from the top-up response:

```bash
curl -X POST https://ai-inferx.vercel.app/api/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer 0x49b6...8c68.1741234567.a1b2c3d4..." \
  -d '{
    "model": "qwen3-4b",
    "messages": [{"role": "user", "content": "Hello!"}],
    "max_completion_tokens": 128
  }'

# Returns 200 with inference response
# x_inferx.payment_source = "balance"
# x_inferx.balance_remaining_usdc = 4.999
```

### Step 4: Refresh Token (Without Topping Up)

When your auth token expires (after 30 days), you can get a fresh one without topping up by signing an EIP-191 message:

```bash
curl -X POST https://ai-inferx.vercel.app/api/v1/wallet/auth \
  -H "Content-Type: application/json" \
  -d '{
    "wallet": "0x49b6...8c68",
    "message": "InferX balance auth 1741234567",
    "signature": "<EIP-191 personal_sign of the message>"
  }'

# Response:
# {
#   "balance_auth_token": "0x49b6...8c68.1741234567.newtoken...",
#   "balance_usdc": 4.50,
#   "wallet": "0x49b6...8c68"
# }
```

> 🔐 The `balance_auth_token` expires after **30 days**. Use `/v1/wallet/auth` to refresh it, or top up again to get a new one automatically.

---

## Endpoints Reference

### POST /v1/chat/completions

Create a chat completion. Supports both JSON and SSE streaming responses.

**Request Body:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `model` | string | Yes | Venice model ID (e.g. `llama-3.3-70b`, `deepseek-r1-671b`) |
| `messages` | array | Yes | Array of `{role, content}` message objects. Roles: `system`, `developer`, `user`, `assistant`, `tool` |
| `max_completion_tokens` | integer | * | Max output tokens (determines price). Required unless `x_inferx.task` provided |
| `stream` | boolean | No | Enable SSE streaming (default: false) |
| `temperature` | number | No | 0–2 (default: model default) |
| `top_p` | number | No | 0–1 nucleus sampling |
| `top_k` | integer | No | Top-K sampling cutoff (≥0) |
| `min_p` | number | No | 0–1 minimum probability threshold |
| `min_temp` / `max_temp` | number | No | 0–2 dynamic temperature range |
| `frequency_penalty` | number | No | -2 to 2 (penalize frequent tokens) |
| `presence_penalty` | number | No | -2 to 2 (penalize repeated tokens) |
| `repetition_penalty` | number | No | ≥0 repetition penalty factor |
| `stop` | string/array | No | Stop sequences |
| `stop_token_ids` | number[] | No | Model-specific stop token IDs |
| `seed` | integer | No | Random seed for reproducibility |
| `reasoning` | object | No | `{effort, summary}` , controls reasoning depth for thinking models |
| `reasoning_effort` | string | No | Shorthand: `none`\|`minimal`\|`low`\|`medium`\|`high`\|`xhigh`\|`max` |
| `prompt_cache_key` | string | No | Cache key for multi-turn sessions (reduces cost) |
| `prompt_cache_retention` | string | No | `default`\|`extended`\|`24h` |
| `response_format` | object | No | Output format: `{type: "text"}`, `{type: "json_object"}`, or `{type: "json_schema", json_schema: {name, schema, strict: true}}` |
| `tools` | array | No | OpenAI-compatible function definitions for tool/function calling |
| `tool_choice` | string/object | No | `"auto"`, `"none"`, `"required"`, or `{type: "function", function: {name: "..."}}` |
| `x_inferx.task` | string | No | Task hint , auto-resolves `max_completion_tokens` (see Task Hints) |
| `venice_parameters` | object | No | Venice-specific parameters (see below) |

**Venice Parameters (pass-through):**
| Parameter | Type | Description |
|-----------|------|-------------|
| `enable_web_search` | string | `"on"`, `"off"`, or `"auto"` |
| `enable_web_scraping` | boolean | Enable web page scraping |
| `enable_web_citations` | boolean | Include source citations |
| `strip_thinking_response` | boolean | Strip `<thinking>` tags from reasoning models |
| `disable_thinking` | boolean | Disable chain-of-thought reasoning |
| `return_search_results_as_documents` | boolean | Return search results as structured documents |
| `include_search_results_in_stream` | boolean | Include search results in streaming response |

**Vision Messages (multimodal):**
Models that support vision accept image content in messages:
```json
{
  "messages": [{
    "role": "user",
    "content": [
      {"type": "text", "text": "What's in this image?"},
      {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,/9j/4AAQ..."}}
    ]
  }]
}
```

**Payment Headers (provide one):**
| Header | Description |
|--------|-------------|
| `PAYMENT-SIGNATURE` | Base64-encoded x402 payment payload (per-request settlement) |
| `Authorization: Bearer` | Balance auth token from top-up response (HMAC-signed, 30-day expiry) |

**Omit both headers** for price discovery , returns 402 with payment requirements.

### POST /v1/wallet/topup

Top up prepaid balance via x402 payment. Requires `PAYMENT-SIGNATURE` header.

| Response Field | Type | Description |
|----------------|------|-------------|
| `success` | boolean | Whether top-up was successful |
| `wallet` | string | Normalized wallet address |
| `topup_amount_usdc` | number | Amount credited |
| `balance_usdc` | number | New total balance |
| `balance_auth_token` | string | HMAC-signed auth token for balance inference (30-day expiry) |
| `token_expires_in_days` | integer | Token validity period (30 days) |

### POST /v1/wallet/auth

Obtain a fresh `balance_auth_token` without topping up. Requires an EIP-191 personal signature proving wallet ownership.

| Request Field | Type | Required | Description |
|---------------|------|----------|-------------|
| `wallet` | string | Yes | Your wallet address (0x...) |
| `message` | string | Yes | The message you signed (e.g. `"InferX balance auth <unix_timestamp>"`) |
| `signature` | string | Yes | EIP-191 `personal_sign` signature of the message |

| Response Field | Type | Description |
|----------------|------|-------------|
| `balance_auth_token` | string | Fresh HMAC-signed auth token (30-day expiry) |
| `balance_usdc` | number | Current balance |
| `wallet` | string | Normalized wallet address |

### GET /v1/wallet/balance

Query prepaid balance for a wallet. **Exact balance amount requires a valid `Authorization: Bearer <balance_auth_token>` header.** Without auth, only `has_balance` (boolean) is returned.

| Query Param | Required | Description |
|-------------|----------|-------------|
| `wallet` | Yes | Wallet address (0x...) |

### GET /v1/models

List available models with pricing. No payment required.

---

## Task Hints

Use `x_inferx.task` to auto-resolve `max_completion_tokens`:

| Task | Tokens | Use Case |
|------|--------|----------|
| `classify` | 32 | Sentiment, yes/no, labels |
| `extract` | 256 | JSON extraction, entities |
| `summarize` | 512 | Summaries, short answers |
| `analyze` | 2,048 | Reports, reasoning |
| `generate` | 4,096 | Long-form, code generation |

**Example:**
```json
{
  "model": "llama-3.3-70b",
  "messages": [{"role": "user", "content": "Is this email spam? 'You won $1M!'"}],
  "x_inferx": {"task": "classify"}
}
```

No need to calculate `max_completion_tokens` , InferX resolves it from the task hint and prices accordingly.

---

## Tier Discounts

| Tier | Discount | Requirements |
|------|----------|-------------|
| new | 0% | Default for all wallets |
| established | 5% | ≥100 requests + ≥95% payment success |
| trusted | 10% | ≥50,000 requests + ≥99.5% payment success |

Tiers are evaluated continuously. If success rate drops below threshold, the wallet is demoted. Tier discounts apply to both payment modes.

---

## Streaming (SSE)

Set `stream: true` for Server-Sent Events:

```bash
curl -X POST https://ai-inferx.vercel.app/api/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer 0x49b6...8c68.1741234567.a1b2c3d4..." \
  -d '{
    "model": "llama-3.3-70b",
    "messages": [{"role": "user", "content": "Write a haiku about code"}],
    "max_completion_tokens": 128,
    "stream": true
  }'
```

Payment (or balance deduction) occurs **before** streaming begins. The final SSE event before `[DONE]` contains `x_inferx` metadata. Works with both payment modes.

---

## Response Metadata

All successful responses include an `x_inferx` object with operational metadata:

```json
{
  "id": "chatcmpl-abc123",
  "object": "chat.completion",
  "model": "llama-3.3-70b",
  "choices": [{
    "index": 0,
    "message": {"role": "assistant", "content": "Hello! How can I help?"},
    "finish_reason": "stop"
  }],
  "usage": {"prompt_tokens": 12, "completion_tokens": 8, "total_tokens": 20},
  "x_inferx": {
    "payment_usdc": "0.001783",
    "payment_source": "balance",
    "balance_remaining_usdc": 4.998,
    "base_price_usdc": "0.001783",
    "discount_pct": 0,
    "client_tier": "new",
    "latency_ms": 847,
    "truncated": false,
    "venice_model_id": "llama-3.3-70b",
    "provider": "venice"
  }
}
```

| Field | Description |
|-------|-------------|
| `payment_usdc` | Amount charged (after discount) |
| `payment_source` | `"x402"` or `"balance"` |
| `balance_remaining_usdc` | Remaining prepaid balance (only when `payment_source` = `"balance"`) |
| `base_price_usdc` | Price before tier discount |
| `discount_pct` | Tier discount percentage applied |
| `client_tier` | Current wallet tier |
| `latency_ms` | Total request latency |
| `truncated` | Whether output hit token limit |

---

## Retry Credits & Auto-Credit

If Venice fails after you've paid (either via x402 or balance), InferX protects your funds:

### Balance Payments
If you paid via prepaid balance, the amount is **automatically refunded** to your balance.

### Per-Request x402 Payments
If you paid via x402 (on-chain settlement), InferX:
1. **Credits** the settled USDC amount to your prepaid balance
2. Returns a `balance_auth_token` in the error response for future use
3. Issues a backward-compatible retry credit via `X-InferX-Retry-Credit` header

```json
// 502 response body when x402 payment was credited:
{
  "error": "Inference failed after automatic retry. Your payment of $0.001783 USDC has been credited to your prepaid balance.",
  "code": "inference_failed_credited",
  "balance_credited_usdc": 0.001783,
  "balance_auth_token": "0x49b6...8c68.1741234567.a1b2c3d4...",
  "hint": "Use the balance_auth_token with Authorization: Bearer header for future requests."
}
```

### DIEM Credit Exhaustion
InferX daily inference capacity is backed by DIEM credits that reset at **00:00 UTC**. When exhausted:
- All new requests return `503` with `code: "diem_exhausted"` and `resets_at` timestamp
- No payments are accepted until capacity resets
- Any in-flight x402 requests affected by the exhaustion are **automatically credited** to prepaid balance

```json
// 503 response body during DIEM exhaustion:
{
  "error": "InferX daily inference capacity exhausted (DIEM credits reset at 00:00 UTC).",
  "code": "diem_exhausted",
  "resets_at": "2026-03-13T00:00:00.000Z",
  "retry_after": 28800
}
```

---

## Error Codes

All error responses include a machine-readable `code` field and a human-readable `error` message.

| Status | Code | Meaning |
|--------|------|---------|
| 400 | `invalid_json` | Request body is not valid JSON |
| 400 | `validation_error` | Missing or invalid fields (details in `error`) |
| 400 | `model_not_found` | Model ID not available |
| 400 | `vision_not_supported` | Model does not support image input |
| 400 | `bad_request` | Invalid request parameters at backend level |
| 400 | `invalid_image` | Corrupted or unsupported image data |
| 401 | `auth_token_expired` | Balance auth token has expired , refresh via `/v1/wallet/auth` or top up again |
| 402 | , | Payment required , price in `PAYMENT-REQUIRED` header |
| 402 | `settlement_failed` | On-chain settlement failed (funds not transferred) |
| 400 | `missing_wallet_in_payment` | x402 payment is missing sender wallet , settlement blocked for safety |
| 403 | `wallet_blocked` | Wallet blocked for policy violations |
| 429 | `ip_rate_limit` | Too many requests from IP address |
| 429 | `wallet_rate_limit` | Per-wallet rate limit (sec/min/daily spend) |
| 429 | `backend_rate_limit` | Backend rate limit reached |
| 429 | `topup_rate_limit` | Top-up rate limit exceeded |
| 502 | `inference_failed_credited` | Inference failed after retry , payment credited |
| 502 | `streaming_failed_credited` | Streaming inference failed , payment credited |
| 502 | `backend_error` | Backend inference error (auto-retrying) |
| 502 | `unexpected_error` | Unexpected backend error |
| 503 | `circuit_breaker_open` | Backend temporarily unavailable |
| 503 | `capacity_exhausted` | Daily inference capacity exhausted |
| 503 | `diem_exhausted` | DIEM credits exhausted (resets at 00:00 UTC) |
| 503 | `keys_exhausted` | All backend API keys temporarily unavailable |
| 503 | `backend_auth_error` | Backend auth issue , key rotation in progress |
| 503 | `backend_overloaded` | Backend temporarily overloaded |
| 504 | `backend_timeout` | Backend request timed out |
| 500 | `internal_error` | Unexpected error , funds safeguarded |

---

## Payment Modes Comparison

| Feature | Per-Request (x402) | Prepaid Balance |
|---------|-------------------|-----------------| 
| Settlement | On-chain per request | On-chain once (top-up) |
| Latency overhead | ~1-2s per request | ~0.1ms per request |
| Header | `PAYMENT-SIGNATURE` | `Authorization: Bearer <token>` |
| Wallet proof | EIP-3009 signature per request | HMAC-signed token from top-up |
| Best for | One-off, testing, agents | Chatbots, batch, continuous |
| Min amount | $0.001 per request | $0.001 per top-up |
| Token expiry | N/A | 30 days (refresh via `/v1/wallet/auth`) |

---

## Complete Example: Python (x402 Per-Request)

```python
import os
import time
import json
import base64
import secrets
import httpx
from eth_account import Account
from eth_account.messages import encode_typed_data

# Your wallet
PRIVATE_KEY = os.getenv("WALLET_PRIVATE_KEY")
account = Account.from_key(PRIVATE_KEY)
API_BASE = "https://ai-inferx.vercel.app/api/v1"
USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"

def sign_payment(payment_option):
    """Sign EIP-3009 payment authorization."""
    valid_before = int(time.time()) + 600  # 10 minutes (server max)
    nonce = "0x" + secrets.token_bytes(32).hex()

    typed_data = {
        "types": {
            "EIP712Domain": [
                {"name": "name", "type": "string"},
                {"name": "version", "type": "string"},
                {"name": "chainId", "type": "uint256"},
                {"name": "verifyingContract", "type": "address"},
            ],
            "TransferWithAuthorization": [
                {"name": "from", "type": "address"},
                {"name": "to", "type": "address"},
                {"name": "value", "type": "uint256"},
                {"name": "validAfter", "type": "uint256"},
                {"name": "validBefore", "type": "uint256"},
                {"name": "nonce", "type": "bytes32"},
            ],
        },
        "primaryType": "TransferWithAuthorization",
        "domain": {
            "name": "USD Coin",
            "version": "2",
            "chainId": 8453,
            "verifyingContract": USDC_BASE,
        },
        "message": {
            "from": account.address,
            "to": payment_option["payTo"],
            "value": int(payment_option["amount"]),
            "validAfter": 0,
            "validBefore": valid_before,
            "nonce": nonce,
        },
    }

    signature = account.sign_message(encode_typed_data(full_message=typed_data))

    # Spread all fields from the 402 response's payment option
    # This ensures extra fields (like EIP-712 domain hints) are forwarded
    payload = {
        "x402Version": 2,
        "accepted": {**payment_option},
        "payload": {
            "signature": f"0x{signature.signature.hex()}",
            "authorization": {
                "from": account.address,
                "to": payment_option["payTo"],
                "value": payment_option["amount"],
                "validAfter": "0",
                "validBefore": str(valid_before),
                "nonce": nonce,
            },
        },
    }

    return base64.b64encode(json.dumps(payload).encode()).decode()

def infer(model, prompt, max_tokens=512):
    """Run inference with x402 per-request payment."""
    body = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "max_completion_tokens": max_tokens,
    }
    url = f"{API_BASE}/chat/completions"

    with httpx.Client(timeout=120) as client:
        # 1. Get price (PAYMENT-REQUIRED header is raw JSON, NOT base64)
        resp = client.post(url, json=body)

        if resp.status_code == 402:
            requirements = json.loads(resp.headers["payment-required"])
            option = next(o for o in requirements["accepts"] if o["network"] == "eip155:8453")

            price = int(option["amount"]) / 1_000_000
            print(f"Price: ${price:.6f} USDC")

            # 2. Sign and execute
            payment_sig = sign_payment(option)
            resp = client.post(url, json=body, headers={"PAYMENT-SIGNATURE": payment_sig})

        result = resp.json()
        print(f"Response: {result['choices'][0]['message']['content']}")
        print(f"Paid: ${result['x_inferx']['payment_usdc']} USDC")
        return result

# Usage
infer("llama-3.3-70b", "Explain quantum computing in one sentence")
```

---

## Complete Example: Python (Prepaid Balance)

```python
import os
import time
import json
import base64
import secrets
import httpx
from eth_account import Account
from eth_account.messages import encode_typed_data, encode_defunct

PRIVATE_KEY = os.getenv("WALLET_PRIVATE_KEY")
account = Account.from_key(PRIVATE_KEY)
API_BASE = "https://ai-inferx.vercel.app/api/v1"
USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"

def top_up(amount_usdc: float) -> dict:
    """Top up prepaid balance via x402 payment."""
    with httpx.Client(timeout=120) as client:
        # 1. Get treasury address from any 402 response
        resp = client.post(f"{API_BASE}/chat/completions", json={
            "model": "qwen3-4b",
            "messages": [{"role": "user", "content": "test"}],
            "max_completion_tokens": 1,
        })
        requirements = json.loads(resp.headers["payment-required"])
        option = requirements["accepts"][0]

        # 2. Sign EIP-3009 for desired top-up amount
        amount_atomic = int(amount_usdc * 1_000_000)
        valid_before = int(time.time()) + 600  # 10 minutes (server max)
        nonce = "0x" + secrets.token_bytes(32).hex()

        typed_data = {
            "types": {
                "EIP712Domain": [
                    {"name": "name", "type": "string"},
                    {"name": "version", "type": "string"},
                    {"name": "chainId", "type": "uint256"},
                    {"name": "verifyingContract", "type": "address"},
                ],
                "TransferWithAuthorization": [
                    {"name": "from", "type": "address"},
                    {"name": "to", "type": "address"},
                    {"name": "value", "type": "uint256"},
                    {"name": "validAfter", "type": "uint256"},
                    {"name": "validBefore", "type": "uint256"},
                    {"name": "nonce", "type": "bytes32"},
                ],
            },
            "primaryType": "TransferWithAuthorization",
            "domain": {
                "name": "USD Coin", "version": "2",
                "chainId": 8453, "verifyingContract": USDC_BASE,
            },
            "message": {
                "from": account.address, "to": option["payTo"],
                "value": amount_atomic, "validAfter": 0,
                "validBefore": valid_before, "nonce": nonce,
            },
        }

        signature = account.sign_message(encode_typed_data(full_message=typed_data))

        payload = {
            "x402Version": 2,
            "accepted": {**option, "amount": str(amount_atomic)},
            "payload": {
                "signature": f"0x{signature.signature.hex()}",
                "authorization": {
                    "from": account.address, "to": option["payTo"],
                    "value": str(amount_atomic), "validAfter": "0",
                    "validBefore": str(valid_before), "nonce": nonce,
                },
            },
        }

        payment_sig = base64.b64encode(json.dumps(payload).encode()).decode()

        # 3. Send to topup endpoint
        resp = client.post(f"{API_BASE}/wallet/topup",
            headers={"PAYMENT-SIGNATURE": payment_sig})

        result = resp.json()
        print(f"Topped up: ${result['topup_amount_usdc']} USDC")
        print(f"Balance: ${result['balance_usdc']} USDC")
        return result

def refresh_token() -> str:
    """Get a fresh auth token via EIP-191 signature (no top-up needed)."""
    timestamp = int(time.time())
    message = f"InferX balance auth {timestamp}"

    signature = account.sign_message(encode_defunct(text=message))

    resp = httpx.post(f"{API_BASE}/wallet/auth", json={
        "wallet": account.address,
        "message": message,
        "signature": f"0x{signature.signature.hex()}",
    })

    result = resp.json()
    return result["balance_auth_token"]

def infer_with_balance(token: str, model: str, prompt: str, max_tokens: int = 128):
    """Run inference using prepaid balance."""
    resp = httpx.post(f"{API_BASE}/chat/completions",
        json={
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "max_completion_tokens": max_tokens,
        },
        headers={"Authorization": f"Bearer {token}"},
        timeout=120,
    )

    result = resp.json()
    print(f"Response: {result['choices'][0]['message']['content']}")
    print(f"Remaining: ${result['x_inferx']['balance_remaining_usdc']} USDC")
    return result

# Usage
topup_result = top_up(5.0)  # $5 USDC
token = topup_result["balance_auth_token"]

# Run multiple requests with zero settlement overhead
infer_with_balance(token, "qwen3-4b", "Hello!")
infer_with_balance(token, "llama-3.3-70b", "Write a haiku")

# When token expires (30 days), refresh without topping up:
token = refresh_token()
```

---

## Complete Example: TypeScript / Node.js (x402 Per-Request)

```typescript
import { Wallet } from "ethers";

const API_BASE = "https://ai-inferx.vercel.app/api/v1";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const wallet = new Wallet(process.env.WALLET_PRIVATE_KEY!);

async function signPayment(paymentOption: any): Promise<string> {
  const validBefore = Math.floor(Date.now() / 1000) + 600; // 10 minutes (server max)
  const nonce = "0x" + Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map(b => b.toString(16).padStart(2, "0")).join("");

  const domain = {
    name: "USD Coin",
    version: "2",
    chainId: 8453,
    verifyingContract: USDC_BASE,
  };

  const types = {
    TransferWithAuthorization: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
    ],
  };

  const message = {
    from: wallet.address,
    to: paymentOption.payTo,
    value: BigInt(paymentOption.amount),
    validAfter: 0n,
    validBefore: BigInt(validBefore),
    nonce,
  };

  const signature = await wallet.signTypedData(domain, types, message);

  // Spread all fields from the 402 response's payment option
  const payload = {
    x402Version: 2,
    accepted: { ...paymentOption },
    payload: {
      signature,
      authorization: {
        from: wallet.address,
        to: paymentOption.payTo,
        value: paymentOption.amount,
        validAfter: "0",
        validBefore: String(validBefore),
        nonce,
      },
    },
  };

  return btoa(JSON.stringify(payload));
}

async function infer(model: string, prompt: string, maxTokens = 512) {
  const url = `${API_BASE}/chat/completions`;
  const body = {
    model,
    messages: [{ role: "user", content: prompt }],
    max_completion_tokens: maxTokens,
  };

  // 1. Get price (PAYMENT-REQUIRED header is raw JSON, NOT base64)
  let resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (resp.status === 402) {
    const requirements = JSON.parse(resp.headers.get("payment-required")!);
    const option = requirements.accepts.find((o: any) => o.network === "eip155:8453");
    console.log(`Price: $${Number(option.amount) / 1_000_000} USDC`);

    // 2. Sign and execute
    const paymentSig = await signPayment(option);
    resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "PAYMENT-SIGNATURE": paymentSig,
      },
      body: JSON.stringify(body),
    });
  }

  const result = await resp.json();
  console.log(`Response: ${result.choices[0].message.content}`);
  console.log(`Paid: $${result.x_inferx.payment_usdc} USDC`);
  return result;
}

// Usage
infer("llama-3.3-70b", "Explain quantum computing in one sentence");
```

---

## Advanced: Structured Output

Use `response_format` with `json_schema` for type-safe AI outputs:

```python
resp = httpx.post(f"{API_BASE}/chat/completions",
    json={
        "model": "llama-3.3-70b",
        "messages": [{"role": "user", "content": "Extract: 'John is 30 and lives in NYC'"}],
        "max_completion_tokens": 256,
        "response_format": {
            "type": "json_schema",
            "json_schema": {
                "name": "person_extraction",
                "strict": True,
                "schema": {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string"},
                        "age": {"type": "integer"},
                        "city": {"type": "string"}
                    },
                    "required": ["name", "age", "city"],
                    "additionalProperties": False
                }
            }
        }
    },
    headers={"Authorization": f"Bearer {token}"},
    timeout=120,
)

# Response is guaranteed to match the schema:
# {"name": "John", "age": 30, "city": "NYC"}
```

---

## Advanced: Function Calling

Use OpenAI-compatible `tools` for function calling:

```python
resp = httpx.post(f"{API_BASE}/chat/completions",
    json={
        "model": "llama-3.3-70b",
        "messages": [{"role": "user", "content": "What's the weather in Paris?"}],
        "max_completion_tokens": 256,
        "tools": [{
            "type": "function",
            "function": {
                "name": "get_weather",
                "description": "Get current weather for a location",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "location": {"type": "string", "description": "City name"},
                        "unit": {"type": "string", "enum": ["celsius", "fahrenheit"]}
                    },
                    "required": ["location"]
                }
            }
        }],
        "tool_choice": "auto"
    },
    headers={"Authorization": f"Bearer {token}"},
    timeout=120,
)

# Response includes tool_calls when the model decides to use a function:
# choices[0].message.tool_calls = [
#   {"id": "call_123", "type": "function",
#    "function": {"name": "get_weather", "arguments": "{\"location\":\"Paris\",\"unit\":\"celsius\"}"}}
# ]
```

---

## Advanced: Vision (Multimodal)

Send images to vision-capable models:

```python
import base64

# Load image as base64
with open("photo.jpg", "rb") as f:
    image_b64 = base64.b64encode(f.read()).decode()

resp = httpx.post(f"{API_BASE}/chat/completions",
    json={
        "model": "qwen-2.5-vl",  # Use a vision-capable model
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": "Describe what you see in this image"},
                {"type": "image_url", "image_url": {
                    "url": f"data:image/jpeg;base64,{image_b64}"
                }}
            ]
        }],
        "max_completion_tokens": 512
    },
    headers={"Authorization": f"Bearer {token}"},
    timeout=120,
)
```

> ⚠️ Not all models support vision. If a model doesn't support image input, the API returns `400` with code `vision_not_supported`.

---

## Everything You Can Do ⚡

| Action | What it does |
|--------|-------------|
| **List Models** | Get all available Venice models with pricing |
| **Infer (x402)** | Run inference with per-request on-chain payment |
| **Infer (Balance)** | Run inference from prepaid balance (~0.1ms overhead) |
| **Top Up** | Add USDC to your prepaid balance |
| **Check Balance** | View your remaining prepaid balance |
| **Refresh Token** | Get a fresh auth token via EIP-191 signature |
| **Stream** | Get SSE streaming responses |
| **Task Hints** | Auto-resolve token limits by task type |
| **Structured Output** | Get JSON schema-validated responses |
| **Function Calling** | OpenAI-compatible tool use |
| **Vision** | Send images to multimodal models |
| **Web Search** | Venice web search with citations |

---

## ⚠️ Critical Implementation Notes

1. **`PAYMENT-REQUIRED` header is raw JSON** , parse with `JSON.parse()` / `json.loads()` directly. Do NOT base64-decode it.
2. **`validBefore` must be ≤ 10 minutes** in the future. The server rejects signatures with `validBefore` more than 10 minutes from now.
3. **Spread all fields** from the 402 response's `accepts[0]` into your `accepted` object. This ensures `extra` fields (EIP-712 domain hints) and `maxTimeoutSeconds` are forwarded correctly.
4. **Auth token required for exact balance** , without it, `/v1/wallet/balance` only returns `has_balance: boolean`.
5. **Persist `balance_auth_token`** across sessions. It's valid for 30 days and can be refreshed via `/v1/wallet/auth`.

---

## Ideas to Try

- Use task hints (`classify`, `extract`, `summarize`) for cost-optimized inference
- Top up a prepaid balance for batch processing workflows
- Stream responses for real-time chatbot UIs
- Use `response_format: {type: "json_schema", ...}` for structured extraction
- Enable Venice web search for up-to-date information
- Build an AI agent that pays per inference with x402
- Use function calling for tool-augmented agents
- Send images to vision models for multimodal analysis

---

## Need Help?

- **API Base:** `https://ai-inferx.vercel.app/api/v1`
- **API Docs:** `https://ai-inferx.vercel.app/docs`
- **OpenAPI Spec:** `https://ai-inferx.vercel.app/api/docs`
- **Payment Network:** Base (chain ID 8453)
- **Currency:** USDC
- **x402 Protocol:** [x402.org](https://x402.org)

Happy inferring! ⚡
