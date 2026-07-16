/**
 * Provider Abstraction Layer
 *
 * Supports multiple LLM backends: Anthropic (Claude), OpenAI (GPT / o-series),
 * and Ollama (local, zero-cost). Each provider maps the generic model tiers
 * (fast/standard/advanced) to provider-specific models, carries per-model
 * pricing for cost attribution, and knows how to invoke its CLI or API.
 */

export type ProviderName = 'anthropic' | 'openai' | 'ollama';

export interface ProviderModelMap {
  fast: string;
  standard: string;
  advanced: string;
}

/**
 * Pricing-table version stamp.
 *
 * This is the effective date of every USD rate in the model registries below.
 * It is stamped onto each priced `UsageRecord` (see `priceUsage`) so a
 * historical cost can be reconstructed and audited against the rates that were
 * live when the call was made — even after this table is later refreshed.
 *
 * Effective date: 2026-07-16.
 * Sources: platform.claude.com pricing, platform.openai.com/pricing.
 * Bump this string in the SAME commit as any rate change.
 */
export const PRICING_VERSION = '2026-07-16';

/**
 * Rich model metadata used for cost accounting, cache planning, and capability
 * checks. Costs are USD per million tokens (MTok). Cache multipliers are
 * applied to `inputCostPerMTok`:
 *   - cacheReadMultiplier      : rate for tokens served FROM cache
 *   - cacheWriteMultiplier5min : rate premium for WRITING a 5-minute cache block
 *   - cacheWriteMultiplier1h   : rate premium for WRITING a 1-hour cache block
 *
 * Anthropic charges a write premium (1.25x / 2x) and a deep read discount
 * (0.1x). OpenAI's caching is automatic: reads are discounted (0.25x–0.5x) and
 * there is no write premium (multiplier 1). Ollama is local, so every rate is 0.
 */
export interface ModelDescriptor {
  id: string;
  provider: ProviderName;
  contextWindow: number;
  maxOutputTokens: number;
  inputCostPerMTok: number;
  outputCostPerMTok: number;
  cacheWriteMultiplier5min?: number;
  cacheWriteMultiplier1h?: number;
  cacheReadMultiplier?: number;
  supportsCaching: boolean;
  supportsVision: boolean;
  releasedAt?: string;
}

/**
 * Canonical Anthropic model registry.
 * Rates are USD/MTok, effective PRICING_VERSION (2026-07-16).
 * Source: platform.claude.com pricing.
 */
export const ANTHROPIC_MODELS: Record<string, ModelDescriptor> = {
  'claude-opus-4-8': {
    id: 'claude-opus-4-8',
    provider: 'anthropic',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    inputCostPerMTok: 5,
    outputCostPerMTok: 25,
    cacheWriteMultiplier5min: 1.25,
    cacheWriteMultiplier1h: 2,
    cacheReadMultiplier: 0.1,
    supportsCaching: true,
    supportsVision: true,
    releasedAt: '2026-07-01',
  },
  'claude-opus-4-7': {
    id: 'claude-opus-4-7',
    provider: 'anthropic',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    inputCostPerMTok: 5,
    outputCostPerMTok: 25,
    cacheWriteMultiplier5min: 1.25,
    cacheWriteMultiplier1h: 2,
    cacheReadMultiplier: 0.1,
    supportsCaching: true,
    supportsVision: true,
    releasedAt: '2026-04-16',
  },
  'claude-sonnet-4-6': {
    id: 'claude-sonnet-4-6',
    provider: 'anthropic',
    contextWindow: 1_000_000,
    maxOutputTokens: 64_000,
    inputCostPerMTok: 3,
    outputCostPerMTok: 15,
    cacheWriteMultiplier5min: 1.25,
    cacheWriteMultiplier1h: 2,
    cacheReadMultiplier: 0.1,
    supportsCaching: true,
    supportsVision: true,
    releasedAt: '2026-02-17',
  },
  'claude-haiku-4-5-20251001': {
    id: 'claude-haiku-4-5-20251001',
    provider: 'anthropic',
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
    inputCostPerMTok: 0.8,
    outputCostPerMTok: 4,
    cacheWriteMultiplier5min: 1.25,
    cacheWriteMultiplier1h: 2,
    cacheReadMultiplier: 0.1,
    supportsCaching: true,
    supportsVision: true,
    releasedAt: '2025-10-01',
  },
};

