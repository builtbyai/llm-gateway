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

import {
  priceUsage,
  type CacheTTL,
  type CacheUsage,
} from '../anthropic/cache.js';
import type { ProviderName } from '../config/providers.js';

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

  // --- Rate provenance (stamped at compute time) -------------------------
  // These record the exact rates used to derive `costUsd`, so any historical
  // cost is reconstructable/verifiable long after the price table is refreshed.
  // Written by `buildUsageRecord` / `UsageLedger.record`; optional so older
  // ledger lines still parse.
  /** Pricing-table version (date string) in effect when this call was priced. */
  pricingVersion?: string;
  /** Base input rate applied, USD/MTok. */
  inputCostPerMTok?: number;
  /** Output rate applied, USD/MTok. */
  outputCostPerMTok?: number;
  /** Cache-read multiplier actually applied. */
  cacheReadMultiplier?: number;
  /** Cache-write multiplier actually applied for the record's TTL. */
  cacheWriteMultiplier?: number;
}

/** Input for a rate-stamped ledger write (cost + provenance are computed). */
export interface RecordUsageInput {
  provider: ProviderName;
  /** Canonical model id or tier alias understood by the provider's registry. */
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  /** Cache TTL tier for the write multiplier. Default '5m'. */
  ttl?: CacheTTL;
  /** ISO-8601 timestamp. Defaults to now. */
  timestamp?: string;
  source?: string;
  durationMs?: number;
}

/**
 * Build a fully rate-stamped `UsageRecord` from raw token counts.
 *
 * Prices the call via `priceUsage` and stamps `costUsd` together with the exact
 * rates and `pricingVersion` used — so the cost can be independently re-derived
 * later. Works for any provider (Anthropic / OpenAI / Ollama).
 */
export function buildUsageRecord(input: RecordUsageInput): UsageRecord {
  const usage: CacheUsage = {
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    cacheReadInputTokens: input.cacheReadInputTokens,
    cacheCreationInputTokens: input.cacheCreationInputTokens,
  };
  const priced = priceUsage(usage, input.model, {
    provider: input.provider,
    ttl: input.ttl ?? '5m',
  });

  return {
    timestamp: input.timestamp ?? new Date().toISOString(),
    provider: input.provider,
    model: input.model,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    cacheReadInputTokens: input.cacheReadInputTokens,
    cacheCreationInputTokens: input.cacheCreationInputTokens,
    costUsd: priced.costUsd,
    source: input.source,
    durationMs: input.durationMs,
    pricingVersion: priced.pricingVersion,
    inputCostPerMTok: priced.inputCostPerMTok,
    outputCostPerMTok: priced.outputCostPerMTok,
    cacheReadMultiplier: priced.cacheReadMultiplier,
    cacheWriteMultiplier: priced.cacheWriteMultiplier,
  };
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

  /**
   * Price a call from raw token counts and append the rate-stamped record.
   * Returns the record that was written (with `costUsd` + provenance filled in).
   */
  async record(input: RecordUsageInput): Promise<UsageRecord> {
    const rec = buildUsageRecord(input);
    await this.append(rec);
    return rec;
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
