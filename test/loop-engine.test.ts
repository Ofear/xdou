import { describe, expect, it } from 'vitest';
import { temporaryDirectory } from 'tempy';
import { LoopEngine, isCronExpression, nextCronTime, parseCadence } from '../src/core/loop-engine.js';
import type { GoalEvaluation, LoopHooks, TickRun } from '../src/core/loop-engine.js';

function passingHooks(overrides: Partial<LoopHooks> = {}): LoopHooks {
  return {
    runMission: (): Promise<TickRun> => Promise.resolve({ runId: '20260101000000-aaaaaaaa', status: 'completed', ok: true }),
    ...overrides,
  };
}

describe('parseCadence', () => {
  it('parses named cadences', () => {
    expect(parseCadence('hourly').intervalMs).toBe(3_600_000);
    expect(parseCadence('daily').intervalMs).toBe(86_400_000);
    expect(parseCadence('WEEKLY').intervalMs).toBe(604_800_000);
  });

  it('parses interval shorthands', () => {
    expect(parseCadence('30s').intervalMs).toBe(30_000);
    expect(parseCadence('5m').intervalMs).toBe(300_000);
    expect(parseCadence('2h').intervalMs).toBe(7_200_000);
    expect(parseCadence('1d').intervalMs).toBe(86_400_000);
  });

  it('detects cron expressions', () => {
    const parsed = parseCadence('*/30 * * * *');
    expect(parsed.cron).toBe('*/30 * * * *');
    expect(parsed.intervalMs).toBeUndefined();
  });

  it('rejects unrecognized cadences', () => {
    expect(() => parseCadence('whenever')).toThrow(/Unrecognized cadence/);
  });
});

describe('cron evaluation', () => {
  it('validates five-field expressions', () => {
    expect(isCronExpression('*/30 * * * *')).toBe(true);
    expect(isCronExpression('0 9 * * 1-5')).toBe(true);
    expect(isCronExpression('not cron')).toBe(false);
    expect(isCronExpression('* * * *')).toBe(false);
    expect(isCronExpression('99 * * * *')).toBe(false);
  });

  it('computes the next matching minute', () => {
    const next = nextCronTime('*/30 * * * *', new Date(2026, 0, 1, 0, 10, 0));
    expect(next.getHours()).toBe(0);
    expect(next.getMinutes()).toBe(30);
  });

  it('rolls to the next hour boundary', () => {
    const next = nextCronTime('0 * * * *', new Date(2026, 0, 1, 0, 10, 0));
    expect(next.getHours()).toBe(1);
    expect(next.getMinutes()).toBe(0);
  });
});

describe('LoopEngine lifecycle', () => {
  it('starts an inline loop without spawning a daemon', async () => {
    const engine = new LoopEngine({ cwd: temporaryDirectory(), hooks: passingHooks() });
    const loop = await engine.startLoop({ mode: 'loop', cadence: 'hourly', prompt: 'triage issues', detached: false });
    expect(loop.status).toBe('running');
    expect(loop.pid).toBeUndefined();
    expect(loop.intervalMs).toBe(3_600_000);
    expect(await engine.listLoops()).toHaveLength(1);
  });

  it('advances ticks and schedules the next run', async () => {
    const engine = new LoopEngine({ cwd: temporaryDirectory(), hooks: passingHooks() });
    const loop = await engine.startLoop({ mode: 'loop', cadence: '30m', prompt: 'do work', detached: false });
    const after = await engine.runTick(loop.id);
    expect(after.ticks).toBe(1);
    expect(after.lastRunId).toBe('20260101000000-aaaaaaaa');
    expect(Date.parse(after.nextRunAt)).toBeGreaterThan(Date.parse(loop.createdAt));
  });

  it('pauses, resumes, and stops a loop', async () => {
    const engine = new LoopEngine({ cwd: temporaryDirectory(), hooks: passingHooks() });
    const loop = await engine.startLoop({ mode: 'loop', cadence: 'hourly', prompt: 'x', detached: false });
    expect((await engine.pauseLoop(loop.id)).status).toBe('paused');
    expect((await engine.resumeLoop(loop.id)).status).toBe('running');
    expect((await engine.stopLoop(loop.id)).status).toBe('stopped');
  });

  it('completes a goal loop when the checker reports satisfied', async () => {
    const evaluation: GoalEvaluation = { satisfied: true, evidence: 'all green', confidence: 1 };
    const engine = new LoopEngine({
      cwd: temporaryDirectory(),
      hooks: passingHooks({ evaluateGoal: (): Promise<GoalEvaluation> => Promise.resolve(evaluation) }),
    });
    const loop = await engine.startLoop({ mode: 'goal', condition: 'all tests pass', prompt: 'reach the goal', intervalMs: 0, detached: false });
    const after = await engine.runTick(loop.id);
    expect(after.status).toBe('completed');
    expect(after.completedReason).toBe('all green');
  });

  it('keeps cycling a goal loop until satisfied, capped by maxTicks', async () => {
    let attempts = 0;
    const engine = new LoopEngine({
      cwd: temporaryDirectory(),
      hooks: passingHooks({ evaluateGoal: (): Promise<GoalEvaluation> => { attempts += 1; return Promise.resolve({ satisfied: false, evidence: 'still failing', confidence: 0.5 }); } }),
    });
    const loop = await engine.startLoop({ mode: 'goal', condition: 'impossible', prompt: 'try', intervalMs: 0, maxTicks: 2, detached: false });
    await engine.runTick(loop.id);
    const final = await engine.runTick(loop.id);
    expect(attempts).toBe(2);
    expect(final.status).toBe('completed');
    expect(final.completedReason).toContain('maxTicks=2');
  });

  it('records logs and rejects unknown loop ids', async () => {
    const engine = new LoopEngine({ cwd: temporaryDirectory(), hooks: passingHooks() });
    const loop = await engine.startLoop({ mode: 'loop', cadence: 'hourly', prompt: 'log me', detached: false });
    expect(await engine.readLogs(loop.id)).toContain('created mode=loop');
    await expect(engine.getLoopStatus('20990101000000-deadbeef')).rejects.toThrow(/not found/);
    await expect(engine.getLoopStatus('../escape')).rejects.toThrow(/Invalid loop id/);
  });
});