/**
 * Canonical OpenAI model registry.
 * Rates are USD/MTok, effective PRICING_VERSION (2026-07-16).
 * Source: platform.openai.com/pricing.
 *
 * OpenAI prompt caching is automatic: input tokens that hit the cache are
 * billed at `cacheReadMultiplier` x the base input rate (0.5x for the 4o /
 * o-series, 0.25x for the 4.1 family). There is no cache-WRITE premium, so the
 * write multipliers are 1.
 */
export const OPENAI_MODELS: Record<string, ModelDescriptor> = {
  'gpt-4o': {
    id: 'gpt-4o',
    provider: 'openai',
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    inputCostPerMTok: 2.5,
    outputCostPerMTok: 10,
    // cached input $1.25 / MTok => 0.5x of $2.50
    cacheReadMultiplier: 0.5,
    cacheWriteMultiplier5min: 1,
    cacheWriteMultiplier1h: 1,
    supportsCaching: true,
    supportsVision: true,
    releasedAt: '2024-08-06',
  },
  'gpt-4o-mini': {
    id: 'gpt-4o-mini',
    provider: 'openai',
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    inputCostPerMTok: 0.15,
    outputCostPerMTok: 0.6,
    // cached input $0.075 / MTok => 0.5x of $0.15
    cacheReadMultiplier: 0.5,
    cacheWriteMultiplier5min: 1,
    cacheWriteMultiplier1h: 1,
    supportsCaching: true,
    supportsVision: true,
    releasedAt: '2024-07-18',
  },
  'gpt-4.1': {
    id: 'gpt-4.1',
    provider: 'openai',
    contextWindow: 1_000_000,
    maxOutputTokens: 32_768,
    inputCostPerMTok: 2,
    outputCostPerMTok: 8,
    // cached input $0.50 / MTok => 0.25x of $2.00
    cacheReadMultiplier: 0.25,
    cacheWriteMultiplier5min: 1,
    cacheWriteMultiplier1h: 1,
    supportsCaching: true,
    supportsVision: true,
    releasedAt: '2025-04-14',
  },
  'gpt-4.1-mini': {
    id: 'gpt-4.1-mini',
    provider: 'openai',
    contextWindow: 1_000_000,
    maxOutputTokens: 32_768,
    inputCostPerMTok: 0.4,
    outputCostPerMTok: 1.6,
    // cached input $0.10 / MTok => 0.25x of $0.40
    cacheReadMultiplier: 0.25,
    cacheWriteMultiplier5min: 1,
    cacheWriteMultiplier1h: 1,
    supportsCaching: true,
    supportsVision: true,
    releasedAt: '2025-04-14',
  },
  o1: {
    id: 'o1',
    provider: 'openai',
    contextWindow: 200_000,
    maxOutputTokens: 100_000,
    inputCostPerMTok: 15,
    outputCostPerMTok: 60,
    // cached input $7.50 / MTok => 0.5x of $15
    cacheReadMultiplier: 0.5,
    cacheWriteMultiplier5min: 1,
    cacheWriteMultiplier1h: 1,
    supportsCaching: true,
    supportsVision: true,
    releasedAt: '2024-12-17',
  },
  'o3-mini': {
    id: 'o3-mini',
    provider: 'openai',
    contextWindow: 200_000,
    maxOutputTokens: 100_000,
    inputCostPerMTok: 1.1,
    outputCostPerMTok: 4.4,
    // cached input $0.55 / MTok => 0.5x of $1.10
    cacheReadMultiplier: 0.5,
    cacheWriteMultiplier5min: 1,
    cacheWriteMultiplier1h: 1,
    supportsCaching: true,
    supportsVision: false,
    releasedAt: '2025-01-31',
  },
};

/**
 * Known local Ollama models. Local inference is free, so every rate is 0 and
 * `getModelDescriptor('ollama', <anything>)` synthesizes a zero-cost descriptor
 * for models not listed here (you can run any model locally).
 */
export const OLLAMA_MODELS: Record<string, ModelDescriptor> = {
  'qwen2.5-coder:7b': ollamaDescriptor('qwen2.5-coder:7b', 32_768),
  'qwen2.5-coder:14b': ollamaDescriptor('qwen2.5-coder:14b', 32_768),
  'qwq:32b': ollamaDescriptor('qwq:32b', 32_768),
  'deepseek-r1:32b': ollamaDescriptor('deepseek-r1:32b', 65_536),
  'llama3.1:8b': ollamaDescriptor('llama3.1:8b', 131_072),
  'nomic-embed-text:latest': ollamaDescriptor('nomic-embed-text:latest', 8_192),
};

