/**
 * Fleet-aware Ollama router.
 *
 * Routes inference requests across the 3-PC dev mesh based on:
 *   - Task type (reasoning, coding, embedding, vision, fast)
 *   - Model availability per node
 *   - Node health / GPU capability
 */

import { OllamaMCP, OllamaChatMessage, OllamaChatResponse, OllamaGenerateResponse, OllamaEmbeddingResponse, OllamaModel } from './ollama.js';

export interface FleetNode {
  id: string;
  name: string;
  url: string;
  ssh: string;
  gpu: boolean;
  ramGB: number;
  capabilities: TaskType[];
  priority: number; // lower = preferred
}

export type TaskType = 'reasoning' | 'coding' | 'embedding' | 'vision' | 'fast' | 'general';

export interface RouteResult {
  node: FleetNode;
  model: string;
  reason: string;
}

interface ModelCapability {
  model: string;
  taskTypes: TaskType[];
  minRAM: number;
  requiresGPU: boolean;
}

const MODEL_CATALOG: ModelCapability[] = [
  { model: 'qwq:32b', taskTypes: ['reasoning'], minRAM: 24, requiresGPU: true },
  { model: 'qwq-tuned:latest', taskTypes: ['reasoning'], minRAM: 24, requiresGPU: true },
  { model: 'deepseek-r1:32b', taskTypes: ['reasoning'], minRAM: 24, requiresGPU: true },
  { model: 'deepseek-r1:14b', taskTypes: ['reasoning', 'general'], minRAM: 12, requiresGPU: false },
  { model: 'qwen2.5-coder:14b', taskTypes: ['coding'], minRAM: 12, requiresGPU: true },
  { model: 'qwen2.5-coder:7b', taskTypes: ['coding', 'fast'], minRAM: 6, requiresGPU: false },
  { model: 'llava:13b', taskTypes: ['vision'], minRAM: 10, requiresGPU: true },
  { model: 'llama3.2-vision:11b', taskTypes: ['vision'], minRAM: 10, requiresGPU: true },
  { model: 'nomic-embed-text:latest', taskTypes: ['embedding'], minRAM: 1, requiresGPU: false },
  { model: 'llama3.1:8b', taskTypes: ['general', 'fast'], minRAM: 6, requiresGPU: false },
  { model: 'llama3.1:latest', taskTypes: ['general', 'fast'], minRAM: 6, requiresGPU: false },
  { model: 'mistral:latest', taskTypes: ['general', 'fast'], minRAM: 6, requiresGPU: false },
];

// Example fleet definition. Override by passing your own FleetNode[] to the
// OllamaFleet constructor, or load from settings.json. Hostnames/URLs below are
// placeholders — point them at your own Ollama endpoints.
const DEFAULT_FLEET: FleetNode[] = [
  {
    id: 'node-a',
    name: 'gpu-node',
    url: 'http://localhost:11434',
    ssh: 'localhost',
    gpu: true,
    ramGB: 64,
    capabilities: ['reasoning', 'coding', 'vision', 'embedding', 'fast', 'general'],
    priority: 1,
  },
  {
    id: 'node-b',
    name: 'cpu-node-1',
    url: 'http://node-b.local:11434',
    ssh: 'node-b',
    gpu: false,
    ramGB: 32,
    capabilities: ['coding', 'fast', 'general'],
    priority: 2,
  },
  {
    id: 'node-c',
    name: 'cpu-node-2',
    url: 'http://node-c.local:11434',
    ssh: 'user@node-c.local',
    gpu: false,
    ramGB: 128,
    capabilities: ['embedding', 'fast', 'general'],
    priority: 3,
  },
];

export class OllamaFleet {
  private nodes: FleetNode[];
  private clients: Map<string, OllamaMCP> = new Map();
  private healthCache: Map<string, { alive: boolean; models: string[]; checkedAt: number }> = new Map();
  private healthTTL = 30_000; // 30s cache

  constructor(nodes?: FleetNode[]) {
    this.nodes = nodes || DEFAULT_FLEET;
    for (const node of this.nodes) {
      this.clients.set(node.id, new OllamaMCP(node.url));
    }
  }

  async checkHealth(nodeId: string): Promise<{ alive: boolean; models: string[] }> {
    const cached = this.healthCache.get(nodeId);
    if (cached && Date.now() - cached.checkedAt < this.healthTTL) {
      return cached;
    }

    const client = this.clients.get(nodeId);
    if (!client) return { alive: false, models: [] };

    try {
      const alive = await client.ping();
      let models: string[] = [];
      if (alive) {
        const list = await client.listModels();
        models = list.map((m) => m.name);
      }
      const result = { alive, models, checkedAt: Date.now() };
      this.healthCache.set(nodeId, result);
      return result;
    } catch {
      const result = { alive: false, models: [], checkedAt: Date.now() };
      this.healthCache.set(nodeId, result);
      return result;
    }
  }

