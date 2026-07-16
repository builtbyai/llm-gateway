/**
 * Provider Abstraction Layer
 *
 * Supports multiple AI backends: Anthropic (Claude), OpenAI (Codex), and Ollama (local).
 * Each provider maps the generic model tiers (fast/standard/advanced) to provider-specific models
 * and knows how to invoke its CLI or API.
 */

export type ProviderName = 'anthropic' | 'openai' | 'ollama';

export interface ProviderModelMap {
  fast: string;
  standard: string;
  advanced: string;
}

/**
 * Rich model metadata used for cost accounting, cache planning, and capability checks.
 * Costs are USD per million tokens (MTok). Cache multipliers are applied to inputCostPerMTok.
 */
export interface ModelDescriptor {
  id: string;
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
 * Canonical Anthropic model registry (April 2026).
 * Source: platform.claude.com release notes.
 */
export const ANTHROPIC_MODELS: Record<string, ModelDescriptor> = {
  'claude-opus-4-7': {
    id: 'claude-opus-4-7',
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

/** Resolve a tier alias (fast/standard/advanced) to a canonical Anthropic model id. */
export function resolveAnthropicModelId(tierOrId: string): string {
  const tierMap: Record<string, string> = {
    fast: 'claude-haiku-4-5-20251001',
    standard: 'claude-sonnet-4-6',
    advanced: 'claude-opus-4-7',
    haiku: 'claude-haiku-4-5-20251001',
    sonnet: 'claude-sonnet-4-6',
    opus: 'claude-opus-4-7',
  };
  return tierMap[tierOrId] ?? tierOrId;
}

/** Look up a ModelDescriptor by id or tier alias. Returns undefined for unknown providers/models. */
export function getModelDescriptor(
  provider: ProviderName,
  tierOrId: string
): ModelDescriptor | undefined {
  if (provider !== 'anthropic') return undefined;
  return ANTHROPIC_MODELS[resolveAnthropicModelId(tierOrId)];
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
      advanced: 'claude-opus-4-7',
    },
  },
  openai: {
    name: 'openai',
    cli: 'codex',
    apiKeyEnv: 'OPENAI_API_KEY',
    models: {
      fast: 'gpt-4.1-mini',
      standard: 'gpt-4.1',
      advanced: 'o3',
    },
  },
  ollama: {
    name: 'ollama',
    cli: 'ollama',
    apiBase: 'http://localhost:11434',
    models: {
      fast: 'qwen2.5-coder:7b',
      standard: 'qwen2.5-coder:14b',
      // Advanced aliases to the standard tier by default. Pull a larger coder
      // model (e.g. deepseek-coder-v2:16b) and update this mapping to enable a
      // dedicated advanced tier.
      advanced: 'qwen2.5-coder:14b',
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
  // Pass through literal model names (e.g., 'gpt-4.1', 'llama3:70b')
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
