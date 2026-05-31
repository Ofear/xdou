import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config/schema.js';

describe('config schema', () => {
  it('applies production defaults and accepts configured agents', () => {
    const config = parseConfig({
      agents: {
        claude: { type: 'claude-code', command: 'claude', roles: ['architect', 'reviewer'] },
      },
      teams: { default: { brainstormers: ['claude'], implementer: 'codex', reviewer: ['claude'] } },
    });
    expect(config.artifactDir).toBe('.xdou');
    expect(config.agents.claude?.type).toBe('claude-code');
  });
});
