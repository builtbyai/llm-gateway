/**
 * Minimal MCP (Model Context Protocol) type surface.
 *
 * The fleet router exposes each Ollama node's tools/resources in an
 * MCP-compatible shape. Only the type definitions are needed here — the full
 * server/transport machinery lives elsewhere — so they are pulled out into this
 * standalone declaration to keep the gateway self-contained.
 */

export type MCPTransport = 'stdio' | 'http' | 'sse';

export interface MCPServerConfig {
  name: string;
  type: MCPTransport;
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  scope: 'local' | 'project' | 'user';
}

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  server: string;
}

export interface MCPResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
  server: string;
}
