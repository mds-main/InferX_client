# x402 Payment Protocol Guide for InferX 💳

Complete guide to implementing x402 payments for the InferX API.

## Overview

The x402 protocol enables permissionless crypto payments for API resources. Instead of API keys or accounts, you pay with USDC on Base network.

**Key Concept:** Your wallet address IS your identity. No registration needed.

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│   Per-Request Flow:                                         │
│   1. Request resource ──► Server returns 402 + requirements │
│   2. Sign EIP-3009 authorization (off-chain, no gas)        │
│   3. Re-request with PAYMENT-SIGNATURE header               │
│   4. Server settles on-chain and delivers response          │
│                                                             │
│   Prepaid Balance Flow:                                     │
│   1. POST /v1/wallet/topup with PAYMENT-SIGNATURE           │
│   2. Balance credited , wallet ownership proven on-chain    │
│   3. Infer with Authorization: Bearer <token> (~0.1ms)       │
│   4. Refresh token via POST /v1/wallet/auth when expired    │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## Prerequisites

### 1. EVM Wallet

You need a wallet compatible with EIP-712 signing:

```python
from eth_account import Account

# Generate new wallet
account = Account.create()
print(f"Address: {account.address}")
print(f"Private Key: {account.key.hex()}")  # SAVE THIS SECURELY!

# Or load existing
account = Account.from_key("0x...")
```

### 2. USDC on Base

Fund your wallet with USDC on Base network:

- **Network:** Base (chain ID: 8453)
- **USDC Contract:** `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
- **Decimals:** 6 (1 USDC = 1,000,000 units)

### 3. Required Packages

**Python:**
```bash
pip install eth-account httpx
```

**TypeScript/Node.js:**
```bash
npm install ethers
```

---

## Per-Request Payment Flow

### Step 1: Request Resource

Make a normal request without payment:

```python
import httpx

response = httpx.post("https://ai-inferx.vercel.app/api/v1/chat/completions", json={
    "model": "llama-3.3-70b",
    "messages": [{"role": "user", "content": "Hello!"}],
    "max_completion_tokens": 512
})

# Response: 402 Payment Required
```

### Step 2: Parse Payment Requirements

The 402 response includes a `PAYMENT-REQUIRED` header containing **raw JSON** (not base64):

```python
import json

# IMPORTANT: The header is raw JSON — parse directly, do NOT base64-decode
header = response.headers["payment-required"]
requirements = json.loads(header)

print(json.dumps(requirements, indent=2))
```

**Example Requirements:**
```json
{
  "x402Version": 2,
  "accepts": [
    {
      "scheme": "exact",
      "network": "eip155:8453",
      "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "amount": "1783",
      "payTo": "0x...",
      "maxTimeoutSeconds": 30,
      "extra": {
        "name": "USD Coin",
        "version": "2"
      }
    }
  ]
}
```

**Fields:**
| Field | Description |
|-------|-------------|
| `scheme` | Always `"exact"` for InferX |
| `network` | `"eip155:8453"` (Base network) |
| `asset` | USDC contract address |
| `amount` | Amount in smallest units (1783 = $0.001783) |
| `payTo` | Recipient address (InferX treasury) |
| `maxTimeoutSeconds` | Max settlement timeout |
| `extra` | EIP-712 domain hints (`name`, `version`) for USDC contract |

### Step 3: Sign EIP-3009 Authorization

EIP-3009 allows off-chain authorization of token transfers. You sign a message authorizing the transfer, then the server executes it.

**This is NOT a transaction** , no gas fees, happens instantly.

```python
import time
import secrets
from eth_account import Account
from eth_account.messages import encode_typed_data

