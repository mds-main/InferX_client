/**
 * InferX Client — Reusable library for InferX API interactions
 *
 * Supports both per-request x402 payments and prepaid balance mode.
 * Handles streaming, auth token persistence, and automatic token refresh.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { InferXPayment } from './payment.js';
import type {
  InferParams,
  InferResult,
  TopUpResult,
  BalanceResult,
  Model,
  InferXError,
} from './types.js';

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_ENDPOINT = 'https://ai-inferx.vercel.app';
const TOKEN_DIR = join(homedir(), '.inferx');
const TOKEN_FILE = join(TOKEN_DIR, 'auth_token');
const REQUEST_TIMEOUT_MS = 120_000;

// ── Client ───────────────────────────────────────────────────────────────────

export class InferXClient {
  private payment: InferXPayment;
  private apiBase: string;
  private authToken: string | null;

  constructor(privateKey: string, options?: { endpoint?: string }) {
    this.payment = new InferXPayment(privateKey);
    const endpoint = options?.endpoint ?? DEFAULT_ENDPOINT;
    this.apiBase = `${endpoint}/api/v1`;

    // Load auth token: env var > file
    this.authToken =
      process.env.INFERX_AUTH_TOKEN ?? this.loadTokenFromFile();
  }

  /** Wallet address derived from private key */
  get walletAddress(): string {
    return this.payment.walletAddress;
  }

  // ── Per-Request x402 Inference ──────────────────────────────────────────

  /**
   * Run inference with per-request x402 payment.
   * Flow: send request → get 402 + price → sign EIP-3009 → re-send with payment.
   */
  async infer(params: InferParams): Promise<InferResult> {
    const body = this.buildRequestBody(params);
    const url = `${this.apiBase}/chat/completions`;
    const startTime = Date.now();

    if (params.stream) {
      return this.inferStreamX402(url, body, startTime);
    }

    // 1. Price discovery (no payment)
    const priceResp = await this.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (priceResp.status !== 402) {
      // Might be an error response
      return this.handleNon402Response(priceResp, startTime);
    }

    // 2. Sign and execute
    const { paymentHeader, priceUsdc } =
      await this.payment.createPaymentFromResponse(priceResp);
    this.log(`💰 Price: $${priceUsdc.toFixed(6)} USDC — signing payment...`);

    const resp = await this.fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'PAYMENT-SIGNATURE': paymentHeader,
      },
      body: JSON.stringify(body),
    });

    return this.parseInferResponse(resp, 'x402', startTime);
  }

  // ── Prepaid Balance Inference ───────────────────────────────────────────

  /**
   * Run inference using prepaid balance.
   * Requires a valid auth token from top-up or refresh.
   * Auto-refreshes on 401 (expired token).
   */
  async inferWithBalance(params: InferParams): Promise<InferResult> {
    const token = this.getAuthToken();
    const body = this.buildRequestBody(params);
    const url = `${this.apiBase}/chat/completions`;
    const startTime = Date.now();

    if (params.stream) {
      return this.inferStreamBalance(url, body, token, startTime);
    }

    let resp = await this.fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });

    // Auto-refresh on 401
    if (resp.status === 401) {
      this.log('🔄 Auth token expired, refreshing...');
      const newToken = await this.refreshAuthToken();
      resp = await this.fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${newToken}`,
        },
        body: JSON.stringify(body),
      });
    }

    return this.parseInferResponse(resp, 'balance', startTime);
  }

  // ── Top Up ──────────────────────────────────────────────────────────────

  /**
   * Top up prepaid balance via x402 payment.
   * 1. Get treasury address from a 402 response
   * 2. Sign for the desired top-up amount
   * 3. POST to /v1/wallet/topup
   */
  async topUp(amountUsdc: number): Promise<TopUpResult> {
    this.log(`💳 Topping up $${amountUsdc.toFixed(2)} USDC...`);

    // 1. Get treasury address from a dummy 402 response
    const priceResp = await this.fetch(
      `${this.apiBase}/chat/completions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'qwen3-4b',
          messages: [{ role: 'user', content: 'test' }],
          max_completion_tokens: 1,
        }),
      },
    );

    if (priceResp.status !== 402) {
      const errBody = await priceResp.text();
      throw new Error(
        `Expected 402 for price discovery, got ${priceResp.status}: ${errBody}`,
      );
    }

    // 2. Sign for top-up amount
    const paymentHeader = await this.payment.createTopupPayment(
      priceResp,
      amountUsdc,
    );

    // 3. Send to topup endpoint
    const resp = await this.fetch(`${this.apiBase}/wallet/topup`, {
      method: 'POST',
      headers: { 'PAYMENT-SIGNATURE': paymentHeader },
    });

    if (!resp.ok) {
      const errBody = await resp.json().catch(() => ({ error: resp.statusText })) as InferXError;
      throw new Error(
        `Top-up failed (${resp.status}): ${errBody.error ?? resp.statusText}`,
      );
    }

    const data = await resp.json() as Record<string, unknown>;

    const result: TopUpResult = {
      success: data.success as boolean,
      wallet: data.wallet as string,
      topupAmountUsdc: data.topup_amount_usdc as number,
      balanceUsdc: data.balance_usdc as number,
      balanceAuthToken: data.balance_auth_token as string,
      tokenExpiresInDays: data.token_expires_in_days as number,
    };

    // Persist the auth token
    this.authToken = result.balanceAuthToken;
    this.saveTokenToFile(result.balanceAuthToken);

    return result;
  }

  // ── Balance Check ───────────────────────────────────────────────────────

  /** Check prepaid balance. Requires auth token for exact amount. */
  async getBalance(): Promise<BalanceResult> {
    const headers: Record<string, string> = {};
    const token = this.authToken;
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const resp = await this.fetch(
      `${this.apiBase}/wallet/balance?wallet=${this.walletAddress}`,
      { headers },
    );

    if (!resp.ok) {
      const errBody = await resp.json().catch(() => ({ error: resp.statusText })) as InferXError;
      throw new Error(
        `Balance check failed (${resp.status}): ${errBody.error ?? resp.statusText}`,
      );
    }

    const data = await resp.json() as Record<string, unknown>;

    return {
      wallet: data.wallet as string,
      balanceUsdc: data.balance_usdc as number | undefined,
      hasBalance: data.has_balance as boolean,
      totalTopups: data.total_topups as number | undefined,
      lastTopupAt: data.last_topup_at as string | undefined,
      createdAt: data.created_at as string | undefined,
    };
  }

  // ── Auth Token Refresh ──────────────────────────────────────────────────

  /**
   * Refresh the balance auth token via EIP-191 personal signature.
   * No top-up needed — just proves wallet ownership.
   */
  async refreshAuthToken(): Promise<string> {
    const authData = await this.payment.signAuthMessage();

    const resp = await this.fetch(`${this.apiBase}/wallet/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(authData),
    });

    if (!resp.ok) {
      const errBody = await resp.text();
      throw new Error(`Auth refresh failed (${resp.status}): ${errBody}`);
    }

    const data = await resp.json() as Record<string, unknown>;
    const token = data.balance_auth_token as string;

    this.authToken = token;
    this.saveTokenToFile(token);

    return token;
  }

  // ── List Models ─────────────────────────────────────────────────────────

  /** List available models with pricing. Free — no payment required. */
  async listModels(): Promise<Model[]> {
    const resp = await this.fetch(`${this.apiBase}/models`);

    if (!resp.ok) {
      const errBody = await resp.text();
      throw new Error(`Models request failed (${resp.status}): ${errBody}`);
    }

    const data = await resp.json() as { data: Array<Record<string, unknown>> };

    return data.data.map((m) => ({
      id: m.id as string,
      object: m.object as string,
      pricing: {
        inputPerMillion: (m.pricing as Record<string, string>).input_per_million,
        outputPerMillion: (m.pricing as Record<string, string>).output_per_million,
      },
    }));
  }

  // ── Streaming ───────────────────────────────────────────────────────────

  /** Stream inference with x402 per-request payment */
  private async inferStreamX402(
    url: string,
    body: Record<string, unknown>,
    startTime: number,
  ): Promise<InferResult> {
    // 1. Price discovery
    const priceResp = await this.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, stream: false }),
    });

    if (priceResp.status !== 402) {
      return this.handleNon402Response(priceResp, startTime);
    }

    const { paymentHeader, priceUsdc } =
      await this.payment.createPaymentFromResponse(priceResp);
    this.log(`💰 Price: $${priceUsdc.toFixed(6)} USDC — signing payment...`);

    // 2. Stream with payment
    const resp = await this.fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'PAYMENT-SIGNATURE': paymentHeader,
      },
      body: JSON.stringify(body),
    });

    return this.processStream(resp, 'x402', startTime);
  }

  /** Stream inference with prepaid balance */
  private async inferStreamBalance(
    url: string,
    body: Record<string, unknown>,
    token: string,
    startTime: number,
  ): Promise<InferResult> {
    const resp = await this.fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });

    if (resp.status === 401) {
      this.log('🔄 Auth token expired, refreshing...');
      const newToken = await this.refreshAuthToken();
      const retryResp = await this.fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${newToken}`,
        },
        body: JSON.stringify(body),
      });
      return this.processStream(retryResp, 'balance', startTime);
    }

    return this.processStream(resp, 'balance', startTime);
  }

  /** Process an SSE stream response */
  private async processStream(
    resp: Response,
    source: 'x402' | 'balance',
    startTime: number,
  ): Promise<InferResult> {
    if (!resp.ok) {
      return this.parseInferResponse(resp, source, startTime);
    }

    const reader = resp.body?.getReader();
    if (!reader) throw new Error('No response body for streaming');

    const decoder = new TextDecoder();
    let fullContent = '';
    let lastMeta: Record<string, unknown> | null = null;
    let lastChunk: Record<string, unknown> | null = null;
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;

        try {
          const chunk = JSON.parse(data) as Record<string, unknown>;
          lastChunk = chunk;

          // Extract x_inferx metadata from the final chunk
          if (chunk.x_inferx) {
            lastMeta = chunk.x_inferx as Record<string, unknown>;
          }

          // Print tokens in real-time
          const choices = chunk.choices as Array<Record<string, unknown>> | undefined;
          if (choices?.[0]) {
            const delta = choices[0].delta as Record<string, unknown> | undefined;
            const content = delta?.content as string | undefined;
            if (content) {
              process.stdout.write(content);
              fullContent += content;
            }
          }
        } catch {
          // Skip malformed chunks
        }
      }
    }

    // Newline after streaming
    process.stdout.write('\n');

    const meta = lastMeta ?? {};
    const latencyMs = Date.now() - startTime;

    return {
      content: fullContent,
      model: (lastChunk?.model as string) ?? '',
      finishReason:
        ((lastChunk?.choices as Array<Record<string, unknown>>)?.[0]
          ?.finish_reason as string) ?? 'stop',
      usage: {
        promptTokens: (meta.prompt_tokens as number) ?? 0,
        completionTokens: (meta.completion_tokens as number) ?? 0,
        totalTokens: (meta.total_tokens as number) ?? 0,
      },
      payment: {
        amountUsdc: (meta.payment_usdc as string) ?? '0',
        source,
        balanceRemaining: meta.balance_remaining_usdc as number | undefined,
        tier: (meta.client_tier as string) ?? 'new',
        discountPct: (meta.discount_pct as number) ?? 0,
      },
      latencyMs,
      truncated: (meta.truncated as boolean) ?? false,
      raw: lastChunk,
    };
  }

  // ── Internals ───────────────────────────────────────────────────────────

  /** Build the request body for chat completions */
  private buildRequestBody(params: InferParams): Record<string, unknown> {
    const messages =
      params.messages ??
      [{ role: 'user' as const, content: params.prompt }];

    const body: Record<string, unknown> = {
      model: params.model,
      messages,
    };

    if (params.maxTokens != null) {
      body.max_completion_tokens = params.maxTokens;
    }
    if (params.stream != null) {
      body.stream = params.stream;
    }
    if (params.temperature != null) {
      body.temperature = params.temperature;
    }
    if (params.responseFormat != null) {
      body.response_format = params.responseFormat;
    }
    if (params.tools != null) {
      body.tools = params.tools;
    }
    if (params.toolChoice != null) {
      body.tool_choice = params.toolChoice;
    }
    if (params.task != null) {
      body.x_inferx = { task: params.task };
    }
    if (params.veniceParameters != null) {
      body.venice_parameters = params.veniceParameters;
    }

    return body;
  }

  /** Parse a successful inference response */
  private async parseInferResponse(
    resp: Response,
    source: 'x402' | 'balance',
    startTime: number,
  ): Promise<InferResult> {
    if (!resp.ok) {
      await this.handleErrorResponse(resp);
    }

    const data = await resp.json() as Record<string, unknown>;
    const choices = data.choices as Array<Record<string, unknown>>;
    const message = choices[0].message as Record<string, unknown>;
    const usage = data.usage as Record<string, number> | undefined;
    const meta = (data.x_inferx as Record<string, unknown>) ?? {};
    const latencyMs = Date.now() - startTime;

    return {
      content: (message.content as string) ?? '',
      model: data.model as string,
      finishReason: (choices[0].finish_reason as string) ?? 'stop',
      usage: {
        promptTokens: usage?.prompt_tokens ?? 0,
        completionTokens: usage?.completion_tokens ?? 0,
        totalTokens: usage?.total_tokens ?? 0,
      },
      payment: {
        amountUsdc: (meta.payment_usdc as string) ?? '0',
        source,
        balanceRemaining: meta.balance_remaining_usdc as number | undefined,
        tier: (meta.client_tier as string) ?? 'new',
        discountPct: (meta.discount_pct as number) ?? 0,
      },
      latencyMs,
      truncated: (meta.truncated as boolean) ?? false,
      raw: data,
    };
  }

  /** Handle non-402 responses during price discovery */
  private async handleNon402Response(
    resp: Response,
    startTime: number,
  ): Promise<InferResult> {
    if (resp.ok) {
      return this.parseInferResponse(resp, 'x402', startTime);
    }
    await this.handleErrorResponse(resp);
    throw new Error('Unreachable');
  }

  /** Parse and throw structured error responses */
  private async handleErrorResponse(resp: Response): Promise<never> {
    let errData: InferXError;
    try {
      errData = (await resp.json()) as InferXError;
    } catch {
      throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
    }

    const code = errData.code ?? '';
    const message = errData.error ?? resp.statusText;

    // Handle specific error codes with actionable messages
    switch (resp.status) {
      case 402:
        if (code === 'settlement_failed') {
          throw new Error(
            `💳 Settlement failed: ${message}\n` +
              `   Ensure your wallet has sufficient USDC on Base network.`,
          );
        }
        throw new Error(`💳 Payment error: ${message}`);

      case 401:
        throw new Error(
          `🔒 ${message}\n   Run: inferx refresh-token`,
        );

      case 429:
        throw new Error(
          `⏳ Rate limited (${code}): ${message}`,
        );

      case 502:
        if (code === 'inference_failed_credited' || code === 'streaming_failed_credited') {
          // Save credited token if provided
          if (errData.balance_auth_token) {
            this.authToken = errData.balance_auth_token;
            this.saveTokenToFile(errData.balance_auth_token);
          }
          throw new Error(
            `🔄 ${message}\n` +
              `   Credited: $${errData.balance_credited_usdc} USDC to prepaid balance.\n` +
              `   ${errData.hint ?? ''}`,
          );
        }
        throw new Error(`⚠️ Backend error (${code}): ${message}`);

      case 503:
        if (code === 'diem_exhausted') {
          throw new Error(
            `⏰ ${message}\n` +
              `   Resets at: ${errData.resets_at}\n` +
              `   Retry after: ${errData.retry_after}s`,
          );
        }
        throw new Error(`⚠️ Service unavailable (${code}): ${message}`);

      default:
        throw new Error(`❌ Error ${resp.status} (${code}): ${message}`);
    }
  }

  /** Fetch with timeout */
  private async fetch(url: string, init?: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      REQUEST_TIMEOUT_MS,
    );

    try {
      return await fetch(url, {
        ...init,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Get auth token or throw */
  private getAuthToken(): string {
    if (!this.authToken) {
      throw new Error(
        'No auth token available.\n' +
          'Run: inferx topup --amount <usdc>  or  inferx refresh-token',
      );
    }
    return this.authToken;
  }

  /** Load auth token from ~/.inferx/auth_token */
  private loadTokenFromFile(): string | null {
    try {
      if (existsSync(TOKEN_FILE)) {
        return readFileSync(TOKEN_FILE, 'utf-8').trim();
      }
    } catch {
      // Ignore read errors
    }
    return null;
  }

  /** Save auth token to ~/.inferx/auth_token */
  private saveTokenToFile(token: string): void {
    try {
      if (!existsSync(TOKEN_DIR)) {
        mkdirSync(TOKEN_DIR, { recursive: true });
      }
      writeFileSync(TOKEN_FILE, token, 'utf-8');
    } catch {
      // Non-fatal — token is still in memory
    }
  }

  /** Log to stderr (keeps stdout clean for piping) */
  private log(message: string): void {
    process.stderr.write(`${message}\n`);
  }
}