/** Build a zero-cost descriptor for a local Ollama model. */
function ollamaDescriptor(id: string, contextWindow = 8_192): ModelDescriptor {
  return {
    id,
    provider: 'ollama',
    contextWindow,
    maxOutputTokens: contextWindow,
    inputCostPerMTok: 0,
    outputCostPerMTok: 0,
    cacheReadMultiplier: 0,
    cacheWriteMultiplier5min: 0,
    cacheWriteMultiplier1h: 0,
    supportsCaching: false,
    supportsVision: false,
  };
}

/** Resolve a tier alias (fast/standard/advanced) to a canonical Anthropic model id. */
export function resolveAnthropicModelId(tierOrId: string): string {
  const tierMap: Record<string, string> = {
    fast: 'claude-haiku-4-5-20251001',
    standard: 'claude-sonnet-4-6',
    advanced: 'claude-opus-4-8',
    haiku: 'claude-haiku-4-5-20251001',
    sonnet: 'claude-sonnet-4-6',
    opus: 'claude-opus-4-8',
  };
  return tierMap[tierOrId] ?? tierOrId;
}

/** Resolve a tier alias to a canonical OpenAI model id. */
export function resolveOpenAIModelId(tierOrId: string): string {
  const tierMap: Record<string, string> = {
    fast: 'gpt-4o-mini',
    standard: 'gpt-4o',
    advanced: 'o1',
  };
  return tierMap[tierOrId] ?? tierOrId;
}

/** Resolve a tier alias to a canonical Ollama model id. */
export function resolveOllamaModelId(tierOrId: string): string {
  const tierMap: Record<string, string> = {
    fast: 'qwen2.5-coder:7b',
    standard: 'qwen2.5-coder:14b',
    advanced: 'qwq:32b',
  };
  return tierMap[tierOrId] ?? tierOrId;
}

/**
 * Look up a ModelDescriptor for a specific provider by id or tier alias.
 *
 * - anthropic / openai: returns the pinned descriptor, or undefined if unknown.
 * - ollama: always returns a (zero-cost) descriptor, synthesizing one for any
 *   local model id not in `OLLAMA_MODELS`.
 */
export function getModelDescriptor(
  provider: ProviderName,
  tierOrId: string
): ModelDescriptor | undefined {
  switch (provider) {
    case 'anthropic':
      return ANTHROPIC_MODELS[resolveAnthropicModelId(tierOrId)];
    case 'openai':
      return OPENAI_MODELS[resolveOpenAIModelId(tierOrId)];
    case 'ollama': {
      const id = resolveOllamaModelId(tierOrId);
      return OLLAMA_MODELS[id] ?? ollamaDescriptor(id);
    }
    default:
      return undefined;
  }
}

/**
 * Provider-agnostic descriptor lookup used by the cost model.
 *
 * If `provider` is given, defers to `getModelDescriptor`. Otherwise it resolves
 * by id/tier across registries, trying Anthropic first (so bare tier aliases
 * like `'advanced'` keep their historical Anthropic meaning), then OpenAI, then
 * Ollama. Pass an explicit `provider` to disambiguate a shared tier alias.
 */
export function findModelDescriptor(
  idOrTier: string,
  provider?: ProviderName
): ModelDescriptor | undefined {
  if (provider) return getModelDescriptor(provider, idOrTier);

  const anthropic = ANTHROPIC_MODELS[resolveAnthropicModelId(idOrTier)];
  if (anthropic) return anthropic;

  const openai = OPENAI_MODELS[resolveOpenAIModelId(idOrTier)];
  if (openai) return openai;

  return OLLAMA_MODELS[idOrTier];
}

export interface ProviderConfig {
  /** Which provider to use */
  name: ProviderName;
  /** CLI binary name (e.g., 'claude', 'codex') */
  cli: string;
  /** API base URL (for HTTP-based providers like Ollama) */
  apiBase?: string;
  /** API key env var name */
  apiKeyEnv?: string;
  /** Model tier mapping */
  models: ProviderModelMap;
  /** Extra CLI flags always passed */
  defaultFlags?: string[];
}