def sign_transfer_authorization(account, payment_option):
    """
    Sign an EIP-3009 TransferWithAuthorization.

    This authorizes the facilitator to transfer USDC from your wallet
    to the payment recipient. The transfer only happens when the server
    calls the USDC contract with your signature.
    """

    # Authorization window: 10 minutes max (server rejects longer windows)
    valid_before = int(time.time()) + 600

    # Random nonce (prevents replay attacks)
    nonce = "0x" + secrets.token_bytes(32).hex()

    # EIP-712 typed data structure
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
            "chainId": 8453,  # Base network
            "verifyingContract": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",  # USDC
        },
        "message": {
            "from": account.address,
            "to": payment_option["payTo"],
            "value": int(payment_option["amount"]),
            "validAfter": 0,  # Valid immediately
            "validBefore": valid_before,
            "nonce": nonce,
        },
    }

    # Sign the typed data
    signature = account.sign_message(encode_typed_data(full_message=typed_data))

    return {
        "signature": f"0x{signature.signature.hex()}",
        "valid_before": valid_before,
        "nonce": nonce,
    }
```

### Step 4: Build Payment Payload

Combine the authorization with metadata. **Spread all fields** from the 402 response's payment option into the `accepted` object to ensure `extra` fields (EIP-712 domain hints) and `maxTimeoutSeconds` are forwarded:

```python
import base64

def build_payment_payload(account, payment_option, auth):
    """Build the PAYMENT-SIGNATURE header value."""

    payload = {
        "x402Version": 2,
        # Spread all fields from the 402 response — don't cherry-pick
        "accepted": {**payment_option},
        "payload": {
            "signature": auth["signature"],
            "authorization": {
                "from": account.address,
                "to": payment_option["payTo"],
                "value": payment_option["amount"],
                "validAfter": "0",
                "validBefore": str(auth["valid_before"]),
                "nonce": auth["nonce"],
            },
        },
    }

    return base64.b64encode(json.dumps(payload).encode()).decode()
```

### Step 5: Submit Request with Payment

Add the payment signature header:

```python
payment_header = build_payment_payload(account, payment_option, auth)

response = httpx.post(
    "https://ai-inferx.vercel.app/api/v1/chat/completions",
    json={
        "model": "llama-3.3-70b",
        "messages": [{"role": "user", "content": "Hello!"}],
        "max_completion_tokens": 512,
    },
    headers={"PAYMENT-SIGNATURE": payment_header}
)

# Response: 200 OK with inference result
```

---

## Prepaid Balance Flow

The prepaid balance mode eliminates per-request settlement overhead.

### Top Up

Use the same EIP-3009 signing to top up your wallet. First, get the treasury address from any 402 response, then sign for your desired top-up amount:

```python
# 1. Get treasury address from a 402 response
resp = httpx.post("https://ai-inferx.vercel.app/api/v1/chat/completions", json={
    "model": "qwen3-4b",
    "messages": [{"role": "user", "content": "test"}],
    "max_completion_tokens": 1,
})
requirements = json.loads(resp.headers["payment-required"])
option = requirements["accepts"][0]

# 2. Sign for your desired top-up amount (e.g., $5 USDC = 5000000 units)
# Override the amount field with your top-up amount
topup_amount_atomic = 5000000  # $5.00
auth = sign_transfer_authorization(account, {**option, "amount": str(topup_amount_atomic)})
payment_header = build_payment_payload(account, {**option, "amount": str(topup_amount_atomic)}, auth)

# 3. Send to topup endpoint
response = httpx.post(
    "https://ai-inferx.vercel.app/api/v1/wallet/topup",
    headers={"PAYMENT-SIGNATURE": payment_header}
)

result = response.json()
balance_auth_token = result['balance_auth_token']  # Save this!
print(f"Balance: ${result['balance_usdc']} USDC")
print(f"Token expires in: {result['token_expires_in_days']} days")
```

### Use Balance

After top-up, use the `balance_auth_token` with the `Authorization: Bearer` header:

```python
response = httpx.post(
    "https://ai-inferx.vercel.app/api/v1/chat/completions",
    json={
        "model": "llama-3.3-70b",
        "messages": [{"role": "user", "content": "Hello!"}],
        "max_completion_tokens": 512,
    },
    headers={"Authorization": f"Bearer {balance_auth_token}"}
)

