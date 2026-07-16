/**
 * llm-gateway — per-model, cache-aware LLM cost attribution with an
 * append-only usage ledger.
 *
 * Public API. Import what you need:
 *
 *   import { computeCost, UsageLedger, PROVIDERS, summarize } from 'llm-gateway';
 */

// --- Cost model ---------------------------------------------------------
export {
  computeCost,
  estimateCost,
  cacheHitRate,
  buildCachedSystem,
} from './anthropic/cache.js';
export type {
  CacheTTL,
  CacheUsage,
  CachedSystemInput,
  TextBlock,
} from './anthropic/cache.js';

// --- Pricing / model registry / providers ------------------------------
export {
  PROVIDERS,
  ANTHROPIC_MODELS,
  resolveModel,
  resolveAnthropicModelId,
  getModelDescriptor,
  getProvider,
  isProviderAvailable,
  listProviders,
  buildProviderCliArgs,
} from './config/providers.js';
export type {
  ProviderName,
  ProviderConfig,
  ProviderModelMap,
  ModelDescriptor,
} from './config/providers.js';

// --- Usage ledger + aggregation ----------------------------------------
export {
  UsageLedger,
  appendUsage,
  readUsage,
  summarize,
  ledgerPath,
} from './usage/ledger.js';
export type {
  UsageRecord,
  UsageSummary,
  UsageBucket,
} from './usage/ledger.js';

// --- Fleet router (optional multi-node Ollama routing) ------------------
export { OllamaFleet } from './fleet/ollama-fleet.js';
export type {
  FleetNode,
  TaskType,
  RouteResult,
} from './fleet/ollama-fleet.js';
export { OllamaMCP } from './fleet/ollama.js';
