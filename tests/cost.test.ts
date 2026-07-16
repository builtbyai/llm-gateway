/**
 * Public cost-model API tests — the ergonomic `computeCost` entry point,
 * the `UsageLedger` class, and the cache read/write rollups that separate
 * cache-creation from cache-read billing.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

import { computeCost } from '../src/anthropic/cache';
import { UsageLedger, summarize } from '../src/usage/ledger';
import type { UsageRecord } from '../src/usage/ledger';

describe('computeCost', () => {
  it('accepts a tier alias and prices a cache-read call at 0.1x input', () => {
    // 'advanced' -> claude-opus-4-7 ($5/MTok input, 0.1x read mult)
    const cost = computeCost(
      { inputTokens: 0, outputTokens: 100, cacheReadInputTokens: 1_000_000 },
      'advanced'
    );
    expect(cost).toBeCloseTo(0.5 + 0.0025, 4);
  });

  it('prices cache-creation 12.5x higher than cache-read for the same tokens', () => {
    const tokens = 1_000_000;
    const write = computeCost(
      { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: tokens },
      'claude-opus-4-7'
    );
    const read = computeCost(
      { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: tokens },
      'claude-opus-4-7'
    );
    // write mult 1.25 (5m) vs read mult 0.1 -> 12.5x
    expect(write / read).toBeCloseTo(12.5, 4);
  });

  it('throws on an unknown model', () => {
    expect(() =>
      computeCost({ inputTokens: 1, outputTokens: 1 }, 'not-a-real-model')
    ).toThrow(/Unknown model/);
  });
});

describe('UsageLedger class', () => {
  let tmpDir: string;
  let ledger: UsageLedger;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-gateway-ledger-'));
    ledger = new UsageLedger(path.join(tmpDir, 'usage.log'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('appends and reads back records at an explicit path', async () => {
    await ledger.append({
      timestamp: '2026-04-27T00:00:00Z',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      inputTokens: 200,
      outputTokens: 100,
      costUsd: 0.002,
      cacheCreationInputTokens: 4000,
    });
    const records = await ledger.read();
    expect(records).toHaveLength(1);
    expect(records[0].cacheCreationInputTokens).toBe(4000);
  });

  it('summarize() rolls cache read/write totals into byModel buckets', async () => {
    await ledger.append({
      timestamp: '2026-04-27T00:00:00Z',
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: 900,
      cacheCreationInputTokens: 300,
      costUsd: 0.5,
    });
    const sum = await ledger.summarize();
    expect(sum.byModel['claude-opus-4-7'].cacheReads).toBe(900);
    expect(sum.byModel['claude-opus-4-7'].cacheWrites).toBe(300);
    expect(sum.byProvider['anthropic'].cacheReads).toBe(900);
  });

  it('returns [] for a ledger file that does not exist', async () => {
    const missing = new UsageLedger(path.join(tmpDir, 'nope.log'));
    expect(await missing.read()).toEqual([]);
  });
});

describe('summarize cache rollups', () => {
  it('keeps cache-read and cache-write token totals separate', () => {
    const records: UsageRecord[] = [
      {
        timestamp: '2026-04-27T00:00:00Z',
        provider: 'anthropic',
        model: 'claude-haiku-4-5-20251001',
        inputTokens: 10,
        outputTokens: 5,
        cacheReadInputTokens: 1000,
        cacheCreationInputTokens: 200,
        costUsd: 0.01,
      },
    ];
    const sum = summarize(records);
    expect(sum.totalCacheReads).toBe(1000);
    expect(sum.totalCacheWrites).toBe(200);
    expect(sum.byModel['claude-haiku-4-5-20251001'].cacheReads).toBe(1000);
    expect(sum.byModel['claude-haiku-4-5-20251001'].cacheWrites).toBe(200);
  });
});
