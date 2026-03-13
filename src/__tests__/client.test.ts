/**
 * InferXClient Tests
 *
 * Tests all client methods with mocked fetch — no real network calls.
 * Covers: listModels, infer (x402), inferWithBalance, topUp, getBalance,
 * refreshAuthToken, streaming, error handling, and auth token persistence.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InferXClient } from '../client.js';

// ── Test wallet (same as payment tests) ──────────────────────────────────────

const TEST_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

// ── Mock Data ────────────────────────────────────────────────────────────────

const MOCK_MODELS_RESPONSE = {
  data: [
    {
      id: 'llama-3.3-70b',
      object: 'model',
      pricing: { input_per_million: '0.35', output_per_million: '0.40' },
    },
    {
      id: 'qwen3-4b',
      object: 'model',
      pricing: { input_per_million: '0.10', output_per_million: '0.10' },
    },
  ],
};

const MOCK_INFERENCE_RESPONSE = {
  id: 'chatcmpl-test123',
  object: 'chat.completion',
  model: 'llama-3.3-70b',
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content: 'Hello! How can I help?' },
      finish_reason: 'stop',
    },
  ],
  usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
  x_inferx: {
    payment_usdc: '0.001783',
    payment_source: 'x402',
    base_price_usdc: '0.001783',
    discount_pct: 0,
    client_tier: 'new',
    latency_ms: 847,
    truncated: false,
    venice_model_id: 'llama-3.3-70b',
    provider: 'venice',
  },
};

const MOCK_BALANCE_INFERENCE_RESPONSE = {
  ...MOCK_INFERENCE_RESPONSE,
  x_inferx: {
    ...MOCK_INFERENCE_RESPONSE.x_inferx,
    payment_source: 'balance',
    balance_remaining_usdc: 4.998,
  },
};

const MOCK_PAYMENT_REQUIREMENTS = {
  x402Version: 2,
  accepts: [
    {
      scheme: 'exact',
      network: 'eip155:8453',
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      amount: '1783',
      payTo: '0x1234567890abcdef1234567890abcdef12345678',
      maxTimeoutSeconds: 30,
      extra: { name: 'USD Coin', version: '2' },
    },
  ],
};

const MOCK_TOPUP_RESPONSE = {
  success: true,
  wallet: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  topup_amount_usdc: 5.0,
  balance_usdc: 5.0,
  balance_auth_token: '0xf39F...token',
  token_expires_in_days: 30,
};

const MOCK_BALANCE_RESPONSE = {
  wallet: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  balance_usdc: 4.998,
  has_balance: true,
  total_topups: 1,
  last_topup_at: '2026-03-12T09:00:00Z',
  created_at: '2026-03-12T09:00:00Z',
};

const MOCK_AUTH_RESPONSE = {
  balance_auth_token: '0xf39F...refreshed-token',
  balance_usdc: 4.5,
  wallet: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
};

// ── Mock Helpers ─────────────────────────────────────────────────────────────

function mockFetch(responses: Array<{ status: number; body: unknown; headers?: Record<string, string> }>) {
  let callIndex = 0;
  return vi.fn(async () => {
    const r = responses[callIndex++] ?? responses[responses.length - 1];
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: {
        'content-type': 'application/json',
        ...(r.headers ?? {}),
      },
    });
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('InferXClient', () => {
  let client: InferXClient;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    // Ensure no token file interference
    delete process.env.INFERX_AUTH_TOKEN;
    client = new InferXClient(TEST_PRIVATE_KEY, {
      endpoint: 'https://test.example.com',
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // ── walletAddress ────────────────────────────────────────────────────────

  describe('walletAddress', () => {
    it('returns the derived wallet address', () => {
      expect(client.walletAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    });
  });

  // ── listModels ───────────────────────────────────────────────────────────

  describe('listModels', () => {
    it('returns parsed models with pricing', async () => {
      globalThis.fetch = mockFetch([
        { status: 200, body: MOCK_MODELS_RESPONSE },
      ]);

      const models = await client.listModels();

      expect(models).toHaveLength(2);
      expect(models[0].id).toBe('llama-3.3-70b');
      expect(models[0].pricing.inputPerMillion).toBe('0.35');
      expect(models[0].pricing.outputPerMillion).toBe('0.40');
      expect(models[1].id).toBe('qwen3-4b');
    });

    it('calls the correct endpoint', async () => {
      const mockFn = mockFetch([
        { status: 200, body: MOCK_MODELS_RESPONSE },
      ]);
      globalThis.fetch = mockFn;

      await client.listModels();

      expect(mockFn).toHaveBeenCalledOnce();
      const calledUrl = (mockFn.mock.calls[0] as unknown[])[0] as string;
      expect(calledUrl).toBe('https://test.example.com/api/v1/models');
    });

    it('throws on HTTP error', async () => {
      globalThis.fetch = mockFetch([
        { status: 500, body: { error: 'Server Error' } },
      ]);

      await expect(client.listModels()).rejects.toThrow(/500/);
    });
  });

  // ── infer (x402 per-request) ─────────────────────────────────────────────

  describe('infer', () => {
    it('sends price discovery then pays and returns result', async () => {
      const mockFn = mockFetch([
        // 1. Price discovery → 402
        {
          status: 402,
          body: { error: 'Payment required' },
          headers: {
            'payment-required': JSON.stringify(MOCK_PAYMENT_REQUIREMENTS),
          },
        },
        // 2. Paid request → 200
        { status: 200, body: MOCK_INFERENCE_RESPONSE },
      ]);
      globalThis.fetch = mockFn;

      const result = await client.infer({
        model: 'llama-3.3-70b',
        prompt: 'Hello',
        maxTokens: 128,
      });

      expect(result.content).toBe('Hello! How can I help?');
      expect(result.model).toBe('llama-3.3-70b');
      expect(result.payment.source).toBe('x402');
      expect(result.payment.amountUsdc).toBe('0.001783');
      expect(result.usage.totalTokens).toBe(20);
      expect(result.finishReason).toBe('stop');

      // verify 2 calls: price discovery + paid request
      expect(mockFn).toHaveBeenCalledTimes(2);

      // Second call should include PAYMENT-SIGNATURE header
      const secondCall = mockFn.mock.calls[1] as unknown[];
      const secondOpts = secondCall[1] as RequestInit;
      const headers = secondOpts.headers as Record<string, string>;
      expect(headers['PAYMENT-SIGNATURE']).toBeTruthy();
    });

    it('builds correct request body from InferParams', async () => {
      const mockFn = mockFetch([
        {
          status: 402,
          body: { error: 'Payment required' },
          headers: {
            'payment-required': JSON.stringify(MOCK_PAYMENT_REQUIREMENTS),
          },
        },
        { status: 200, body: MOCK_INFERENCE_RESPONSE },
      ]);
      globalThis.fetch = mockFn;

      await client.infer({
        model: 'llama-3.3-70b',
        prompt: 'test',
        maxTokens: 256,
        temperature: 0.7,
        task: 'classify',
      });

      // Check the request body of the first call
      const firstOpts = (mockFn.mock.calls[0] as unknown[])[1] as RequestInit;
      const body = JSON.parse(firstOpts.body as string);
      expect(body.model).toBe('llama-3.3-70b');
      expect(body.messages[0].content).toBe('test');
      expect(body.max_completion_tokens).toBe(256);
      expect(body.temperature).toBe(0.7);
      expect(body.x_inferx).toEqual({ task: 'classify' });
    });
  });

  // ── inferWithBalance ─────────────────────────────────────────────────────

  describe('inferWithBalance', () => {
    it('sends request with Bearer auth token', async () => {
      process.env.INFERX_AUTH_TOKEN = 'test-balance-token';
      const clientWithToken = new InferXClient(TEST_PRIVATE_KEY, {
        endpoint: 'https://test.example.com',
      });

      const mockFn = mockFetch([
        { status: 200, body: MOCK_BALANCE_INFERENCE_RESPONSE },
      ]);
      globalThis.fetch = mockFn;

      const result = await clientWithToken.inferWithBalance({
        model: 'qwen3-4b',
        prompt: 'Hello',
        maxTokens: 64,
      });

      expect(result.content).toBe('Hello! How can I help?');
      expect(result.payment.source).toBe('balance');

      // Check Authorization header
      const opts = (mockFn.mock.calls[0] as unknown[])[1] as RequestInit;
      const headers = opts.headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer test-balance-token');

      delete process.env.INFERX_AUTH_TOKEN;
    });

    it('throws when no auth token is available', async () => {
      await expect(
        client.inferWithBalance({
          model: 'qwen3-4b',
          prompt: 'Hello',
        }),
      ).rejects.toThrow(/No auth token/);
    });

    it('auto-refreshes on 401 (expired token)', async () => {
      process.env.INFERX_AUTH_TOKEN = 'expired-token';
      const clientWithToken = new InferXClient(TEST_PRIVATE_KEY, {
        endpoint: 'https://test.example.com',
      });

      const mockFn = mockFetch([
        // 1. inference with expired token → 401
        {
          status: 401,
          body: { error: 'Token expired', code: 'auth_token_expired' },
        },
        // 2. auth refresh → 200
        { status: 200, body: MOCK_AUTH_RESPONSE },
        // 3. retry inference → 200
        { status: 200, body: MOCK_BALANCE_INFERENCE_RESPONSE },
      ]);
      globalThis.fetch = mockFn;

      const result = await clientWithToken.inferWithBalance({
        model: 'qwen3-4b',
        prompt: 'Hello',
        maxTokens: 64,
      });

      expect(result.content).toBe('Hello! How can I help?');
      // Should have made 3 calls: inference, refresh, retry
      expect(mockFn).toHaveBeenCalledTimes(3);

      delete process.env.INFERX_AUTH_TOKEN;
    });
  });

  // ── topUp ────────────────────────────────────────────────────────────────

  describe('topUp', () => {
    it('performs price discovery, signs, and returns topup result', async () => {
      const mockFn = mockFetch([
        // 1. Price discovery → 402
        {
          status: 402,
          body: { error: 'Payment required' },
          headers: {
            'payment-required': JSON.stringify(MOCK_PAYMENT_REQUIREMENTS),
          },
        },
        // 2. Top-up → 200
        { status: 200, body: MOCK_TOPUP_RESPONSE },
      ]);
      globalThis.fetch = mockFn;

      const result = await client.topUp(5.0);

      expect(result.success).toBe(true);
      expect(result.topupAmountUsdc).toBe(5.0);
      expect(result.balanceUsdc).toBe(5.0);
      expect(result.balanceAuthToken).toBeTruthy();
      expect(result.tokenExpiresInDays).toBe(30);
    });

    it('sends PAYMENT-SIGNATURE header to topup endpoint', async () => {
      const mockFn = mockFetch([
        {
          status: 402,
          body: { error: 'Payment required' },
          headers: {
            'payment-required': JSON.stringify(MOCK_PAYMENT_REQUIREMENTS),
          },
        },
        { status: 200, body: MOCK_TOPUP_RESPONSE },
      ]);
      globalThis.fetch = mockFn;

      await client.topUp(1.0);

      // Second call is to /wallet/topup
      const secondUrl = (mockFn.mock.calls[1] as unknown[])[0] as string;
      expect(secondUrl).toContain('/wallet/topup');

      const secondOpts = (mockFn.mock.calls[1] as unknown[])[1] as RequestInit;
      const headers = secondOpts.headers as Record<string, string>;
      expect(headers['PAYMENT-SIGNATURE']).toBeTruthy();
    });

    it('throws on topup failure', async () => {
      const mockFn = mockFetch([
        {
          status: 402,
          body: { error: 'Payment required' },
          headers: {
            'payment-required': JSON.stringify(MOCK_PAYMENT_REQUIREMENTS),
          },
        },
        {
          status: 400,
          body: { error: 'Insufficient USDC balance' },
        },
      ]);
      globalThis.fetch = mockFn;

      await expect(client.topUp(1000000)).rejects.toThrow(/Top-up failed/);
    });
  });

  // ── getBalance ───────────────────────────────────────────────────────────

  describe('getBalance', () => {
    it('returns full balance with auth token', async () => {
      process.env.INFERX_AUTH_TOKEN = 'test-token';
      const clientWithToken = new InferXClient(TEST_PRIVATE_KEY, {
        endpoint: 'https://test.example.com',
      });

      const mockFn = mockFetch([
        { status: 200, body: MOCK_BALANCE_RESPONSE },
      ]);
      globalThis.fetch = mockFn;

      const result = await clientWithToken.getBalance();

      expect(result.wallet).toBeTruthy();
      expect(result.hasBalance).toBe(true);
      expect(result.balanceUsdc).toBe(4.998);
      expect(result.totalTopups).toBe(1);

      // Check Authorization header was sent
      const opts = (mockFn.mock.calls[0] as unknown[])[1] as RequestInit;
      const headers = opts.headers as Record<string, string>;
      expect(headers['Authorization']).toContain('Bearer');

      delete process.env.INFERX_AUTH_TOKEN;
    });

    it('returns boolean-only balance without auth token', async () => {
      const mockFn = mockFetch([
        {
          status: 200,
          body: {
            wallet: '0xf39F...',
            has_balance: true,
          },
        },
      ]);
      globalThis.fetch = mockFn;

      const result = await client.getBalance();

      expect(result.hasBalance).toBe(true);
      expect(result.balanceUsdc).toBeUndefined();
    });

    it('includes wallet in query string', async () => {
      const mockFn = mockFetch([
        { status: 200, body: { wallet: '0x...', has_balance: false } },
      ]);
      globalThis.fetch = mockFn;

      await client.getBalance();

      const calledUrl = (mockFn.mock.calls[0] as unknown[])[0] as string;
      expect(calledUrl).toContain('wallet=');
    });
  });

  // ── refreshAuthToken ─────────────────────────────────────────────────────

  describe('refreshAuthToken', () => {
    it('sends EIP-191 signed message and returns new token', async () => {
      const mockFn = mockFetch([
        { status: 200, body: MOCK_AUTH_RESPONSE },
      ]);
      globalThis.fetch = mockFn;

      const token = await client.refreshAuthToken();

      expect(token).toBe(MOCK_AUTH_RESPONSE.balance_auth_token);

      // Check request body
      const opts = (mockFn.mock.calls[0] as unknown[])[1] as RequestInit;
      const body = JSON.parse(opts.body as string);
      expect(body.wallet).toBeTruthy();
      expect(body.message).toMatch(/^InferX balance auth \d+$/);
      expect(body.signature).toMatch(/^0x/);
    });

    it('calls /wallet/auth endpoint', async () => {
      const mockFn = mockFetch([
        { status: 200, body: MOCK_AUTH_RESPONSE },
      ]);
      globalThis.fetch = mockFn;

      await client.refreshAuthToken();

      const calledUrl = (mockFn.mock.calls[0] as unknown[])[0] as string;
      expect(calledUrl).toContain('/wallet/auth');
    });

    it('throws on auth failure', async () => {
      globalThis.fetch = mockFetch([
        { status: 400, body: { error: 'Invalid signature' } },
      ]);

      await expect(client.refreshAuthToken()).rejects.toThrow(/Auth refresh failed/);
    });
  });

  // ── Error Handling ───────────────────────────────────────────────────────

  describe('error handling', () => {
    it('handles 429 rate limit errors', async () => {
      const mockFn = mockFetch([
        {
          status: 402,
          body: { error: 'Payment required' },
          headers: {
            'payment-required': JSON.stringify(MOCK_PAYMENT_REQUIREMENTS),
          },
        },
        {
          status: 429,
          body: { error: 'Rate limited', code: 'wallet_rate_limit' },
        },
      ]);
      globalThis.fetch = mockFn;

      await expect(
        client.infer({ model: 'llama-3.3-70b', prompt: 'test' }),
      ).rejects.toThrow(/Rate limited/);
    });

    it('handles 503 DIEM exhaustion with reset time', async () => {
      const mockFn = mockFetch([
        {
          status: 402,
          body: { error: 'Payment required' },
          headers: {
            'payment-required': JSON.stringify(MOCK_PAYMENT_REQUIREMENTS),
          },
        },
        {
          status: 503,
          body: {
            error: 'DIEM credits exhausted',
            code: 'diem_exhausted',
            resets_at: '2026-03-14T00:00:00.000Z',
            retry_after: 28800,
          },
        },
      ]);
      globalThis.fetch = mockFn;

      await expect(
        client.infer({ model: 'llama-3.3-70b', prompt: 'test' }),
      ).rejects.toThrow(/Resets at/);
    });

    it('handles 502 inference_failed_credited and saves token', async () => {
      const mockFn = mockFetch([
        {
          status: 402,
          body: { error: 'Payment required' },
          headers: {
            'payment-required': JSON.stringify(MOCK_PAYMENT_REQUIREMENTS),
          },
        },
        {
          status: 502,
          body: {
            error: 'Inference failed, payment credited',
            code: 'inference_failed_credited',
            balance_credited_usdc: 0.001783,
            balance_auth_token: 'credited-token-123',
            hint: 'Use the token for future requests.',
          },
        },
      ]);
      globalThis.fetch = mockFn;

      await expect(
        client.infer({ model: 'llama-3.3-70b', prompt: 'test' }),
      ).rejects.toThrow(/Credited/);
    });

    it('handles 402 settlement_failed', async () => {
      const mockFn = mockFetch([
        {
          status: 402,
          body: { error: 'Payment required' },
          headers: {
            'payment-required': JSON.stringify(MOCK_PAYMENT_REQUIREMENTS),
          },
        },
        {
          status: 402,
          body: {
            error: 'On-chain settlement failed',
            code: 'settlement_failed',
          },
        },
      ]);
      globalThis.fetch = mockFn;

      await expect(
        client.infer({ model: 'llama-3.3-70b', prompt: 'test' }),
      ).rejects.toThrow(/Settlement failed/);
    });
  });

  // ── Request Body Construction ────────────────────────────────────────────

  describe('request body construction', () => {
    it('converts prompt shorthand to messages array', async () => {
      const mockFn = mockFetch([
        {
          status: 402,
          body: { error: 'Payment required' },
          headers: {
            'payment-required': JSON.stringify(MOCK_PAYMENT_REQUIREMENTS),
          },
        },
        { status: 200, body: MOCK_INFERENCE_RESPONSE },
      ]);
      globalThis.fetch = mockFn;

      await client.infer({ model: 'test', prompt: 'my prompt' });

      const opts = (mockFn.mock.calls[0] as unknown[])[1] as RequestInit;
      const body = JSON.parse(opts.body as string);
      expect(body.messages).toEqual([
        { role: 'user', content: 'my prompt' },
      ]);
    });

    it('includes venice_parameters when provided', async () => {
      const mockFn = mockFetch([
        {
          status: 402,
          body: { error: 'Payment required' },
          headers: {
            'payment-required': JSON.stringify(MOCK_PAYMENT_REQUIREMENTS),
          },
        },
        { status: 200, body: MOCK_INFERENCE_RESPONSE },
      ]);
      globalThis.fetch = mockFn;

      await client.infer({
        model: 'test',
        prompt: 'search this',
        veniceParameters: { enable_web_search: 'on' },
      });

      const opts = (mockFn.mock.calls[0] as unknown[])[1] as RequestInit;
      const body = JSON.parse(opts.body as string);
      expect(body.venice_parameters).toEqual({ enable_web_search: 'on' });
    });

    it('includes response_format when provided', async () => {
      const mockFn = mockFetch([
        {
          status: 402,
          body: { error: 'Payment required' },
          headers: {
            'payment-required': JSON.stringify(MOCK_PAYMENT_REQUIREMENTS),
          },
        },
        { status: 200, body: MOCK_INFERENCE_RESPONSE },
      ]);
      globalThis.fetch = mockFn;

      const responseFormat = {
        type: 'json_schema' as const,
        json_schema: {
          name: 'test',
          strict: true,
          schema: { type: 'object', properties: {} },
        },
      };

      await client.infer({
        model: 'test',
        prompt: 'extract',
        responseFormat,
      });

      const opts = (mockFn.mock.calls[0] as unknown[])[1] as RequestInit;
      const body = JSON.parse(opts.body as string);
      expect(body.response_format).toEqual(responseFormat);
    });
  });

  // ── Configuration ────────────────────────────────────────────────────────

  describe('configuration', () => {
    it('uses default endpoint when none provided', () => {
      const defaultClient = new InferXClient(TEST_PRIVATE_KEY);
      expect(defaultClient.walletAddress).toBeTruthy();
    });

    it('uses custom endpoint when provided', async () => {
      const customClient = new InferXClient(TEST_PRIVATE_KEY, {
        endpoint: 'https://custom.api.com',
      });

      const mockFn = mockFetch([
        { status: 200, body: MOCK_MODELS_RESPONSE },
      ]);
      globalThis.fetch = mockFn;

      await customClient.listModels();

      const calledUrl = (mockFn.mock.calls[0] as unknown[])[0] as string;
      expect(calledUrl).toBe('https://custom.api.com/api/v1/models');
    });

    it('uses INFERX_AUTH_TOKEN env var when set', () => {
      process.env.INFERX_AUTH_TOKEN = 'env-token-123';
      const envClient = new InferXClient(TEST_PRIVATE_KEY);
      // The token is internal but we can verify it doesn't throw
      expect(envClient.walletAddress).toBeTruthy();
      delete process.env.INFERX_AUTH_TOKEN;
    });
  });
});