# ~0.1ms payment overhead!
result = response.json()
print(f"Remaining: ${result['x_inferx']['balance_remaining_usdc']} USDC")
```

### Check Balance

```python
# With auth token → exact numeric balance
response = httpx.get(
    f"https://ai-inferx.vercel.app/api/v1/wallet/balance?wallet={account.address}",
    headers={"Authorization": f"Bearer {balance_auth_token}"}
)
result = response.json()
print(f"Balance: ${result['balance_usdc']} USDC")

# Without auth token → only boolean (privacy protection)
response = httpx.get(
    f"https://ai-inferx.vercel.app/api/v1/wallet/balance?wallet={account.address}"
)
result = response.json()
print(f"Has balance: {result['has_balance']}")  # True/False only
```

> ⚠️ The exact numeric `balance_usdc` field is **only returned when you provide a valid auth token**. Without it, you only get `has_balance: boolean`. This prevents third parties from scanning wallet balances.

### Refresh Token (Without Topping Up)

When your auth token expires after 30 days, get a fresh one via EIP-191 personal signature:

```python
from eth_account.messages import encode_defunct

timestamp = int(time.time())
message = f"InferX balance auth {timestamp}"

# Sign with EIP-191 personal_sign
signature = account.sign_message(encode_defunct(text=message))

response = httpx.post("https://ai-inferx.vercel.app/api/v1/wallet/auth", json={
    "wallet": account.address,
    "message": message,
    "signature": f"0x{signature.signature.hex()}",
})

result = response.json()
balance_auth_token = result["balance_auth_token"]  # Fresh 30-day token
print(f"Balance: ${result['balance_usdc']} USDC")
```

---

## Complete Python Implementation

```python
import os
import time
import json
import base64
import secrets
import httpx
from eth_account import Account
from eth_account.messages import encode_typed_data, encode_defunct


class InferXPayment:
    """x402 payment handler for InferX API."""

    USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
    BASE_CHAIN_ID = 8453

    def __init__(self, private_key: str):
        self.account = Account.from_key(private_key)

    @property
    def wallet_address(self) -> str:
        return self.account.address

    def parse_requirements(self, header: str) -> dict:
        """Parse the PAYMENT-REQUIRED header (raw JSON, NOT base64)."""
        return json.loads(header)

    def get_base_option(self, requirements: dict) -> dict:
        """Extract the Base network payment option."""
        for option in requirements["accepts"]:
            if option["network"] == f"eip155:{self.BASE_CHAIN_ID}":
                return option
        raise ValueError("No Base network payment option available")

    def sign_authorization(self, payment_option: dict) -> dict:
        """Sign EIP-3009 TransferWithAuthorization."""
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
                "chainId": self.BASE_CHAIN_ID,
                "verifyingContract": self.USDC_BASE,
            },
            "message": {
                "from": self.account.address,
                "to": payment_option["payTo"],
                "value": int(payment_option["amount"]),
                "validAfter": 0,
                "validBefore": valid_before,
                "nonce": nonce,
            },
        }

        signature = self.account.sign_message(encode_typed_data(full_message=typed_data))

        return {
            "signature": f"0x{signature.signature.hex()}",
            "valid_before": valid_before,
            "nonce": nonce,
        }

    def build_payment_header(
        self,
        payment_option: dict,
        auth: dict,
    ) -> str:
        """Build the PAYMENT-SIGNATURE header value."""
        # Spread all fields from 402 response — preserves extra, maxTimeoutSeconds, etc.
        payload = {
            "x402Version": 2,
            "accepted": {**payment_option},
            "payload": {
                "signature": auth["signature"],
                "authorization": {
                    "from": self.account.address,
                    "to": payment_option["payTo"],
                    "value": payment_option["amount"],
                    "validAfter": "0",
                    "validBefore": str(auth["valid_before"]),
                    "nonce": auth["nonce"],
                },
            },
        }

        return base64.b64encode(json.dumps(payload).encode()).decode()

    def create_payment(self, response: httpx.Response) -> str:
        """
        Create a payment header from a 402 response.

        Args:
            response: The 402 Payment Required response

        Returns:
            Base64-encoded payment header value
        """
        if response.status_code != 402:
            raise ValueError(f"Expected 402, got {response.status_code}")

        requirements = self.parse_requirements(response.headers["payment-required"])
        payment_option = self.get_base_option(requirements)

        price_usdc = int(payment_option["amount"]) / 1_000_000
        print(f"Payment required: ${price_usdc:.6f} USDC")

        auth = self.sign_authorization(payment_option)
        return self.build_payment_header(payment_option, auth)

    def create_topup_payment(self, response: httpx.Response, amount_usdc: float) -> str:
        """
        Create a top-up payment header for a custom amount.

        Args:
            response: A 402 response (used to get treasury address)
            amount_usdc: Amount to top up in USDC (e.g. 5.0)

        Returns:
            Base64-encoded payment header value
        """
        if response.status_code != 402:
            raise ValueError(f"Expected 402, got {response.status_code}")

        requirements = self.parse_requirements(response.headers["payment-required"])
        payment_option = self.get_base_option(requirements)

        # Override amount with desired top-up
        topup_option = {**payment_option, "amount": str(int(amount_usdc * 1_000_000))}

        auth = self.sign_authorization(topup_option)
        return self.build_payment_header(topup_option, auth)

    def refresh_auth_token(self, api_base: str) -> str:
        """Get a fresh balance auth token via EIP-191 signature."""
        timestamp = int(time.time())
        message = f"InferX balance auth {timestamp}"

        signature = self.account.sign_message(encode_defunct(text=message))

        resp = httpx.post(f"{api_base}/wallet/auth", json={
            "wallet": self.account.address,
            "message": message,
            "signature": f"0x{signature.signature.hex()}",
        })

        if resp.status_code != 200:
            raise ValueError(f"Auth failed ({resp.status_code}): {resp.text}")

        return resp.json()["balance_auth_token"]


