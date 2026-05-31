import { describe, expect, it } from 'vitest';
import { defaultAgents } from '../src/agents/registry.js';

describe('agent registry', () => {
  it('adds configured OpenRouter agents without replacing built-ins', async () => {
    const agents = defaultAgents({
      gptcritic: { type: 'openrouter', model: 'openai/gpt-4o-mini', roles: ['critic'] },
    });
    expect(agents.claude).toBeDefined();
    expect(agents.codex).toBeDefined();
    expect(agents.gptcritic?.type).toBe('openrouter');
    const detection = await agents.gptcritic?.detect();
    expect(detection?.available).toBe(Boolean(process.env.OPENROUTER_API_KEY));
  });

  it('rejects configured agent ids that could escape artifact paths', () => {
    expect(() => defaultAgents({ '../evil': { type: 'openrouter', model: 'x/y' } })).toThrow(/Invalid agent id/);
  });
});