  async healthAll(): Promise<Map<string, { alive: boolean; models: string[]; node: FleetNode }>> {
    const results = new Map<string, { alive: boolean; models: string[]; node: FleetNode }>();
    const checks = this.nodes.map(async (node) => {
      const health = await this.checkHealth(node.id);
      results.set(node.id, { ...health, node });
    });
    await Promise.all(checks);
    return results;
  }

  async route(taskType: TaskType, preferredModel?: string): Promise<RouteResult> {
    const health = await this.healthAll();

    // If a specific model is requested, find which node has it
    if (preferredModel) {
      for (const node of this.nodes.sort((a, b) => a.priority - b.priority)) {
        const h = health.get(node.id);
        if (h?.alive && h.models.some((m) => m === preferredModel || m.startsWith(preferredModel))) {
          return {
            node,
            model: h.models.find((m) => m === preferredModel || m.startsWith(preferredModel))!,
            reason: `${node.name} has ${preferredModel}`,
          };
        }
      }
      throw new Error(`Model ${preferredModel} not available on any fleet node`);
    }

    // Route by task type — pick best model on best node
    const candidates: { node: FleetNode; model: string; score: number }[] = [];

    for (const node of this.nodes) {
      const h = health.get(node.id);
      if (!h?.alive) continue;
      if (!node.capabilities.includes(taskType)) continue;

      for (const mc of MODEL_CATALOG) {
        if (!mc.taskTypes.includes(taskType)) continue;
        if (mc.requiresGPU && !node.gpu) continue;
        if (mc.minRAM > node.ramGB) continue;
        if (!h.models.some((m) => m === mc.model || m.startsWith(mc.model.split(':')[0]))) continue;

        // Score: lower priority node number = better, larger model = better
        const sizeScore = mc.minRAM; // proxy for model capability
        const nodeScore = 100 - node.priority * 10;
        candidates.push({ node, model: mc.model, score: sizeScore + nodeScore });
      }
    }

    if (candidates.length === 0) {
      // Fallback: any alive node, any model
      for (const node of this.nodes) {
        const h = health.get(node.id);
        if (h?.alive && h.models.length > 0) {
          return {
            node,
            model: h.models[0],
            reason: `fallback: no ${taskType}-optimal model, using ${h.models[0]} on ${node.name}`,
          };
        }
      }
      throw new Error('No fleet nodes are alive');
    }

    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];
    return {
      node: best.node,
      model: best.model,
      reason: `${best.node.name} (${best.node.gpu ? 'GPU' : 'CPU'}) → ${best.model} for ${taskType}`,
    };
  }

  async chat(
    messages: OllamaChatMessage[],
    taskType: TaskType = 'general',
    options: { model?: string; temperature?: number; max_tokens?: number; num_ctx?: number } = {}
  ): Promise<OllamaChatResponse & { _route: RouteResult }> {
    const route = await this.route(taskType, options.model);
    const client = this.clients.get(route.node.id)!;

    const body: Record<string, unknown> = {
      model: route.model,
      messages,
      stream: false,
    };
    const opts: Record<string, unknown> = {};
    if (options.temperature !== undefined) opts.temperature = options.temperature;
    if (options.max_tokens !== undefined) opts.num_predict = options.max_tokens;
    if (options.num_ctx !== undefined) opts.num_ctx = options.num_ctx;
    if (taskType === 'reasoning') opts.num_ctx = opts.num_ctx || 8192;
    if (Object.keys(opts).length > 0) body.options = opts;

    const res = await fetch(`${route.node.url}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Fleet chat failed on ${route.node.name}: HTTP ${res.status} - ${text}`);
    }
    const result = await res.json() as OllamaChatResponse;
    return { ...result, _route: route };
  }

  async generate(
    prompt: string,
    taskType: TaskType = 'general',
    options: { model?: string; system?: string; temperature?: number; num_ctx?: number } = {}
  ): Promise<OllamaGenerateResponse & { _route: RouteResult }> {
    const route = await this.route(taskType, options.model);

    const body: Record<string, unknown> = {
      model: route.model,
      prompt,
      stream: false,
    };
    if (options.system) body.system = options.system;
    const opts: Record<string, unknown> = {};
    if (options.temperature !== undefined) opts.temperature = options.temperature;
    if (options.num_ctx !== undefined) opts.num_ctx = options.num_ctx;
    if (taskType === 'reasoning') opts.num_ctx = opts.num_ctx || 8192;
    if (Object.keys(opts).length > 0) body.options = opts;

    const res = await fetch(`${route.node.url}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Fleet generate failed on ${route.node.name}: HTTP ${res.status} - ${text}`);
    }
    const result = await res.json() as OllamaGenerateResponse;
    return { ...result, _route: route };
  }

  async embed(
    text: string,
    options: { model?: string } = {}
  ): Promise<OllamaEmbeddingResponse & { _route: RouteResult }> {
    const route = await this.route('embedding', options.model || 'nomic-embed-text:latest');

    const res = await fetch(`${route.node.url}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: route.model, prompt: text }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Fleet embed failed on ${route.node.name}: HTTP ${res.status} - ${text}`);
    }
    const result = await res.json() as OllamaEmbeddingResponse;
    return { ...result, _route: route };
  }

  /** Fan-out: send same prompt to multiple nodes, return all responses */
  async fanOut(
    messages: OllamaChatMessage[],
    taskTypes: TaskType[] = ['reasoning', 'coding', 'general'],
    options: { temperature?: number; num_ctx?: number } = {}
  ): Promise<Array<{ response: OllamaChatResponse; route: RouteResult } | { error: string; taskType: TaskType }>> {
    type FanOutSuccess = { response: OllamaChatResponse; route: RouteResult };
    type FanOutError = { error: string; taskType: TaskType };
    type FanOutResult = FanOutSuccess | FanOutError;

    const resolved: Array<{ route: RouteResult; taskType: TaskType } | FanOutError> = [];
    for (const tt of taskTypes) {
      try {
        resolved.push({ route: await this.route(tt), taskType: tt });
      } catch (e) {
        resolved.push({ error: (e as Error).message, taskType: tt });
      }
    }

    // Deduplicate: don't hit same node+model twice
    const seen = new Set<string>();
    const unique = resolved.filter((r): r is typeof r => {
      if ('error' in r) return true;
      const key = `${r.route.node.id}:${r.route.model}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const results: FanOutResult[] = [];
    await Promise.all(
      unique.map(async (r) => {
        if ('error' in r) {
          results.push(r);
          return;
        }
        try {
          const body: Record<string, unknown> = {
            model: r.route.model,
            messages,
            stream: false,
          };
          const opts: Record<string, unknown> = {};
          if (options.temperature !== undefined) opts.temperature = options.temperature;
          if (options.num_ctx !== undefined) opts.num_ctx = options.num_ctx;
          if (r.taskType === 'reasoning') opts.num_ctx = opts.num_ctx || 8192;
          if (Object.keys(opts).length > 0) body.options = opts;

          const res = await fetch(`${r.route.node.url}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const result = await res.json() as OllamaChatResponse;
          results.push({ response: result, route: r.route });
        } catch (e) {
          results.push({ error: (e as Error).message, taskType: r.taskType });
        }
      })
    );
    return results;
  }

  /** Status summary for CLI display */
  async status(): Promise<string> {
    const health = await this.healthAll();
    const lines: string[] = ['Fleet Ollama Status:', ''];
    for (const [id, h] of Array.from(health.entries())) {
      const icon = h.alive ? '●' : '○';
      const gpu = h.node.gpu ? ' [GPU]' : '';
      const models = h.alive ? ` (${h.models.length} models)` : ' (offline)';
      lines.push(`  ${icon} ${h.node.name} (${h.node.url})${gpu}${models}`);
      if (h.alive && h.models.length > 0) {
        const top5 = h.models.slice(0, 5);
        lines.push(`    ${top5.join(', ')}${h.models.length > 5 ? ` +${h.models.length - 5} more` : ''}`);
      }
    }

    lines.push('');
    lines.push('Routing table:');
    const taskTypes: TaskType[] = ['reasoning', 'coding', 'vision', 'embedding', 'fast', 'general'];
    for (const tt of taskTypes) {
      try {
        const r = await this.route(tt);
        lines.push(`  ${tt.padEnd(12)} → ${r.node.name} / ${r.model}`);
      } catch {
        lines.push(`  ${tt.padEnd(12)} → (no node available)`);
      }
    }

    return lines.join('\n');
  }

  getNodes(): FleetNode[] {
    return [...this.nodes];
  }

  getClient(nodeId: string): OllamaMCP | undefined {
    return this.clients.get(nodeId);
  }
}