# ── Example: Per-Request Inference ─────────────────────────────────
def example_per_request():
    payment = InferXPayment(os.getenv("WALLET_PRIVATE_KEY"))
    url = "https://ai-inferx.vercel.app/api/v1/chat/completions"

    body = {
        "model": "llama-3.3-70b",
        "messages": [{"role": "user", "content": "Explain quantum computing briefly"}],
        "max_completion_tokens": 512,
    }

    with httpx.Client(timeout=120) as client:
        # 1. Get price
        response = client.post(url, json=body)

        if response.status_code == 402:
            # 2. Create and attach payment
            payment_header = payment.create_payment(response)
            response = client.post(url, json=body,
                headers={"PAYMENT-SIGNATURE": payment_header})

        # 3. Use the result
        if response.status_code == 200:
            result = response.json()
            print(f"Response: {result['choices'][0]['message']['content']}")
            print(f"Cost: ${result['x_inferx']['payment_usdc']} USDC")


# ── Example: Prepaid Balance ───────────────────────────────────────
def example_prepaid():
    payment = InferXPayment(os.getenv("WALLET_PRIVATE_KEY"))
    api_base = "https://ai-inferx.vercel.app/api/v1"

    with httpx.Client(timeout=120) as client:
        # 1. Get treasury address from a 402 response
        resp = client.post(f"{api_base}/chat/completions", json={
            "model": "qwen3-4b",
            "messages": [{"role": "user", "content": "test"}],
            "max_completion_tokens": 1,
        })

        # 2. Top up $5 USDC
        topup_header = payment.create_topup_payment(resp, 5.0)
        resp = client.post(f"{api_base}/wallet/topup",
            headers={"PAYMENT-SIGNATURE": topup_header})

        result = resp.json()
        token = result["balance_auth_token"]
        print(f"Balance: ${result['balance_usdc']} USDC")

        # 3. Run inference with zero settlement overhead
        resp = client.post(f"{api_base}/chat/completions",
            json={
                "model": "llama-3.3-70b",
                "messages": [{"role": "user", "content": "Hello!"}],
                "max_completion_tokens": 512,
            },
            headers={"Authorization": f"Bearer {token}"})

        result = resp.json()
        print(f"Response: {result['choices'][0]['message']['content']}")
        print(f"Remaining: ${result['x_inferx']['balance_remaining_usdc']} USDC")


