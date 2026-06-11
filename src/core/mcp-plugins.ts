/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  workingDir?: string;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  serverName: string;
}

export interface McpPluginConfig {
  name: string;
  type: 'mcp';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  skills?: string[];
  workingDir?: string;
}

export interface PluginManifest {
  plugins: McpPluginConfig[];
}

interface McpServerState {
  name: string;
  process: ChildProcess;
  tools: McpTool[];
  requestId: number;
  pendingRequests: Map<number, { resolve: (value: unknown) => void; reject: (reason: Error) => void }>;
}

const pluginCache = new Map<string, McpServerState>();

function generateRequestId(): number {
  return Math.floor(Math.random() * 1_000_000);
}

function parseMcpMessage(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

async function readMcpTools(server: McpServerState): Promise<McpTool[]> {
  return new Promise((resolve, reject) => {
    const id = generateRequestId();
    const request = JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list', params: {} }) + '\n';

    const timeout = setTimeout(() => {
      server.pendingRequests.delete(id);
      reject(new Error(`MCP tools/list timeout for ${server.name}`));
    }, 10000);

    server.pendingRequests.set(id, {
      resolve: (value: unknown) => {
        clearTimeout(timeout);
        const response = value as { result?: { tools: McpTool[] } };
        resolve(response.result?.tools ?? []);
      },
      reject: (err) => {
        clearTimeout(timeout);
        server.pendingRequests.delete(id);
        reject(err);
      },
    });

    server.process.stdin?.write(request);
  });
}

function handleMcpOutput(server: McpServerState, data: string): void {
  const lines = data.trim().split('\n');
  for (const line of lines) {
    const msg = parseMcpMessage(line);
    if (!msg || typeof msg !== 'object') continue;

     
    const msgObj = msg as { id?: number };
    if (msgObj.id && server.pendingRequests.has(msgObj.id)) {
       
      const { resolve } = server.pendingRequests.get(msgObj.id)!;
      server.pendingRequests.delete(msgObj.id);
      resolve(msg);
    }
  }
}

export async function loadMcpPlugin(config: McpPluginConfig, cwd: string): Promise<McpTool[]> {
  const serverKey = `${config.name}:${config.command}:${config.args?.join(',')}`;

  if (pluginCache.has(serverKey)) {
    return pluginCache.get(serverKey)!.tools;
  }

  const workingDir = config.workingDir ?? cwd;
  const env = { ...process.env, ...config.env };

   
  const child = spawn(config.command, config.args ?? [], {  
    cwd: workingDir,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

   
  const server: McpServerState = {  
    name: config.name,
    process: child,
    tools: [],
    requestId: 0,
    pendingRequests: new Map(),
  };

  child.stdout?.on('data', (data) => handleMcpOutput(server, data.toString()));  
  child.stderr?.on('data', (data) => {
    const str = data.toString();  
    if (!str.includes('MCP') && !str.includes('stdio')) {  
      console.error(`[mcp:${config.name}] stderr:`, str);
    }
  });

  child.on('error', (err) => {
    console.error(`[mcp:${config.name}] process error:`, err);
    pluginCache.delete(serverKey);
  });

  child.on('exit', (code: number) => {
    console.error(`[mcp:${config.name}] process exited with code ${code}`);
    pluginCache.delete(serverKey);
  });

  // Initialize MCP connection
  await new Promise<void>((resolve, reject) => {
    const initRequest = JSON.stringify({
      jsonrpc: '2.0',
      id: generateRequestId(),
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'xdou', version: '1.0.0' },
      },
    }) + '\n';

    child.stdin?.write(initRequest);

    child.stdout?.once('data', (data) => {  
      const msg = parseMcpMessage(data.toString());  
      const msgObj = msg as { result?: unknown } | null;
      if (msgObj && msgObj.result) {
        resolve();
      } else {
        reject(new Error(`MCP initialize failed for ${config.name}`));
      }
    });

    setTimeout(() => reject(new Error(`MCP initialize timeout for ${config.name}`)), 15000);
  });

  // List tools
  const tools = await readMcpTools(server);
  server.tools = tools;
  pluginCache.set(serverKey, server);

  console.log(`[mcp:${config.name}] loaded ${tools.length} tools:`, tools.map((t) => t.name).join(', '));
  return tools;
}

export async function loadMcpPlugins(cwd: string, configPath?: string): Promise<McpTool[]> {
  let manifest: PluginManifest;

  if (configPath) {
    const content = await readFile(configPath, 'utf8');
    manifest = JSON.parse(content);
  } else {
    // Try common locations
    const candidates = [
      join(cwd, 'xdou-plugins.json'),
      join(cwd, '.xdou', 'plugins.json'),
      resolve(tmpdir(), 'xdou', 'plugins.json'),
    ];

    manifest = { plugins: [] };
    for (const path of candidates) {
      try {
        const content = await readFile(path, 'utf8');
        manifest = JSON.parse(content);
        break;
      } catch { /* ignore */ }
    }
  }

  const allTools: McpTool[] = [];
  for (const plugin of manifest.plugins ?? []) {
    try {
      const tools = await loadMcpPlugin(plugin, cwd);
      allTools.push(...tools);
    } catch (err) {
      console.error(`[mcp] Failed to load plugin ${plugin.name}:`, err);
    }
  }

  return allTools;
}

export async function callMcpTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
  const server = Array.from(pluginCache.values()).find((s) => s.name === serverName);
  if (!server) throw new Error(`MCP server ${serverName} not loaded`);

  const tool = server.tools.find((t) => t.name === toolName);
  if (!tool) throw new Error(`Tool ${toolName} not found on server ${serverName}`);

  return new Promise((resolve, reject) => {
    const id = generateRequestId();
    const request = JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    }) + '\n';

    const timeout = setTimeout(() => {
      server.pendingRequests.delete(id);
      reject(new Error(`MCP tool call timeout: ${toolName}`));
    }, 60000);

    server.pendingRequests.set(id, {
      resolve: (value: unknown) => {
        clearTimeout(timeout);
        resolve(value);
      },
      reject: (err) => {
        clearTimeout(timeout);
        server.pendingRequests.delete(id);
        reject(err);
      },
    });

    server.process.stdin?.write(request);
  });
}

export async function shutdownMcpPlugins(): Promise<void> {
  for (const server of pluginCache.values()) {
    try {
      server.process.kill('SIGTERM');  
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (!server.process.killed) server.process.kill('SIGKILL');  
    } catch { /* ignore */ }
  }
  pluginCache.clear();
}

export function getLoadedMcpServers(): McpServerState[] {
  return Array.from(pluginCache.values());
}

export function getMcpToolsByServer(serverName: string): McpTool[] {
  return pluginCache.get(serverName)?.tools ?? [];
}

export function generatePluginManifestTemplate(): string {
  return JSON.stringify({
    plugins: [
      {
        name: 'github',
        type: 'mcp',
        command: 'npx',
        args: ['@modelcontextprotocol/server-github'],
        env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' },
        skills: ['create-issue', 'list-issues', 'create-pr', 'get-pr', 'review-pr'],
      },
      {
        name: 'linear',
        type: 'mcp',
        command: 'npx',
        args: ['@linear/mcp-server'],
        env: { LINEAR_API_KEY: '${LINEAR_API_KEY}' },
        skills: ['create-issue', 'list-issues', 'update-issue'],
      },
      {
        name: 'filesystem',
        type: 'mcp',
        command: 'npx',
        args: ['@modelcontextprotocol/server-filesystem', '/path/to/allowed/directory'],
        skills: ['read-file', 'write-file', 'list-directory'],
      },
    ],
  }, null, 2);
}