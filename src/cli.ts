#!/usr/bin/env npx tsx
/**
 * InferX CLI — Command-line interface for InferX x402 AI inference
 */

import 'dotenv/config';
import { resolve } from 'node:path';
import { config } from 'dotenv';
import { Command } from 'commander';
import { InferXClient } from './client.js';
import type { ResponseFormat } from './types.js';

// Load .env.local (dotenv/config only loads .env)
config({ path: resolve(process.cwd(), '.env.local') });

// ── Helpers ──────────────────────────────────────────────────────────────────

function getClient(): InferXClient {
  const privateKey = process.env.WALLET_PRIVATE_KEY;
  if (!privateKey) {
    console.error('❌ WALLET_PRIVATE_KEY environment variable is required.');
    console.error('   Set it in .env.local or export it:');
    console.error('   export WALLET_PRIVATE_KEY=0x...');
    process.exit(1);
  }
  return new InferXClient(privateKey, {
    endpoint: process.env.INFERX_ENDPOINT,
  });
}

function printDivider(): void {
  console.log('─'.repeat(60));
}

// ── CLI Program ──────────────────────────────────────────────────────────────

const program = new Command();

program
  .name('inferx')
  .description('InferX CLI — x402 AI inference with USDC payments')
  .version('1.0.0');

// ── inferx models ────────────────────────────────────────────────────────────

