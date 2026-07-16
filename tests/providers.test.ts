/**
 * Provider abstraction tests — covers tier resolution, ModelDescriptor lookup,
 * cost estimation, and CLI arg construction.
 */

import {
  PROVIDERS,
  ANTHROPIC_MODELS,
  PRICING_VERSION,
  resolveModel,
  resolveAnthropicModelId,
  getModelDescriptor,
  getProvider,
  buildProviderCliArgs,
} from '../src/config/providers';
import {
  buildCachedSystem,
  estimateCost,
  cacheHitRate,
} from '../src/anthropic/cache';

describe('providers', () => {
  describe('Anthropic model registry', () => {
    it('exposes a dated PRICING_VERSION stamp', () => {
      expect(PRICING_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('pins the current Opus flagship (4.8) and keeps 4.7 for historical records', () => {
      const opus8 = ANTHROPIC_MODELS['claude-opus-4-8'];
      expect(opus8.contextWindow).toBe(1_000_000);
      expect(opus8.inputCostPerMTok).toBe(5);
      expect(opus8.outputCostPerMTok).toBe(25);
      expect(opus8.cacheReadMultiplier).toBe(0.1);
      expect(opus8.supportsVision).toBe(true);

      // 4.7 stays in the registry so old ledger lines still price.
      const opus7 = ANTHROPIC_MODELS['claude-opus-4-7'];
      expect(opus7.inputCostPerMTok).toBe(5);
      expect(opus7.outputCostPerMTok).toBe(25);
    });

    it('resolves tier aliases to canonical IDs', () => {
      expect(resolveAnthropicModelId('advanced')).toBe('claude-opus-4-8');
      expect(resolveAnthropicModelId('standard')).toBe('claude-sonnet-4-6');
      expect(resolveAnthropicModelId('fast')).toBe('claude-haiku-4-5-20251001');
    });

    it('passes through unknown ids', () => {
      expect(resolveAnthropicModelId('claude-future-9-9')).toBe('claude-future-9-9');
    });

    it('getModelDescriptor now resolves every provider', () => {
      expect(getModelDescriptor('anthropic', 'advanced')?.id).toBe('claude-opus-4-8');
      expect(getModelDescriptor('openai', 'gpt-4o')?.provider).toBe('openai');
      expect(getModelDescriptor('openai', 'standard')?.id).toBe('gpt-4o');
      // Ollama synthesizes a zero-cost descriptor for any local model.
      const local = getModelDescriptor('ollama', 'some-local-model:latest');
      expect(local?.provider).toBe('ollama');
      expect(local?.inputCostPerMTok).toBe(0);
    });
  });

  describe('resolveModel (legacy tier map)', () => {
    it('maps anthropic tiers to pinned IDs', () => {
      expect(resolveModel(PROVIDERS.anthropic, 'advanced')).toBe('claude-opus-4-8');
      expect(resolveModel(PROVIDERS.anthropic, 'fast')).toBe('claude-haiku-4-5-20251001');
    });

    it('passes through literal model names', () => {
      expect(resolveModel(PROVIDERS.anthropic, 'gpt-4.1')).toBe('gpt-4.1');
    });
  });

  describe('getProvider', () => {
    it('throws on unknown provider', () => {
      expect(() => getProvider('mystery' as 'anthropic')).toThrow(/Unknown provider/);
    });

    it('merges overrides', () => {
      const merged = getProvider('ollama', {
        models: { fast: 'tiny', standard: 'med', advanced: 'big' },
      });
      expect(merged.models.advanced).toBe('big');
    });
  });

  describe('buildProviderCliArgs', () => {
    it('builds anthropic CLI args with tools + model', () => {
      const { command, args } = buildProviderCliArgs(
        PROVIDERS.anthropic,
        'claude-opus-4-7',
        'hello',
        { allowedTools: ['Read', 'Edit'], print: true }
      );
      expect(command).toBe('claude');
      expect(args).toContain('--model');
      expect(args).toContain('claude-opus-4-7');
      expect(args).toContain('--allowedTools');
      expect(args).toContain('Read,Edit');
      expect(args).toContain('--print');
    });
  });
});

describe('anthropic/cache', () => {
  describe('buildCachedSystem', () => {
    it('marks system block as ephemeral', () => {
      const blocks = buildCachedSystem({ system: 'You are helpful.' });
      expect(blocks).toHaveLength(1);
      expect(blocks[0].cache_control).toEqual({ type: 'ephemeral', ttl: '5m' });
    });

    it('appends skill block with same ttl', () => {
      const blocks = buildCachedSystem({
        system: 'sys',
        skillBlock: 'skill body',
        ttl: '1h',
      });
      expect(blocks).toHaveLength(2);
      expect(blocks[1].text).toBe('skill body');
      expect(blocks[1].cache_control?.ttl).toBe('1h');
    });

    it('omits empty system', () => {
      expect(buildCachedSystem({ system: '' })).toHaveLength(0);
    });
  });

  describe('estimateCost', () => {
    it('costs a cache-hit call at ~0.1× input', () => {
      const opus = ANTHROPIC_MODELS['claude-opus-4-7'];
      const cost = estimateCost(opus, {
        inputTokens: 0,
        outputTokens: 100,
        cacheReadInputTokens: 1_000_000,
      });
      // 1M tokens × $5 × 0.1 (read mult) + 100 tokens × $25/1M
      expect(cost).toBeCloseTo(0.5 + 0.0025, 4);
    });

    it('costs a cache-write call at 1.25× input (5m)', () => {
      const opus = ANTHROPIC_MODELS['claude-opus-4-7'];
      const cost = estimateCost(opus, {
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationInputTokens: 1_000_000,
      });
      // 1M × $5 × 1.25 = $6.25
      expect(cost).toBeCloseTo(6.25, 4);
    });
  });

  describe('cacheHitRate', () => {
    it('returns 0 with no usage', () => {
      expect(cacheHitRate({ inputTokens: 0, outputTokens: 0 })).toBe(0);
    });

    it('computes hit rate', () => {
      const r = cacheHitRate({
        inputTokens: 100,
        outputTokens: 0,
        cacheReadInputTokens: 900,
      });
      expect(r).toBeCloseTo(0.9, 2);
    });
  });
});
