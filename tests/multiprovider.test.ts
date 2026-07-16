/**
 * Multi-provider cost tests — proves the gateway prices Anthropic, OpenAI
 * (incl. cached input), and Ollama ($0 local), rolls a mixed-provider ledger
 * up correctly, and stamps reconstructable rate provenance on every record.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

import {
  PRICING_VERSION,
  OPENAI_MODELS,
} from '../src/config/providers';
import { computeCost, priceUsage } from '../src/anthropic/cache';
import {
  UsageLedger,
  buildUsageRecord,
} from '../src/usage/ledger';

describe('OpenAI cost', () => {
  it('prices fresh input + output at the pinned gpt-4o rates', () => {
    // gpt-4o: $2.50/MTok input, $10/MTok output
    const cost = computeCost(
      { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      'gpt-4o',
      { provider: 'openai' }
    );
    expect(cost).toBeCloseTo(2.5 + 10, 6);
  });

  it('bills cached input at the 0.5x discount (gpt-4o)', () => {
    // 1M cached-input tokens => $2.50 x 0.5 = $1.25
    const cost = computeCost(
      { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 1_000_000 },
      'gpt-4o',
      { provider: 'openai' }
    );
    expect(cost).toBeCloseTo(1.25, 6);
    expect(OPENAI_MODELS['gpt-4o'].cacheReadMultiplier).toBe(0.5);
  });

  it('bills cached input at the 0.25x discount for the 4.1 family', () => {
    // gpt-4.1: $2.00/MTok input, cached 0.25x => $0.50
    const cost = computeCost(
      { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 1_000_000 },
      'gpt-4.1',
      { provider: 'openai' }
    );
    expect(cost).toBeCloseTo(0.5, 6);
  });

  it('resolves a bare model id without an explicit provider', () => {
    // 'gpt-4o' is unambiguous across registries, so no provider hint is needed.
    const cost = computeCost(
      { inputTokens: 1_000_000, outputTokens: 0 },
      'gpt-4o'
    );
    expect(cost).toBeCloseTo(2.5, 6);
  });
});

describe('Ollama zero-cost', () => {
  it('prices any local model at $0', () => {
    const cost = computeCost(
      {
        inputTokens: 5_000_000,
        outputTokens: 5_000_000,
        cacheReadInputTokens: 1_000_000,
        cacheCreationInputTokens: 1_000_000,
      },
      'qwen2.5-coder:7b',
      { provider: 'ollama' }
    );
    expect(cost).toBe(0);
  });

  it('prices an unknown local model at $0 via a synthesized descriptor', () => {
    const cost = computeCost(
      { inputTokens: 9_999_999, outputTokens: 9_999_999 },
      'some-random-local-model:70b',
      { provider: 'ollama' }
    );
    expect(cost).toBe(0);
  });
});

describe('rate provenance (Defect B)', () => {
  it('priceUsage stamps the applied rates + pricing version', () => {
    const priced = priceUsage(
      { inputTokens: 1_000_000, outputTokens: 500_000, cacheReadInputTokens: 200_000 },
      'gpt-4o',
      { provider: 'openai' }
    );
    expect(priced.pricingVersion).toBe(PRICING_VERSION);
    expect(priced.inputCostPerMTok).toBe(2.5);
    expect(priced.outputCostPerMTok).toBe(10);
    expect(priced.cacheReadMultiplier).toBe(0.5);
    expect(priced.cacheWriteMultiplier).toBe(1);
  });

  it('records are independently reconstructable from stamped rates', () => {
    const rec = buildUsageRecord({
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      inputTokens: 12_345,
      outputTokens: 6_789,
      cacheReadInputTokens: 500_000,
      cacheCreationInputTokens: 40_000,
    });

    expect(rec.pricingVersion).toBe(PRICING_VERSION);
    expect(rec.inputCostPerMTok).toBe(5);
    expect(rec.outputCostPerMTok).toBe(25);

    // Recompute cost purely from the stamped rates + token counts — no registry.
    const recomputed =
      (rec.inputTokens / 1e6) * rec.inputCostPerMTok! +
      (rec.outputTokens / 1e6) * rec.outputCostPerMTok! +
      ((rec.cacheReadInputTokens ?? 0) / 1e6) *
        rec.inputCostPerMTok! *
        rec.cacheReadMultiplier! +
      ((rec.cacheCreationInputTokens ?? 0) / 1e6) *
        rec.inputCostPerMTok! *
        rec.cacheWriteMultiplier!;

    expect(recomputed).toBeCloseTo(rec.costUsd, 10);
  });
});

describe('mixed-provider ledger rollup', () => {
  let tmpDir: string;
  let ledger: UsageLedger;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-gateway-mixed-'));
    ledger = new UsageLedger(path.join(tmpDir, 'usage.log'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('prices + rolls up Anthropic, OpenAI, and Ollama calls together', async () => {
    // Anthropic Opus: 1M input => $5
    const anthropic = await ledger.record({
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      inputTokens: 1_000_000,
      outputTokens: 0,
    });
    // OpenAI gpt-4o: 1M input => $2.50
    const openai = await ledger.record({
      provider: 'openai',
      model: 'gpt-4o',
      inputTokens: 1_000_000,
      outputTokens: 0,
    });
    // Ollama: free
    const ollama = await ledger.record({
      provider: 'ollama',
      model: 'qwen2.5-coder:14b',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });

    expect(anthropic.costUsd).toBeCloseTo(5, 6);
    expect(openai.costUsd).toBeCloseTo(2.5, 6);
    expect(ollama.costUsd).toBe(0);

    const sum = await ledger.summarize();
    expect(sum.totalCalls).toBe(3);
    expect(sum.totalCostUsd).toBeCloseTo(7.5, 6);

    expect(sum.byProvider['anthropic'].costUsd).toBeCloseTo(5, 6);
    expect(sum.byProvider['openai'].costUsd).toBeCloseTo(2.5, 6);
    expect(sum.byProvider['ollama'].costUsd).toBe(0);
    expect(sum.byProvider['ollama'].calls).toBe(1);

    expect(sum.byModel['gpt-4o'].costUsd).toBeCloseTo(2.5, 6);
    expect(sum.byModel['claude-opus-4-8'].costUsd).toBeCloseTo(5, 6);
  });
});
