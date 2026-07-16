/**
 * Anthropic prompt caching helpers.
 *
 * Adds `cache_control: { type: "ephemeral" }` markers to stable parts of the
 * request (system prompt + skill block + tool definitions) so repeat calls in
 * the same workspace are billed at 0.1× input rate.
 *
 * Workspace-isolated since 2026-02-05. Cache write 1.25× (5min) / 2× (1h),
 * cache read 0.1×.
 *
 * See: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
 */

import { getModelDescriptor, type ModelDescriptor } from '../config/providers.js';

export type CacheTTL = '5m' | '1h';

export interface TextBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral'; ttl?: CacheTTL };
}

export interface CachedSystemInput {
  /** The long, stable system instructions. */
  system: string;
  /** Optional resolved skill body (also stable across a session). */
  skillBlock?: string;
  /** Optional cache TTL — default 5m (cheaper write). */
  ttl?: CacheTTL;
}

/**
 * Build the `system` array for messages.create() with cache markers on the
 * stable blocks. The user message is intentionally NOT cached (varies per call).
 */
export function buildCachedSystem(input: CachedSystemInput): TextBlock[] {
  const blocks: TextBlock[] = [];
  const ttl = input.ttl ?? '5m';

  if (input.system?.length) {
    blocks.push({
      type: 'text',
      text: input.system,
      cache_control: { type: 'ephemeral', ttl },
    });
  }

  if (input.skillBlock?.length) {
    blocks.push({
      type: 'text',
      text: input.skillBlock,
      cache_control: { type: 'ephemeral', ttl },
    });
  }

  return blocks;
}

export interface CacheUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

/**
 * Estimate USD cost for a single response, given a model descriptor and
 * the usage block returned by the Anthropic API.
 */
export function estimateCost(model: ModelDescriptor, usage: CacheUsage, ttl: CacheTTL = '5m'): number {
  const writeMult =
    ttl === '1h'
      ? model.cacheWriteMultiplier1h ?? 2
      : model.cacheWriteMultiplier5min ?? 1.25;
  const readMult = model.cacheReadMultiplier ?? 0.1;

  const baseInput = (usage.inputTokens / 1_000_000) * model.inputCostPerMTok;
  const cacheWrite =
    ((usage.cacheCreationInputTokens ?? 0) / 1_000_000) *
    model.inputCostPerMTok *
    writeMult;
  const cacheRead =
    ((usage.cacheReadInputTokens ?? 0) / 1_000_000) *
    model.inputCostPerMTok *
    readMult;
  const output = (usage.outputTokens / 1_000_000) * model.outputCostPerMTok;

  return baseInput + cacheWrite + cacheRead + output;
}

/**
 * Compute USD cost for a single call.
 *
 * Ergonomic public entry point: accepts either a resolved `ModelDescriptor` or
 * a model id / tier alias (`'claude-opus-4-7'`, `'advanced'`, `'sonnet'`, …).
 * The key property of this cost model is that cache-creation and cache-read
 * tokens are billed with *distinct* multipliers off the base input rate —
 * conflating them mis-prices a cache-heavy workload by 5–10×.
 */
export function computeCost(
  usage: CacheUsage,
  model: string | ModelDescriptor,
  ttl: CacheTTL = '5m'
): number {
  const descriptor =
    typeof model === 'string' ? getModelDescriptor('anthropic', model) : model;
  if (!descriptor) {
    throw new Error(`Unknown model for cost lookup: ${String(model)}`);
  }
  return estimateCost(descriptor, usage, ttl);
}

/** Cache hit ratio in [0, 1]. Returns 0 if no input tokens recorded. */
export function cacheHitRate(usage: CacheUsage): number {
  const reads = usage.cacheReadInputTokens ?? 0;
  const total = usage.inputTokens + reads + (usage.cacheCreationInputTokens ?? 0);
  if (total === 0) return 0;
  return reads / total;
}
