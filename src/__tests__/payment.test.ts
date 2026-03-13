/**
 * Payment Module Tests
 *
 * Tests EIP-3009 signing, EIP-191 auth, payment header construction,
 * and PAYMENT-REQUIRED header parsing — all without network calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InferXPayment } from '../payment.js';
import type { PaymentRequirements } from '../types.js';

// ── Test wallet (DO NOT use this key for real funds) ─────────────────────────

/** Deterministic test private key — never holds real assets */
const TEST_PRIVATE_KEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const TEST_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

// ── Mock 402 Response ────────────────────────────────────────────────────────

const MOCK_PAYMENT_REQUIREMENTS: PaymentRequirements = {
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

function create402Response(requirements?: PaymentRequirements): Response {
  const reqs = requirements ?? MOCK_PAYMENT_REQUIREMENTS;
  return new Response(JSON.stringify({ error: 'Payment required' }), {
    status: 402,
    headers: {
      'payment-required': JSON.stringify(reqs),
      'content-type': 'application/json',
    },
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('InferXPayment', () => {
  let payment: InferXPayment;

  beforeEach(() => {
    payment = new InferXPayment(TEST_PRIVATE_KEY);
  });

  // ── Constructor ──────────────────────────────────────────────────────────

  describe('constructor', () => {
    it('derives correct wallet address from private key', () => {
      expect(payment.walletAddress.toLowerCase()).toBe(
        TEST_ADDRESS.toLowerCase(),
      );
    });

    it('accepts key without 0x prefix', () => {
      const keyWithoutPrefix = TEST_PRIVATE_KEY.slice(2);
      const p = new InferXPayment(keyWithoutPrefix);
      expect(p.walletAddress.toLowerCase()).toBe(TEST_ADDRESS.toLowerCase());
    });

    it('throws on invalid private key', () => {
      expect(() => new InferXPayment('invalid')).toThrow();
    });

    it('throws on empty private key', () => {
      expect(() => new InferXPayment('')).toThrow();
    });
  });

  // ── parseRequirements ────────────────────────────────────────────────────

  describe('parseRequirements', () => {
    it('parses raw JSON PAYMENT-REQUIRED header correctly', () => {
      const raw = JSON.stringify(MOCK_PAYMENT_REQUIREMENTS);
      const parsed = payment.parseRequirements(raw);

      expect(parsed.x402Version).toBe(2);
      expect(parsed.accepts).toHaveLength(1);
      expect(parsed.accepts[0].network).toBe('eip155:8453');
      expect(parsed.accepts[0].amount).toBe('1783');
    });

    it('throws on invalid JSON', () => {
      expect(() => payment.parseRequirements('not-json')).toThrow();
    });

    it('does NOT base64-decode the header (critical protocol detail)', () => {
      const raw = JSON.stringify(MOCK_PAYMENT_REQUIREMENTS);
      const b64 = btoa(raw);
      // base64 of valid JSON is NOT valid JSON — must throw
      expect(() => payment.parseRequirements(b64)).toThrow();
    });
  });

  // ── getBaseOption ────────────────────────────────────────────────────────

  describe('getBaseOption', () => {
    it('extracts the Base network payment option', () => {
      const option = payment.getBaseOption(MOCK_PAYMENT_REQUIREMENTS);
      expect(option.network).toBe('eip155:8453');
      expect(option.payTo).toBeTruthy();
    });

    it('throws when no Base network option available', () => {
      const requirements: PaymentRequirements = {
        x402Version: 2,
        accepts: [
          {
            scheme: 'exact',
            network: 'eip155:1', // Ethereum mainnet, not Base
            asset: '0x...',
            amount: '1000',
            payTo: '0x...',
            maxTimeoutSeconds: 30,
          },
        ],
      };
      expect(() => payment.getBaseOption(requirements)).toThrow(
        /No Base network/,
      );
    });
  });

  // ── signAuthorization ────────────────────────────────────────────────────

  describe('signAuthorization', () => {
    it('returns valid EIP-3009 signature, validBefore, and nonce', async () => {
      const option = MOCK_PAYMENT_REQUIREMENTS.accepts[0];
      const auth = await payment.signAuthorization(option);

      // Signature must be 0x-prefixed hex (65 bytes = 130 hex chars + 0x)
      expect(auth.signature).toMatch(/^0x[0-9a-f]{130}$/i);

      // validBefore should be ~10 minutes from now
      const now = Math.floor(Date.now() / 1000);
      expect(auth.validBefore).toBeGreaterThan(now);
      expect(auth.validBefore).toBeLessThanOrEqual(now + 600 + 5);

      // Nonce must be 32-byte hex
      expect(auth.nonce).toMatch(/^0x[0-9a-f]{64}$/i);
    });

    it('produces unique nonces across multiple calls', async () => {
      const option = MOCK_PAYMENT_REQUIREMENTS.accepts[0];
      const auth1 = await payment.signAuthorization(option);
      const auth2 = await payment.signAuthorization(option);

      expect(auth1.nonce).not.toBe(auth2.nonce);
    });

    it('produces unique signatures for different amounts', async () => {
      const option1 = { ...MOCK_PAYMENT_REQUIREMENTS.accepts[0] };
      const option2 = { ...MOCK_PAYMENT_REQUIREMENTS.accepts[0], amount: '5000' };

      const auth1 = await payment.signAuthorization(option1);
      const auth2 = await payment.signAuthorization(option2);

      expect(auth1.signature).not.toBe(auth2.signature);
    });
  });

  // ── buildPaymentHeader ───────────────────────────────────────────────────

  describe('buildPaymentHeader', () => {
    it('returns base64-encoded JSON payload', async () => {
      const option = MOCK_PAYMENT_REQUIREMENTS.accepts[0];
      const auth = await payment.signAuthorization(option);
      const header = payment.buildPaymentHeader(option, auth);

      // Must be valid base64
      const decoded = JSON.parse(atob(header));
      expect(decoded.x402Version).toBe(2);
    });

    it('spreads ALL fields from payment option into accepted', async () => {
      const option = MOCK_PAYMENT_REQUIREMENTS.accepts[0];
      const auth = await payment.signAuthorization(option);
      const header = payment.buildPaymentHeader(option, auth);
      const decoded = JSON.parse(atob(header));

      // Verify extra fields are spread (not cherry-picked)
      expect(decoded.accepted.extra).toEqual({ name: 'USD Coin', version: '2' });
      expect(decoded.accepted.maxTimeoutSeconds).toBe(30);
      expect(decoded.accepted.scheme).toBe('exact');
      expect(decoded.accepted.network).toBe('eip155:8453');
    });

    it('includes correct authorization structure', async () => {
      const option = MOCK_PAYMENT_REQUIREMENTS.accepts[0];
      const auth = await payment.signAuthorization(option);
      const header = payment.buildPaymentHeader(option, auth);
      const decoded = JSON.parse(atob(header));

      expect(decoded.payload.signature).toBe(auth.signature);
      expect(decoded.payload.authorization.from.toLowerCase()).toBe(
        TEST_ADDRESS.toLowerCase(),
      );
      expect(decoded.payload.authorization.to).toBe(option.payTo);
      expect(decoded.payload.authorization.value).toBe(option.amount);
      expect(decoded.payload.authorization.validAfter).toBe('0');
      expect(decoded.payload.authorization.validBefore).toBe(
        String(auth.validBefore),
      );
      expect(decoded.payload.authorization.nonce).toBe(auth.nonce);
    });
  });

  // ── createPaymentFromResponse ────────────────────────────────────────────

  describe('createPaymentFromResponse', () => {
    it('creates a payment header from a 402 response', async () => {
      const resp = create402Response();
      const { paymentHeader, priceUsdc } =
        await payment.createPaymentFromResponse(resp);

      expect(paymentHeader).toBeTruthy();
      expect(priceUsdc).toBeCloseTo(0.001783, 6);
    });

    it('throws on non-402 response', async () => {
      const resp = new Response('OK', { status: 200 });
      await expect(payment.createPaymentFromResponse(resp)).rejects.toThrow(
        /Expected 402/,
      );
    });

    it('throws on 402 without PAYMENT-REQUIRED header', async () => {
      const resp = new Response('error', { status: 402 });
      await expect(payment.createPaymentFromResponse(resp)).rejects.toThrow(
        /Missing PAYMENT-REQUIRED/,
      );
    });
  });

  // ── createTopupPayment ───────────────────────────────────────────────────

  describe('createTopupPayment', () => {
    it('overrides amount with desired top-up value', async () => {
      const resp = create402Response();
      const header = await payment.createTopupPayment(resp, 5.0);

      const decoded = JSON.parse(atob(header));
      // 5.0 USDC = 5000000 atomic units
      expect(decoded.accepted.amount).toBe('5000000');
      expect(decoded.payload.authorization.value).toBe('5000000');
    });

    it('rounds up fractional atomic amounts', async () => {
      const resp = create402Response();
      const header = await payment.createTopupPayment(resp, 0.0001);

      const decoded = JSON.parse(atob(header));
      // Math.ceil(0.0001 * 1_000_000) = 1
      expect(Number(decoded.accepted.amount)).toBeGreaterThan(0);
    });

    it('preserves treasury address from 402 response', async () => {
      const resp = create402Response();
      const header = await payment.createTopupPayment(resp, 1.0);

      const decoded = JSON.parse(atob(header));
      expect(decoded.accepted.payTo).toBe(
        MOCK_PAYMENT_REQUIREMENTS.accepts[0].payTo,
      );
    });
  });

  // ── signAuthMessage ──────────────────────────────────────────────────────

  describe('signAuthMessage', () => {
    it('returns EIP-191 signed message with correct format', async () => {
      const result = await payment.signAuthMessage();

      expect(result.wallet.toLowerCase()).toBe(TEST_ADDRESS.toLowerCase());
      expect(result.message).toMatch(/^InferX balance auth \d+$/);
      expect(result.signature).toMatch(/^0x[0-9a-f]+$/i);
    });

    it('uses current unix timestamp', async () => {
      const before = Math.floor(Date.now() / 1000);
      const result = await payment.signAuthMessage();
      const after = Math.floor(Date.now() / 1000);

      const timestamp = parseInt(result.message.split(' ').pop()!, 10);
      expect(timestamp).toBeGreaterThanOrEqual(before);
      expect(timestamp).toBeLessThanOrEqual(after);
    });
  });
});
