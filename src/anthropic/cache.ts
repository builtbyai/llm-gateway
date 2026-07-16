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

import {
  findModelDescriptor,
  PRICING_VERSION,
  type ModelDescriptor,
  type ProviderName,
} from '../config/providers.js';

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

/** Options for the provider-agnostic cost entry points. */
export interface ComputeCostOptions {
  /**
   * Disambiguate a model id / tier alias to a provider. Shared tier aliases
   * (`'fast'`, `'advanced'`, …) exist for every provider; without this the
   * lookup defaults to Anthropic for aliases, then matches OpenAI/Ollama by id.
   */
  provider?: ProviderName;
  /** Cache TTL for the write-multiplier tier. Default '5m'. */
  ttl?: CacheTTL;
}

function normalizeOptions(
  ttlOrOptions: CacheTTL | ComputeCostOptions
): { provider?: ProviderName; ttl: CacheTTL } {
  if (typeof ttlOrOptions === 'string') return { ttl: ttlOrOptions };
  return { provider: ttlOrOptions.provider, ttl: ttlOrOptions.ttl ?? '5m' };
}

function resolveDescriptor(
  model: string | ModelDescriptor,
  provider?: ProviderName
): ModelDescriptor {
  const descriptor =
    typeof model === 'string' ? findModelDescriptor(model, provider) : model;
  if (!descriptor) {
    throw new Error(`Unknown model for cost lookup: ${String(model)}`);
  }
  return descriptor;
}

/**
 * Compute USD cost for a single call, for ANY provider.
 *
 * Ergonomic public entry point: accepts either a resolved `ModelDescriptor` or
 * a model id / tier alias (`'claude-opus-4-8'`, `'gpt-4o'`, `'advanced'`, …).
 * The third argument is a `CacheTTL` (`'5m'` | `'1h'`) or an options object
 * `{ provider?, ttl? }` — pass `{ provider: 'openai' }` to disambiguate a tier
 * alias, or `{ provider: 'ollama' }` for a $0 local call.
 *
 * The key property of this cost model is that cache-creation and cache-read
 * tokens are billed with *distinct* multipliers off the base input rate —
 * conflating them mis-prices a cache-heavy workload by 5–10×.
 */
export function computeCost(
  usage: CacheUsage,
  model: string | ModelDescriptor,
  ttlOrOptions: CacheTTL | ComputeCostOptions = '5m'
): number {
  const { provider, ttl } = normalizeOptions(ttlOrOptions);
  const descriptor = resolveDescriptor(model, provider);
  return estimateCost(descriptor, usage, ttl);
}

/**
 * The rate provenance stamped alongside a priced call, so any historical cost
 * is independently reconstructable: `costUsd` equals `estimateCost` recomputed
 * from these exact rates and the record's token counts.
 */
export interface PricedUsage {
  costUsd: number;
  pricingVersion: string;
  /** Base input rate applied, USD/MTok. */
  inputCostPerMTok: number;
  /** Output rate applied, USD/MTok. */
  outputCostPerMTok: number;
  /** Cache-read multiplier actually applied. */
  cacheReadMultiplier: number;
  /** Cache-write multiplier actually applied for the chosen TTL. */
  cacheWriteMultiplier: number;
}

/**
 * Price a single call AND return the exact rates used, for auditable ledgers.
 *
 * `computeCost` returns just the number; `priceUsage` additionally reports the
 * `inputCostPerMTok` / `outputCostPerMTok`, the cache multipliers that were
 * applied for the chosen TTL, and the `PRICING_VERSION`. Stamping these onto
 * the `UsageRecord` means a cost can be re-derived and verified years later,
 * even after the price table is refreshed.
 */
export function priceUsage(
  usage: CacheUsage,
  model: string | ModelDescriptor,
  ttlOrOptions: CacheTTL | ComputeCostOptions = '5m'
): PricedUsage {
  const { provider, ttl } = normalizeOptions(ttlOrOptions);
  const descriptor = resolveDescriptor(model, provider);

  const cacheWriteMultiplier =
    ttl === '1h'
      ? descriptor.cacheWriteMultiplier1h ?? 2
      : descriptor.cacheWriteMultiplier5min ?? 1.25;
  const cacheReadMultiplier = descriptor.cacheReadMultiplier ?? 0.1;

  return {
    costUsd: estimateCost(descriptor, usage, ttl),
    pricingVersion: PRICING_VERSION,
    inputCostPerMTok: descriptor.inputCostPerMTok,
    outputCostPerMTok: descriptor.outputCostPerMTok,
    cacheReadMultiplier,
    cacheWriteMultiplier,
  };
}

/** Cache hit ratio in [0, 1]. Returns 0 if no input tokens recorded. */
export function cacheHitRate(usage: CacheUsage): number {
  const reads = usage.cacheReadInputTokens ?? 0;
  const total = usage.inputTokens + reads + (usage.cacheCreationInputTokens ?? 0);
  if (total === 0) return 0;
  return reads / total;
}