/** Built-in provider definitions */
export const PROVIDERS: Record<ProviderName, ProviderConfig> = {
  anthropic: {
    name: 'anthropic',
    cli: 'claude',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    models: {
      fast: 'claude-haiku-4-5-20251001',
      standard: 'claude-sonnet-4-6',
      advanced: 'claude-opus-4-8',
    },
  },
  openai: {
    name: 'openai',
    cli: 'codex',
    apiKeyEnv: 'OPENAI_API_KEY',
    models: {
      fast: 'gpt-4o-mini',
      standard: 'gpt-4o',
      advanced: 'o1',
    },
  },
  ollama: {
    name: 'ollama',
    cli: 'ollama',
    apiBase: 'http://localhost:11434',
    models: {
      fast: 'qwen2.5-coder:7b',
      standard: 'qwen2.5-coder:14b',
      // Advanced routes to a local reasoning model. Pull `qwq:32b` (or edit this
      // mapping) to enable it; falls back gracefully to the coder tier if absent.
      advanced: 'qwq:32b',
    },
  },
};

/**
 * Resolve the actual model name for a given provider and tier.
 * Accepts either a tier name (fast/standard/advanced) or a literal model string.
 */
export function resolveModel(
  provider: ProviderConfig,
  modelTier: string
): string {
  const tier = modelTier as keyof ProviderModelMap;
  if (tier in provider.models) {
    return provider.models[tier];
  }
  // Pass through literal model names (e.g., 'gpt-4o', 'llama3:70b')
  return modelTier;
}

/**
 * Get provider config by name, with optional overrides from settings.
 */
export function getProvider(
  name: ProviderName,
  overrides?: Partial<ProviderConfig>
): ProviderConfig {
  const base = PROVIDERS[name];
  if (!base) {
    throw new Error(`Unknown provider: ${name}. Available: ${Object.keys(PROVIDERS).join(', ')}`);
  }
  if (!overrides) return base;

  return {
    ...base,
    ...overrides,
    models: {
      ...base.models,
      ...overrides.models,
    },
  };
}

/**
 * Check if a provider's CLI is available on the system.
 */
export async function isProviderAvailable(provider: ProviderConfig): Promise<boolean> {
  if (provider.name === 'ollama' && provider.apiBase) {
    try {
      const response = await fetch(`${provider.apiBase}/api/tags`);
      return response.ok;
    } catch {
      return false;
    }
  }

  // For CLI-based providers, check if the binary exists
  const { execSync } = await import('child_process');
  try {
    execSync(`${provider.cli} --version`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * List all available providers and their status.
 */
export async function listProviders(): Promise<Array<ProviderConfig & { available: boolean }>> {
  const results = [];
  for (const provider of Object.values(PROVIDERS)) {
    const available = await isProviderAvailable(provider);
    results.push({ ...provider, available });
  }
  return results;
}

/**
 * Build CLI args for invoking a provider's agent subprocess.
 * Returns [binary, ...args] suitable for spawn().
 */
export function buildProviderCliArgs(
  provider: ProviderConfig,
  model: string,
  prompt: string,
  options: {
    allowedTools?: string[];
    disallowedTools?: string[];
    maxTurns?: number;
    print?: boolean;
  } = {}
): { command: string; args: string[] } {
  const args: string[] = [...(provider.defaultFlags || [])];

  switch (provider.name) {
    case 'anthropic':
      args.push('--model', model);
      if (options.allowedTools?.length) {
        args.push('--allowedTools', options.allowedTools.join(','));
      }
      if (options.disallowedTools?.length) {
        args.push('--disallowedTools', options.disallowedTools.join(','));
      }
      if (options.maxTurns) {
        args.push('--max-turns', String(options.maxTurns));
      }
      if (options.print) {
        args.push('--print');
      }
      args.push(prompt);
      return { command: provider.cli, args };

    case 'openai':
      args.push('--model', model);
      if (options.print) {
        args.push('--quiet');
      }
      args.push(prompt);
      return { command: provider.cli, args };

    case 'ollama':
      // Ollama uses HTTP API, not CLI for agent invocation
      // Return a curl-like invocation for fallback; prefer OllamaMCP for actual use
      args.push('run', model, prompt);
      return { command: provider.cli, args };
  }
}
