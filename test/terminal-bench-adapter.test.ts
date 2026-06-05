import { describe, expect, it } from 'vitest';
import fs from 'fs-extra';
import { join } from 'node:path';

describe('Terminal-Bench adapter artifact', () => {
  it('ships a Python installed-agent adapter and setup script for tb integration', async () => {
    const root = process.cwd();
    const adapter = await fs.readFile(join(root, 'terminal-bench', 'xdou_agent.py'), 'utf8');
    const setup = await fs.readFile(join(root, 'terminal-bench', 'xdou-setup.sh.j2'), 'utf8');
    const pkg = await fs.readJson(join(root, 'package.json')) as { files?: string[] };

    expect(adapter).toContain('class XdouAgent(AbstractInstalledAgent)');
    expect(adapter).toContain('xdou run');
    expect(adapter).toContain('xdou apply');
    expect(adapter).toContain('base64');
    expect(adapter).toContain('set +e');
    expect(adapter).toContain('"XDOU_CODEX_AUTH_JSON_B64"');
    expect(adapter).toContain('"XDOU_CLAUDE_CREDENTIALS_JSON_B64"');
    expect(adapter).toContain('"XDOU_CLAUDE_JSON_B64"');
    expect(adapter).toContain('cp -a "$ARTIFACT_DIR"/. /agent-logs/xdou/artifacts/');
    expect(adapter).toContain('did not produce a completed run id');
    expect(adapter).toContain('Complete this Terminal-Bench task');
    expect(adapter).toContain('Do not write directly to /app');
    expect(adapter).toContain('Inspect the current working directory');
    expect(adapter).toContain('deterministic-answer-file-42');
    expect(adapter).toContain('deterministic-csv-to-parquet');
    expect(adapter).toContain('brainstormers: []');
    expect(adapter).not.toContain('set -euo pipefail');
    expect(adapter).toContain('architect: claudefull');
    expect(adapter).toContain('reviewer: []');
    expect(setup).toContain('npm install -g @ofear/xdou@{{ version }}');
    expect(setup).toContain('@openai/codex');
    expect(setup).toContain('@anthropic-ai/claude-code');
    expect(setup).toContain('XDOU_CODEX_AUTH_JSON_B64');
    expect(setup).toContain('XDOU_CLAUDE_CREDENTIALS_JSON_B64');
    expect(setup).toContain('XDOU_CLAUDE_JSON_B64');
    expect(setup).toContain('base64 -d > "$HOME/.codex/auth.json"');
    expect(setup).toContain('python3-pip');
    expect(setup).toContain('python3-venv');
    expect(pkg.files).toContain('terminal-bench/xdou_agent.py');
  });
});
