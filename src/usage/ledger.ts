/**
 * Usage ledger — append-only JSONL log of provider calls.
 *
 * Stored at ~/.structure/usage.log by default (a shared location so multiple
 * tools on the same box write one ledger). Each line is a single JSON record
 * with tokens, cache hits, and estimated USD cost. The `llm-gateway usage`
 * command reads and aggregates this file.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

export interface UsageRecord {
  timestamp: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  costUsd: number;
  source?: string;
  durationMs?: number;
}

export function ledgerPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  return path.join(home, '.structure', 'usage.log');
}

export async function appendUsage(record: UsageRecord): Promise<void> {
  const file = ledgerPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, JSON.stringify(record) + '\n', 'utf-8');
}

export async function readUsage(limit?: number): Promise<UsageRecord[]> {
  const file = ledgerPath();
  let content: string;
  try {
    content = await fs.readFile(file, 'utf-8');
  } catch {
    return [];
  }
  const lines = content.split('\n').filter((l) => l.trim().length > 0);
  const records: UsageRecord[] = [];
  for (const line of lines) {
    try {
      records.push(JSON.parse(line));
    } catch {
      // skip malformed line
    }
  }
  return typeof limit === 'number' ? records.slice(-limit) : records;
}

/** Per-model / per-provider rollup bucket, including cache read/write token totals. */
export interface UsageBucket {
  calls: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReads: number;
  cacheWrites: number;
}

export interface UsageSummary {
  totalCalls: number;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReads: number;
  totalCacheWrites: number;
  cacheHitRate: number;
  byModel: Record<string, UsageBucket>;
  byProvider: Record<string, UsageBucket>;
}

function emptyBucket(): UsageBucket {
  return {
    calls: 0,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReads: 0,
    cacheWrites: 0,
  };
}

function addToBucket(bucket: UsageBucket, r: UsageRecord): void {
  bucket.calls += 1;
  bucket.costUsd += r.costUsd;
  bucket.inputTokens += r.inputTokens;
  bucket.outputTokens += r.outputTokens;
  bucket.cacheReads += r.cacheReadInputTokens ?? 0;
  bucket.cacheWrites += r.cacheCreationInputTokens ?? 0;
}

export function summarize(records: UsageRecord[]): UsageSummary {
  const summary: UsageSummary = {
    totalCalls: records.length,
    totalCostUsd: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReads: 0,
    totalCacheWrites: 0,
    cacheHitRate: 0,
    byModel: {},
    byProvider: {},
  };

  for (const r of records) {
    summary.totalCostUsd += r.costUsd;
    summary.totalInputTokens += r.inputTokens;
    summary.totalOutputTokens += r.outputTokens;
    summary.totalCacheReads += r.cacheReadInputTokens ?? 0;
    summary.totalCacheWrites += r.cacheCreationInputTokens ?? 0;

    summary.byModel[r.model] ??= emptyBucket();
    addToBucket(summary.byModel[r.model], r);

    summary.byProvider[r.provider] ??= emptyBucket();
    addToBucket(summary.byProvider[r.provider], r);
  }

  const totalIn =
    summary.totalInputTokens + summary.totalCacheReads + summary.totalCacheWrites;
  summary.cacheHitRate = totalIn > 0 ? summary.totalCacheReads / totalIn : 0;
  return summary;
}

/**
 * Object wrapper around the append-only ledger.
 *
 * Defaults to the shared on-disk ledger at `~/.structure/usage.log` (resolved
 * lazily so a test can point `HOME`/`USERPROFILE` at a tmp dir), but accepts an
 * explicit path for isolated ledgers.
 */
export class UsageLedger {
  private readonly explicitPath?: string;

  constructor(filePath?: string) {
    this.explicitPath = filePath;
  }

  /** Effective on-disk path for this ledger. */
  get filePath(): string {
    return this.explicitPath ?? ledgerPath();
  }

  async append(record: UsageRecord): Promise<void> {
    const file = this.filePath;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, JSON.stringify(record) + '\n', 'utf-8');
  }

  async read(limit?: number): Promise<UsageRecord[]> {
    let content: string;
    try {
      content = await fs.readFile(this.filePath, 'utf-8');
    } catch {
      return [];
    }
    const records: UsageRecord[] = [];
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        // skip malformed line
      }
    }
    return typeof limit === 'number' ? records.slice(-limit) : records;
  }

  async summarize(limit?: number): Promise<UsageSummary> {
    return summarize(await this.read(limit));
  }
}
