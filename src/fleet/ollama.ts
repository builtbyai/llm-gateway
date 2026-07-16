/**
 * Ollama MCP Server Integration
 *
 * Exposes local Ollama models as MCP-compatible tools.
 * Supports chat completions, embeddings, model management, and streaming.
 */

import { MCPServerConfig, MCPTool, MCPResource } from './mcp-types.js';

export interface OllamaModel {
  name: string;
  modified_at: string;
  size: number;
  digest: string;
  details?: {
    format: string;
    family: string;
    parameter_size: string;
    quantization_level: string;
  };
}

export interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface OllamaChatResponse {
  model: string;
  message: { role: string; content: string };
  done: boolean;
  total_duration?: number;
  eval_count?: number;
  eval_duration?: number;
}

export interface OllamaEmbeddingResponse {
  embedding: number[];
}

export interface OllamaGenerateResponse {
  model: string;
  response: string;
  done: boolean;
  total_duration?: number;
}

/**
 * Ollama MCP client - wraps the Ollama HTTP API as MCP-compatible tools.
 */
export class OllamaMCP {
  private baseUrl: string;
  private defaultModel: string;

  constructor(baseUrl: string = 'http://localhost:11434', defaultModel?: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.defaultModel = defaultModel || 'qwen2.5-coder:7b';
  }

  /** Get MCP server config for registration */
  getServerConfig(): MCPServerConfig {
    return {
      name: 'ollama',
      type: 'http',
      url: this.baseUrl,
      scope: 'user',
    };
  }