program
  .command('models')
  .description('List available models with pricing')
  .action(async () => {
    try {
      const client = getClient();
      const models = await client.listModels();

      console.log('\n⚡ InferX — Available Models\n');
      printDivider();
      console.log(
        `${'Model'.padEnd(30)} ${'Input $/M'.padStart(12)} ${'Output $/M'.padStart(12)}`,
      );
      printDivider();

      for (const model of models) {
        console.log(
          `${model.id.padEnd(30)} ${'$' + model.pricing.inputPerMillion}${' '.padStart(12 - model.pricing.inputPerMillion.length - 1)} ${'$' + model.pricing.outputPerMillion}${' '.padStart(12 - model.pricing.outputPerMillion.length - 1)}`,
        );
      }

      printDivider();
      console.log(`\n${models.length} models available\n`);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

// ── inferx infer ─────────────────────────────────────────────────────────────

program
  .command('infer')
  .description('Run inference with per-request x402 payment')
  .requiredOption('-m, --model <model>', 'Model ID (e.g., llama-3.3-70b)')
  .requiredOption('-p, --prompt <prompt>', 'Prompt text')
  .option('-t, --max-tokens <tokens>', 'Max completion tokens', parseInt)
  .option('-s, --stream', 'Stream response tokens in real-time')
  .option('-d, --dry-run', 'Show price only, do not pay')
  .option('--temperature <temp>', 'Temperature (0-2)', parseFloat)
  .option('--task <task>', 'Task hint (classify, extract, summarize, analyze, generate)')
  .option('--response-format <json>', 'Response format (JSON string)')
  .action(async (opts) => {
    try {
      const client = getClient();

      // Dry-run: just discover the price
      if (opts.dryRun) {
        console.log('\n🔍 Dry run — fetching price without paying...\n');
        const body: Record<string, unknown> = {
          model: opts.model,
          messages: [{ role: 'user', content: opts.prompt }],
        };
        if (opts.maxTokens) body.max_completion_tokens = opts.maxTokens;
        if (opts.task) body.x_inferx = { task: opts.task };

        const resp = await fetch(
          `${process.env.INFERX_ENDPOINT ?? 'https://ai-inferx.vercel.app'}/api/v1/chat/completions`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          },
        );

        if (resp.status === 402) {
          const requirements = JSON.parse(
            resp.headers.get('payment-required')!,
          );
          const option = requirements.accepts.find(
            (o: Record<string, unknown>) => o.network === 'eip155:8453',
          );
          const price = Number(option.amount) / 1_000_000;
          console.log(`   Model:   ${opts.model}`);
          console.log(`   Price:   $${price.toFixed(6)} USDC`);
          console.log(`   Tokens:  ${opts.maxTokens ?? (opts.task ? `auto (${opts.task})` : 'default')}`);
          console.log(`   Wallet:  ${client.walletAddress}`);
          console.log('\n   Use without --dry-run to execute.\n');
        } else {
          const data = await resp.json() as Record<string, unknown>;
          console.error(`Unexpected response (${resp.status}):`, data);
        }
        return;
      }

      // Parse response format if provided
      let responseFormat: ResponseFormat | undefined;
      if (opts.responseFormat) {
        try {
          responseFormat = JSON.parse(opts.responseFormat) as ResponseFormat;
        } catch {
          console.error('❌ Invalid --response-format JSON');
          process.exit(1);
        }
      }

      const result = await client.infer({
        model: opts.model,
        prompt: opts.prompt,
        maxTokens: opts.maxTokens,
        stream: opts.stream,
        temperature: opts.temperature,
        task: opts.task,
        responseFormat,
      });

      if (!opts.stream) {
        console.log(`\n${result.content}\n`);
      }

      // Payment summary
      printDivider();
      console.log(`  Model:    ${result.model}`);
      console.log(`  Paid:     $${result.payment.amountUsdc} USDC (${result.payment.source})`);
      console.log(`  Tier:     ${result.payment.tier} (${result.payment.discountPct}% discount)`);
      console.log(`  Tokens:   ${result.usage.promptTokens} in / ${result.usage.completionTokens} out`);
      console.log(`  Latency:  ${result.latencyMs}ms`);
      if (result.truncated) console.log(`  ⚠️  Output was truncated (hit token limit)`);
      printDivider();
      console.log();
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

// ── inferx topup ─────────────────────────────────────────────────────────────

program
  .command('topup')
  .description('Top up prepaid balance with USDC')
  .requiredOption('-a, --amount <usdc>', 'Amount in USDC (e.g., 5.00)', parseFloat)
  .action(async (opts) => {
    try {
      const client = getClient();
      const result = await client.topUp(opts.amount);

      console.log('\n✅ Top-up successful!\n');
      printDivider();
      console.log(`  Wallet:      ${result.wallet}`);
      console.log(`  Topped up:   $${result.topupAmountUsdc.toFixed(2)} USDC`);
      console.log(`  Balance:     $${result.balanceUsdc.toFixed(6)} USDC`);
      console.log(`  Token saved: ~/.inferx/auth_token`);
      console.log(`  Expires in:  ${result.tokenExpiresInDays} days`);
      printDivider();
      console.log();
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

// ── inferx balance-infer ─────────────────────────────────────────────────────

program
  .command('balance-infer')
  .description('Run inference using prepaid balance')
  .requiredOption('-m, --model <model>', 'Model ID')
  .requiredOption('-p, --prompt <prompt>', 'Prompt text')
  .option('-t, --max-tokens <tokens>', 'Max completion tokens', parseInt)
  .option('-s, --stream', 'Stream response tokens in real-time')
  .option('--temperature <temp>', 'Temperature (0-2)', parseFloat)
  .option('--task <task>', 'Task hint')
  .action(async (opts) => {
    try {
      const client = getClient();

      const result = await client.inferWithBalance({
        model: opts.model,
        prompt: opts.prompt,
        maxTokens: opts.maxTokens,
        stream: opts.stream,
        temperature: opts.temperature,
        task: opts.task,
      });

      if (!opts.stream) {
        console.log(`\n${result.content}\n`);
      }

      printDivider();
      console.log(`  Model:     ${result.model}`);
      console.log(`  Paid:      $${result.payment.amountUsdc} USDC (balance)`);
      console.log(`  Remaining: $${result.payment.balanceRemaining?.toFixed(6) ?? 'unknown'} USDC`);
      console.log(`  Tokens:    ${result.usage.promptTokens} in / ${result.usage.completionTokens} out`);
      console.log(`  Latency:   ${result.latencyMs}ms`);
      printDivider();
      console.log();
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

// ── inferx balance ───────────────────────────────────────────────────────────

program
  .command('balance')
  .description('Check prepaid balance')
  .action(async () => {
    try {
      const client = getClient();
      const result = await client.getBalance();

      console.log('\n💰 Balance\n');
      printDivider();
      console.log(`  Wallet:       ${result.wallet}`);
      console.log(`  Has balance:  ${result.hasBalance}`);
      if (result.balanceUsdc != null) {
        console.log(`  Balance:      $${result.balanceUsdc.toFixed(6)} USDC`);
      } else {
        console.log(`  Balance:      (provide auth token for exact amount)`);
      }
      if (result.totalTopups != null) {
        console.log(`  Total topups: ${result.totalTopups}`);
      }
      if (result.lastTopupAt) {
        console.log(`  Last topup:   ${result.lastTopupAt}`);
      }
      printDivider();
      console.log();
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

// ── inferx refresh-token ─────────────────────────────────────────────────────

program
  .command('refresh-token')
  .description('Refresh balance auth token via EIP-191 signature')
  .action(async () => {
    try {
      const client = getClient();
      console.log('\n🔑 Refreshing auth token...\n');

      const token = await client.refreshAuthToken();

      printDivider();
      console.log(`  Token:  ${token.slice(0, 40)}...`);
      console.log(`  Saved:  ~/.inferx/auth_token`);
      console.log(`  Valid:  30 days`);
      printDivider();
      console.log();
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

// ── Run ──────────────────────────────────────────────────────────────────────

program.parse();
