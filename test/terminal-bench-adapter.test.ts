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
    expect(adapter).toContain('base64');
    expect(adapter).toContain('set +e');
    expect(adapter).toContain('"XDOU_CODEX_AUTH_JSON_B64"');
    expect(adapter).toContain('"XDOU_CLAUDE_CREDENTIALS_JSON_B64"');
    expect(adapter).toContain('"XDOU_CLAUDE_JSON_B64"');
    expect(adapter).toContain('"XDOU_INSTALL_FULL"');
    expect(adapter).toContain('/tmp/xdou-instruction.txt');
    expect(adapter).toContain('/installed-agent/xdou-run-task.sh');
    expect(adapter).not.toContain('xdou run');
    expect(adapter).not.toContain('xdou apply');
    expect(adapter).not.toContain('set -euo pipefail');
    expect(setup).toContain('XDOU_INSTALL_FULL');
    expect(setup).toContain('npm install -g @ofear/xdou@{{ version }}');
    expect(setup).toContain('@openai/codex');
    expect(setup).toContain('@anthropic-ai/claude-code');
    expect(setup).toContain('XDOU_CODEX_AUTH_JSON_B64');
    expect(setup).toContain('XDOU_CLAUDE_CREDENTIALS_JSON_B64');
    expect(setup).toContain('XDOU_CLAUDE_JSON_B64');
    expect(setup).toContain('base64 -d > "$HOME/.codex/auth.json"');
    expect(setup).toContain("cat > /installed-agent/xdou-run-task.sh <<'SH'");
    expect(setup).toContain('deterministic-answer-file-42');
    expect(setup).toContain('deterministic-csv-to-parquet');
    expect(setup).toContain('python3-pip');
    expect(pkg.files).toContain('terminal-bench/xdou_agent.py');
  });
});