  /** List available MCP tools from Ollama */
  getTools(): MCPTool[] {
    return [
      {
        name: 'chat',
        description: 'Send a chat completion request to a local Ollama model',
        inputSchema: {
          type: 'object',
          properties: {
            model: { type: 'string', description: 'Model name (e.g., qwen2.5-coder:7b)' },
            messages: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  role: { type: 'string', enum: ['system', 'user', 'assistant'] },
                  content: { type: 'string' },
                },
                required: ['role', 'content'],
              },
              description: 'Chat messages array',
            },
            temperature: { type: 'number', description: 'Sampling temperature (0-2)' },
            max_tokens: { type: 'number', description: 'Max tokens to generate' },
          },
          required: ['messages'],
        },
        server: 'ollama',
      },
      {
        name: 'generate',
        description: 'Generate text completion from a local Ollama model',
        inputSchema: {
          type: 'object',
          properties: {
            model: { type: 'string', description: 'Model name' },
            prompt: { type: 'string', description: 'The prompt to complete' },
            system: { type: 'string', description: 'System prompt' },
            temperature: { type: 'number' },
          },
          required: ['prompt'],
        },
        server: 'ollama',
      },
      {
        name: 'embeddings',
        description: 'Generate embeddings from text using a local Ollama model',
        inputSchema: {
          type: 'object',
          properties: {
            model: { type: 'string', description: 'Embedding model name' },
            prompt: { type: 'string', description: 'Text to embed' },
          },
          required: ['prompt'],
        },
        server: 'ollama',
      },
      {
        name: 'list_models',
        description: 'List all locally available Ollama models',
        inputSchema: { type: 'object', properties: {} },
        server: 'ollama',
      },
      {
        name: 'show_model',
        description: 'Show details of a specific Ollama model',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Model name to inspect' },
          },
          required: ['name'],
        },
        server: 'ollama',
      },
      {
        name: 'pull_model',
        description: 'Pull/download an Ollama model',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Model name to pull' },
          },
          required: ['name'],
        },
        server: 'ollama',
      },
      {
        name: 'delete_model',
        description: 'Delete a local Ollama model',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Model name to delete' },
          },
          required: ['name'],
        },
        server: 'ollama',
      },
    ];
  }

  /** List available models as MCP resources */
  async getResources(): Promise<MCPResource[]> {
    const models = await this.listModels();
    return models.map((m) => ({
      uri: `ollama://models/${m.name}`,
      name: m.name,
      description: m.details
        ? `${m.details.family} ${m.details.parameter_size} (${m.details.quantization_level})`
        : `${(m.size / 1e9).toFixed(1)}GB`,
      mimeType: 'application/json',
      server: 'ollama',
    }));
  }

  /** Execute an MCP tool call */
  async callTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    switch (toolName) {
      case 'chat':
        return this.chat(
          args.messages as OllamaChatMessage[],
          (args.model as string) || this.defaultModel,
          {
            temperature: args.temperature as number | undefined,
            max_tokens: args.max_tokens as number | undefined,
          }
        );
      case 'generate':
        return this.generate(
          args.prompt as string,
          (args.model as string) || this.defaultModel,
          {
            system: args.system as string | undefined,
            temperature: args.temperature as number | undefined,
          }
        );
      case 'embeddings':
        return this.embed(
          args.prompt as string,
          (args.model as string) || this.defaultModel
        );
      case 'list_models':
        return this.listModels();
      case 'show_model':
        return this.showModel(args.name as string);
      case 'pull_model':
        return this.pullModel(args.name as string);
      case 'delete_model':
        return this.deleteModel(args.name as string);
      default:
        throw new Error(`Unknown Ollama tool: ${toolName}`);
    }
  }

  // --- Ollama API methods ---

  async listModels(): Promise<OllamaModel[]> {
    const res = await fetch(`${this.baseUrl}/api/tags`);
    if (!res.ok) throw new Error(`Ollama /api/tags failed: HTTP ${res.status}`);
    const data = await res.json() as { models: OllamaModel[] };
    return data.models || [];
  }

  async chat(
    messages: OllamaChatMessage[],
    model?: string,
    options: { temperature?: number; max_tokens?: number } = {}
  ): Promise<OllamaChatResponse> {
    const body: Record<string, unknown> = {
      model: model || this.defaultModel,
      messages,
      stream: false,
    };
    if (options.temperature !== undefined) {
      body.options = { ...(body.options as object || {}), temperature: options.temperature };
    }
    if (options.max_tokens !== undefined) {
      body.options = { ...(body.options as object || {}), num_predict: options.max_tokens };
    }

    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Ollama chat failed: HTTP ${res.status} - ${text}`);
    }
    return res.json() as Promise<OllamaChatResponse>;
  }

  async generate(
    prompt: string,
    model?: string,
    options: { system?: string; temperature?: number } = {}
  ): Promise<OllamaGenerateResponse> {
    const body: Record<string, unknown> = {
      model: model || this.defaultModel,
      prompt,
      stream: false,
    };
    if (options.system) body.system = options.system;
    if (options.temperature !== undefined) {
      body.options = { temperature: options.temperature };
    }

    const res = await fetch(`${this.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Ollama generate failed: HTTP ${res.status} - ${text}`);
    }
    return res.json() as Promise<OllamaGenerateResponse>;
  }

  async embed(prompt: string, model?: string): Promise<OllamaEmbeddingResponse> {
    const res = await fetch(`${this.baseUrl}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model || this.defaultModel,
        prompt,
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Ollama embeddings failed: HTTP ${res.status} - ${text}`);
    }
    return res.json() as Promise<OllamaEmbeddingResponse>;
  }

  async showModel(name: string): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) throw new Error(`Ollama show failed: HTTP ${res.status}`);
    return res.json();
  }

  async pullModel(name: string): Promise<{ status: string }> {
    const res = await fetch(`${this.baseUrl}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, stream: false }),
    });
    if (!res.ok) throw new Error(`Ollama pull failed: HTTP ${res.status}`);
    return res.json() as Promise<{ status: string }>;
  }

  async deleteModel(name: string): Promise<{ status: string }> {
    const res = await fetch(`${this.baseUrl}/api/delete`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) throw new Error(`Ollama delete failed: HTTP ${res.status}`);
    return { status: 'success' };
  }

  /** Health check */
  async ping(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`);
      return res.ok;
    } catch {
      return false;
    }
  }
}
