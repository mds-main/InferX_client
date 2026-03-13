/**
 * x402 Payment Signing for InferX
 *
 * Implements EIP-3009 TransferWithAuthorization signing via viem
 * and EIP-191 personal_sign for auth token refresh.
 */

import {
  createWalletClient,
  http,
  type WalletClient,
  type Account,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import type {
  PaymentOption,
  PaymentRequirements,
  PaymentPayload,
} from './types.js';

// ── Constants ────────────────────────────────────────────────────────────────

/** USDC contract address on Base network */
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const;

/** EIP-712 domain for USDC on Base */
const USDC_EIP712_DOMAIN = {
  name: 'USD Coin',
  version: '2',
  chainId: 8453,
  verifyingContract: USDC_BASE,
} as const;

/** EIP-712 types for TransferWithAuthorization */
const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

/** Maximum authorization window (10 minutes) */
const MAX_VALID_BEFORE_SECONDS = 600;

// ── Payment Handler ──────────────────────────────────────────────────────────

export class InferXPayment {
  private account: Account;
  private walletClient: WalletClient;

  constructor(privateKey: string) {
    const key = (privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`) as Hex;
    this.account = privateKeyToAccount(key);
    this.walletClient = createWalletClient({
      account: this.account,
      chain: base,
      transport: http(),
    });
  }

  /** Get the wallet address */
  get walletAddress(): string {
    return this.account.address;
  }

  /**
   * Parse the PAYMENT-REQUIRED header.
   * ⚠️ The header is RAW JSON — NOT base64-encoded.
   */
  parseRequirements(header: string): PaymentRequirements {
    return JSON.parse(header) as PaymentRequirements;
  }

  /** Extract the Base network payment option from requirements */
  getBaseOption(requirements: PaymentRequirements): PaymentOption {
    const option = requirements.accepts.find(
      (o) => o.network === `eip155:${base.id}`,
    );
    if (!option) {
      throw new Error('No Base network payment option in 402 response');
    }
    return option;
  }

  /**
   * Sign an EIP-3009 TransferWithAuthorization.
   * Off-chain only — no gas fees, instant.
   */
  async signAuthorization(paymentOption: PaymentOption): Promise<{
    signature: Hex;
    validBefore: number;
    nonce: Hex;
  }> {
    const validBefore = Math.floor(Date.now() / 1000) + MAX_VALID_BEFORE_SECONDS;
    const nonce = generateNonce();

    const signature = await this.walletClient.signTypedData({
      account: this.account,
      domain: USDC_EIP712_DOMAIN,
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: 'TransferWithAuthorization',
      message: {
        from: this.account.address,
        to: paymentOption.payTo as Hex,
        value: BigInt(paymentOption.amount),
        validAfter: 0n,
        validBefore: BigInt(validBefore),
        nonce: nonce as Hex,
      },
    });

    return { signature, validBefore, nonce };
  }

  /**
   * Build the base64-encoded PAYMENT-SIGNATURE header value.
   * ⚠️ Spread ALL fields from the 402 payment option into `accepted`.
   */
  buildPaymentHeader(
    paymentOption: PaymentOption,
    auth: { signature: Hex; validBefore: number; nonce: Hex },
  ): string {
    const payload: PaymentPayload = {
      x402Version: 2,
      accepted: { ...paymentOption },
      payload: {
        signature: auth.signature,
        authorization: {
          from: this.account.address,
          to: paymentOption.payTo,
          value: paymentOption.amount,
          validAfter: '0',
          validBefore: String(auth.validBefore),
          nonce: auth.nonce,
        },
      },
    };

    return btoa(JSON.stringify(payload));
  }

  /**
   * Create a payment header from a 402 response.
   * Full flow: parse requirements → sign → build header.
   */
  async createPaymentFromResponse(response: Response): Promise<{
    paymentHeader: string;
    priceUsdc: number;
  }> {
    if (response.status !== 402) {
      throw new Error(`Expected 402 response, got ${response.status}`);
    }

    const headerValue = response.headers.get('payment-required');
    if (!headerValue) {
      throw new Error('Missing PAYMENT-REQUIRED header in 402 response');
    }

    const requirements = this.parseRequirements(headerValue);
    const option = this.getBaseOption(requirements);
    const priceUsdc = Number(option.amount) / 1_000_000;

    const auth = await this.signAuthorization(option);
    const paymentHeader = this.buildPaymentHeader(option, auth);

    return { paymentHeader, priceUsdc };
  }

  /**
   * Create a top-up payment header for a custom amount.
   * Uses the treasury address from a 402 response but overrides the amount.
   */
  async createTopupPayment(
    response: Response,
    amountUsdc: number,
  ): Promise<string> {
    if (response.status !== 402) {
      throw new Error(`Expected 402 response, got ${response.status}`);
    }

    const headerValue = response.headers.get('payment-required');
    if (!headerValue) {
      throw new Error('Missing PAYMENT-REQUIRED header in 402 response');
    }

    const requirements = this.parseRequirements(headerValue);
    const option = this.getBaseOption(requirements);

    // Override amount with desired top-up
    const topupOption: PaymentOption = {
      ...option,
      amount: String(Math.ceil(amountUsdc * 1_000_000)),
    };

    const auth = await this.signAuthorization(topupOption);
    return this.buildPaymentHeader(topupOption, auth);
  }

  /**
   * Sign an EIP-191 personal message for auth token refresh.
   * Message format: "InferX balance auth <unix_timestamp>"
   */
  async signAuthMessage(): Promise<{
    wallet: string;
    message: string;
    signature: Hex;
  }> {
    const timestamp = Math.floor(Date.now() / 1000);
    const message = `InferX balance auth ${timestamp}`;

    const signature = await this.walletClient.signMessage({
      account: this.account,
      message,
    });

    return {
      wallet: this.account.address,
      message,
      signature,
    };
  }
}

// ── Utilities ────────────────────────────────────────────────────────────────

/** Generate a random 32-byte nonce as 0x-prefixed hex */
function generateNonce(): Hex {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')}` as Hex;
}
