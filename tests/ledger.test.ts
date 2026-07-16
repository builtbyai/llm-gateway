/**
 * Usage ledger tests — uses an isolated tmp HOME so we don't pollute the real ledger.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

describe('usage ledger', () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'structure-ledger-'));
    process.env.HOME = tmpDir;
    process.env.USERPROFILE = tmpDir;
    jest.resetModules();
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    process.env.USERPROFILE = originalUserProfile;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('appends and reads back records', async () => {
    const { appendUsage, readUsage } = require('../src/usage/ledger');
    await appendUsage({
      timestamp: '2026-04-27T00:00:00Z',
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.001,
    });
    await appendUsage({
      timestamp: '2026-04-27T00:01:00Z',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      inputTokens: 200,
      outputTokens: 100,
      costUsd: 0.002,
      cacheReadInputTokens: 5000,
    });
    const records = await readUsage();
    expect(records).toHaveLength(2);
    expect(records[1].cacheReadInputTokens).toBe(5000);
  });

  it('summarize aggregates by model and computes cache hit rate', async () => {
    const { appendUsage, readUsage, summarize } = require('../src/usage/ledger');
    await appendUsage({
      timestamp: '2026-04-27T00:00:00Z',
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: 900,
      costUsd: 0.5,
    });
    const sum = summarize(await readUsage());
    expect(sum.totalCalls).toBe(1);
    expect(sum.byModel['claude-opus-4-7'].calls).toBe(1);
    expect(sum.byProvider['anthropic'].costUsd).toBeCloseTo(0.5, 4);
    expect(sum.cacheHitRate).toBeCloseTo(0.9, 2);
  });

  it('returns empty array when ledger does not exist', async () => {
    const { readUsage, summarize } = require('../src/usage/ledger');
    const records = await readUsage();
    expect(records).toEqual([]);
    expect(summarize(records).totalCalls).toBe(0);
  });
});