# ── Example: Token Refresh ─────────────────────────────────────────
def example_refresh():
    payment = InferXPayment(os.getenv("WALLET_PRIVATE_KEY"))
    api_base = "https://ai-inferx.vercel.app/api/v1"

    # Refresh without topping up (when token expires after 30 days)
    token = payment.refresh_auth_token(api_base)
    print(f"Fresh token: {token[:30]}...")
```

---

## Complete TypeScript Implementation

```typescript
import { Wallet } from "ethers";

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

class InferXPayment {
  private wallet: Wallet;

  constructor(privateKey: string) {
    this.wallet = new Wallet(privateKey);
  }

  get walletAddress(): string {
    return this.wallet.address;
  }

  parseRequirements(header: string): any {
    // PAYMENT-REQUIRED header is raw JSON — parse directly, do NOT base64-decode
    return JSON.parse(header);
  }

  getBaseOption(requirements: any): any {
    const option = requirements.accepts.find((o: any) => o.network === "eip155:8453");
    if (!option) throw new Error("No Base network payment option");
    return option;
  }

  async signAuthorization(paymentOption: any) {
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
      from: this.wallet.address,
      to: paymentOption.payTo,
      value: BigInt(paymentOption.amount),
      validAfter: 0n,
      validBefore: BigInt(validBefore),
      nonce,
    };

    const signature = await this.wallet.signTypedData(domain, types, message);

