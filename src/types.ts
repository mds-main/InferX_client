// ── InferX Client Types ──────────────────────────────────────────────────────

/** Chat message in OpenAI format */
export interface ChatMessage {
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool';
  content: string | ContentPart[];
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

/** Multimodal content part */
export interface ContentPart {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string };
}

/** Tool call from the model */
export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** JSON Schema response format */
export interface ResponseFormat {
  type: 'text' | 'json_object' | 'json_schema';
  json_schema?: {
    name: string;
    strict?: boolean;
    schema: Record<string, unknown>;
  };
}

/** OpenAI-compatible tool definition */
export interface Tool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

/** Venice-specific parameters (pass-through) */
export interface VeniceParameters {
  enable_web_search?: 'on' | 'off' | 'auto';
  enable_web_scraping?: boolean;
  enable_web_citations?: boolean;
  strip_thinking_response?: boolean;
  disable_thinking?: boolean;
  return_search_results_as_documents?: boolean;
  include_search_results_in_stream?: boolean;
}

/** Parameters for inference requests */
export interface InferParams {
  model: string;
  prompt: string;
  messages?: ChatMessage[];
  maxTokens?: number;
  stream?: boolean;
  task?: 'classify' | 'extract' | 'summarize' | 'analyze' | 'generate';
  responseFormat?: ResponseFormat;
  tools?: Tool[];
  toolChoice?: string | { type: 'function'; function: { name: string } };
  temperature?: number;
  veniceParameters?: VeniceParameters;
}

/** Result from an inference request */
export interface InferResult {
  content: string;
  model: string;
  finishReason: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  payment: {
    amountUsdc: string;
    source: 'x402' | 'balance';
    balanceRemaining?: number;
    tier: string;
    discountPct: number;
  };
  latencyMs: number;
  truncated: boolean;
  raw: unknown;
}

/** Result from a top-up request */
export interface TopUpResult {
  success: boolean;
  wallet: string;
  topupAmountUsdc: number;
  balanceUsdc: number;
  balanceAuthToken: string;
  tokenExpiresInDays: number;
}

/** Result from a balance check */
export interface BalanceResult {
  wallet: string;
  balanceUsdc?: number;
  hasBalance: boolean;
  totalTopups?: number;
  lastTopupAt?: string;
  createdAt?: string;
}

/** Model info from the models endpoint */
export interface Model {
  id: string;
  object: string;
  pricing: {
    inputPerMillion: string;
    outputPerMillion: string;
  };
}

// ── x402 Protocol Types ──────────────────────────────────────────────────────

/** Payment option from the 402 response */
export interface PaymentOption {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: { name: string; version: string };
  [key: string]: unknown; // Allow additional fields
}

/** Payment requirements from the PAYMENT-REQUIRED header */
export interface PaymentRequirements {
  x402Version: number;
  accepts: PaymentOption[];
}

/** EIP-3009 authorization parameters */
export interface TransferAuthorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}

/** x402 payment payload (base64-encoded as PAYMENT-SIGNATURE header) */
export interface PaymentPayload {
  x402Version: number;
  accepted: PaymentOption;
  payload: {
    signature: string;
    authorization: TransferAuthorization;
  };
}

/** InferX API error response */
export interface InferXError {
  error: string;
  code?: string;
  balance_credited_usdc?: number;
  balance_auth_token?: string;
  hint?: string;
  shortfall_usdc?: number;
  resets_at?: string;
  retry_after?: number;
}
