import { generatePluginManifestTemplate, loadMcpPlugins, getLoadedMcpServers, shutdownMcpPlugins, callMcpTool } from '../core/mcp-plugins.js';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import pc from 'picocolors';

export interface PluginCommandContext {
  cwd: string;
  args: string[];
  json: boolean;
  log: (message: string) => void;
}

export async function runPluginsCommand(ctx: PluginCommandContext): Promise<void> {
  const sub = ctx.args[0] ?? 'list';

  switch (sub) {
    case 'init': {
      const targetPath = ctx.args[1] ?? join(ctx.cwd, 'xdou-plugins.json');
      const template = generatePluginManifestTemplate();
      await writeFile(targetPath, template, 'utf8');
      ctx.log(`${pc.green('created')} ${targetPath}`);
      ctx.log('Edit this file to configure your MCP plugins, then run `xdou plugins load` to activate them.');
      return;
    }

    case 'load': {
      const configPath = ctx.args[1] ?? join(ctx.cwd, 'xdou-plugins.json');
      const tools = await loadMcpPlugins(ctx.cwd, configPath);
      if (ctx.json) {
        ctx.log(JSON.stringify(tools.map((t) => ({ name: t.name, description: t.description, server: t.serverName })), null, 2));
      } else {
        if (!tools.length) {
          ctx.log('No MCP tools loaded. Check plugin configuration.');
          return;
        }
        ctx.log(`${pc.green('loaded')} ${tools.length} MCP tool${tools.length !== 1 ? 's' : ''}:`);
        for (const tool of tools) {
          ctx.log(`  ${pc.cyan(tool.name)} (${tool.serverName}): ${tool.description}`);
        }
      }
      return;
    }

    case 'list': {
      const servers = getLoadedMcpServers();
      if (ctx.json) {
        ctx.log(JSON.stringify(servers.map((s) => ({ name: s.name, tools: s.tools.map((t) => t.name) })), null, 2));
      } else {
        if (!servers.length) {
          ctx.log('No MCP servers loaded. Run `xdou plugins load` first.');
          return;
        }
        ctx.log(`${pc.green('loaded')} ${servers.length} MCP server${servers.length !== 1 ? 's' : ''}:`);
        for (const server of servers) {
          ctx.log(`  ${pc.cyan(server.name)}: ${server.tools.length} tool${server.tools.length !== 1 ? 's' : ''}`);
          for (const tool of server.tools) {
            ctx.log(`    ${tool.name}: ${tool.description}`);
          }
        }
      }
      return;
    }

    case 'call': {
      const [serverName, toolName, ...args] = ctx.args.slice(1);
      if (!serverName || !toolName) {
        throw new Error('Usage: xdou plugins call <server> <tool> [key=value...]');
      }
      const parsedArgs: Record<string, unknown> = {};
      for (const arg of args) {
        const [key, ...valueParts] = arg.split('=');
        if (key && valueParts.length > 0) {
          try {
            parsedArgs[key] = JSON.parse(valueParts.join('='));
          } catch {
            parsedArgs[key] = valueParts.join('=');
          }
        }
      }
      try {
        const result = await callMcpTool(serverName, toolName, parsedArgs);
        ctx.log(JSON.stringify(result, null, 2));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`MCP tool call failed: ${message}`);
      }
      return;
    }

    case 'unload': {
      await shutdownMcpPlugins();
      ctx.log(`${pc.yellow('unloaded')} all MCP plugins`);
      return;
    }

    default:
      throw new Error('Usage: xdou plugins init|load|list|call|unload');
  }
}