    return { signature, validBefore, nonce };
  }

  async createPayment(response: Response): Promise<string> {
    if (response.status !== 402) throw new Error(`Expected 402, got ${response.status}`);

    const requirements = this.parseRequirements(response.headers.get("payment-required")!);
    const option = this.getBaseOption(requirements);
    const auth = await this.signAuthorization(option);

    // Spread all fields from the 402 response — preserves extra, maxTimeoutSeconds, etc.
    const payload = {
      x402Version: 2,
      accepted: { ...option },
      payload: {
        signature: auth.signature,
        authorization: {
          from: this.wallet.address,
          to: option.payTo,
          value: option.amount,
          validAfter: "0",
          validBefore: String(auth.validBefore),
          nonce: auth.nonce,
        },
      },
    };

    return btoa(JSON.stringify(payload));
  }

  async createTopupPayment(response: Response, amountUsdc: number): Promise<string> {
    if (response.status !== 402) throw new Error(`Expected 402, got ${response.status}`);

    const requirements = this.parseRequirements(response.headers.get("payment-required")!);
    const option = this.getBaseOption(requirements);

    // Override amount with desired top-up
    const topupOption = { ...option, amount: String(Math.ceil(amountUsdc * 1_000_000)) };
    const auth = await this.signAuthorization(topupOption);

    const payload = {
      x402Version: 2,
      accepted: { ...topupOption },
      payload: {
        signature: auth.signature,
        authorization: {
          from: this.wallet.address,
          to: topupOption.payTo,
          value: topupOption.amount,
          validAfter: "0",
          validBefore: String(auth.validBefore),
          nonce: auth.nonce,
        },
      },
    };

    return btoa(JSON.stringify(payload));
  }

  async refreshAuthToken(apiBase: string): Promise<string> {
    const timestamp = Math.floor(Date.now() / 1000);
    const message = `InferX balance auth ${timestamp}`;

    const signature = await this.wallet.signMessage(message);

    const resp = await fetch(`${apiBase}/wallet/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        wallet: this.wallet.address,
        message,
        signature,
      }),
    });

    if (!resp.ok) throw new Error(`Auth failed (${resp.status}): ${await resp.text()}`);

    const result = await resp.json();
    return result.balance_auth_token;
  }
}

// ── Example: Per-Request Inference ────────────────────────────────
async function examplePerRequest() {
  const payment = new InferXPayment(process.env.WALLET_PRIVATE_KEY!);
  const url = "https://ai-inferx.vercel.app/api/v1/chat/completions";

  const body = {
    model: "llama-3.3-70b",
    messages: [{ role: "user", content: "Explain quantum computing briefly" }],
    max_completion_tokens: 512,
  };

  // 1. Get price (PAYMENT-REQUIRED header is raw JSON, NOT base64)
  let resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (resp.status === 402) {
    // 2. Sign and execute
    const paymentSig = await payment.createPayment(resp);
    resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "PAYMENT-SIGNATURE": paymentSig },
      body: JSON.stringify(body),
    });
  }

  const result = await resp.json();
  console.log(`Response: ${result.choices[0].message.content}`);
  console.log(`Cost: $${result.x_inferx.payment_usdc} USDC`);
}

// ── Example: Prepaid Balance ──────────────────────────────────────
async function examplePrepaid() {
  const payment = new InferXPayment(process.env.WALLET_PRIVATE_KEY!);
  const apiBase = "https://ai-inferx.vercel.app/api/v1";

  // 1. Get treasury address from a 402 response
  const priceResp = await fetch(`${apiBase}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "qwen3-4b",
      messages: [{ role: "user", content: "test" }],
      max_completion_tokens: 1,
    }),
  });

  // 2. Top up $5 USDC
  const topupSig = await payment.createTopupPayment(priceResp, 5.0);
  const topupResp = await fetch(`${apiBase}/wallet/topup`, {
    method: "POST",
    headers: { "PAYMENT-SIGNATURE": topupSig },
  });

  const topupResult = await topupResp.json();
  const token = topupResult.balance_auth_token;
  console.log(`Balance: $${topupResult.balance_usdc} USDC`);

  // 3. Run inference with zero settlement overhead
  const inferResp = await fetch(`${apiBase}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      model: "llama-3.3-70b",
      messages: [{ role: "user", content: "Hello!" }],
      max_completion_tokens: 512,
    }),
  });

  const result = await inferResp.json();
  console.log(`Response: ${result.choices[0].message.content}`);
  console.log(`Remaining: $${result.x_inferx.balance_remaining_usdc} USDC`);
}
```

---

## ⚠️ Critical Implementation Notes

These constraints are enforced server-side. Violating any of them will cause payment rejection:

### 1. PAYMENT-REQUIRED Header Format

The `PAYMENT-REQUIRED` header is **raw JSON** — parse it directly:

```python
# ✅ CORRECT
requirements = json.loads(response.headers["payment-required"])

# ❌ WRONG — will crash with decode error
requirements = json.loads(base64.b64decode(response.headers["payment-required"]))
```

### 2. Authorization Window (validBefore)

The server rejects `validBefore` timestamps more than **10 minutes** in the future:

```python
# ✅ CORRECT — 10 minutes (server max)
valid_before = int(time.time()) + 600

# ❌ WRONG — rejected with "Payment validBefore is too far in the future (max 10 minutes)"
valid_before = int(time.time()) + 14400  # 4 hours
valid_before = int(time.time()) + 3600   # 1 hour
```

### 3. Spread Payment Option Fields

Always spread all fields from the 402 response into your `accepted` object. The server may include `extra` fields (EIP-712 domain hints) and `maxTimeoutSeconds` that are needed for settlement:

```python
# ✅ CORRECT — spread all fields
payload = {"x402Version": 2, "accepted": {**payment_option}, ...}

# ❌ RISKY — manually cherry-picking may miss required fields
payload = {"x402Version": 2, "accepted": {"scheme": option["scheme"], ...}, ...}
```

### 4. Balance Auth Token Required for Exact Balance

The `GET /v1/wallet/balance` endpoint requires an `Authorization: Bearer` header to return numeric `balance_usdc`. Without it, only `has_balance: boolean` is returned:

```python
# ✅ Returns exact balance
resp = httpx.get(url, headers={"Authorization": f"Bearer {token}"})
# {"balance_usdc": 4.50, "has_balance": true, ...}

# ⚠️ Returns boolean only (privacy protection)
resp = httpx.get(url)
# {"has_balance": true}  — no balance_usdc field
```

---

## Security Considerations

### Nonce Uniqueness

Each authorization must have a unique nonce. Use random 32-byte values:

```python
nonce = "0x" + secrets.token_bytes(32).hex()
```

### Signature Verification

The server verifies:
1. Signature is valid for the typed data
2. `from` address matches the signer
3. Amount matches the required payment
4. `validBefore` is in the future but ≤ 10 minutes from now
5. Nonce has not been used before (7-day TTL in Redis)

### No Private Key Exposure

The private key never leaves your system. You only send:
- The signature (proves you authorized the transfer)
- The authorization parameters (what you authorized)

### Minimum Transaction Amount

The CDP facilitator rejects settlements below $0.001 USDC (1000 atomic units) with `authorization_value_too_low`. InferX enforces this floor automatically , all computed prices below $0.001 are rounded up.

### Token Persistence

The `balance_auth_token` is valid for **30 days**. Store it securely (e.g., environment variable, encrypted config) and reuse it across sessions. When it expires:
- Top up again (automatically issues a fresh token), OR
- Call `POST /v1/wallet/auth` with an EIP-191 signature to get a new token without topping up

---

## Error Handling

### Insufficient Balance

```json
{"detail": "Insufficient USDC balance"}
```
Fund your wallet with more USDC on Base.

### Invalid Signature

```json
{"detail": "Invalid payment signature"}
```
Check your signing implementation matches EIP-712 requirements.

### Expired Authorization

```json
{"detail": "Authorization expired"}
```
Create a new authorization with a `validBefore` ≤ 10 minutes in the future.

### validBefore Too Far in Future

```json
{"error": "Payment validBefore is too far in the future (max 10 minutes)"}
```
Set `validBefore` to `time.time() + 600` (10 minutes max).

### Nonce Already Used

```json
{"detail": "Nonce already used"}
```
Generate a fresh random nonce for each payment.

### Insufficient Prepaid Balance

```json
{"error": "Insufficient balance", "shortfall_usdc": 0.001}
```
Top up your prepaid balance or switch to per-request x402 payment.

### Auth Token Expired

```json
{"error": "Balance auth token expired", "code": "auth_token_expired"}
```
Refresh via `POST /v1/wallet/auth` or top up to get a new token.

---

## Resources

- **x402 Protocol:** [x402.org](https://x402.org)
- **EIP-3009:** [EIP-3009 Specification](https://eips.ethereum.org/EIPS/eip-3009)
- **EIP-712:** [EIP-712 Specification](https://eips.ethereum.org/EIPS/eip-712)
- **Base Network:** [base.org](https://base.org)
- **USDC on Base:** [Circle Documentation](https://developers.circle.com/stablecoins/docs)

---

## Quick Reference

| Item | Value |
|------|-------|
| Network | Base (chain ID: 8453) |
| Currency | USDC |
| USDC Contract | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| Decimals | 6 ($1.00 = 1,000,000) |
| Payment Header | `PAYMENT-SIGNATURE` (base64-encoded payload) |
| Balance Header | `Authorization: Bearer <balance_auth_token>` |
| Auth Type | EIP-3009 TransferWithAuthorization |
| Signature Type | EIP-712 Typed Data |
| Min Transaction | $0.001 USDC |
| Max validBefore | 10 minutes from now |
| Token Expiry | 30 days |
| Token Refresh | `POST /v1/wallet/auth` (EIP-191 signature) |
| PAYMENT-REQUIRED Format | Raw JSON (NOT base64) |

Happy paying! 💳
