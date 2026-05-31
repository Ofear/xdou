import { cosmiconfig } from 'cosmiconfig';
import YAML from 'yaml';
import { defaultConfig, parseConfig, type XdouConfig } from './schema.js';

export async function loadConfig(cwd: string): Promise<{ config: XdouConfig; filepath?: string }> {
  const explorer = cosmiconfig('xdou', { searchPlaces: ['xdou.yaml', 'xdou.yml', '.xdourc.yaml', 'package.json'], loaders: { '.yaml': (_p: string, content: string) => YAML.parse(content) as unknown, '.yml': (_p: string, content: string) => YAML.parse(content) as unknown } });
  const result = await explorer.search(cwd);
  if (!result) return { config: defaultConfig() };
  return { config: parseConfig(result.config), filepath: result.filepath };
}
