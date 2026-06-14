import { describe, expect, it } from 'vitest';
import { checkMissionCompletion } from '../src/core/mission-check.js';

describe('mission completion check', () => {
  it('only credits a symbol that appears on an ADDED line, not in context', () => {
    // parseFoo is present but only in an unchanged context line (space-prefixed) and a removed line.
    const contextOnly = [
      'diff --git a/x.ts b/x.ts',
      '@@ -1,3 +1,3 @@',
      ' const a = parseFoo();   // existing call, not added',
      '-const b = 1;',
      '+const b = 2;',
    ].join('\n');
    expect(checkMissionCompletion('add parseFoo()', contextOnly).status).toBe('failed');

    const added = [
      'diff --git a/x.ts b/x.ts',
      '@@ -0,0 +1,1 @@',
      '+function parseFoo() { return 1; }',
    ].join('\n');
    expect(checkMissionCompletion('add parseFoo()', added).status).toBe('passed');
  });

  it('does not credit a symbol that only appears in the diff --git header', () => {
    const headerOnly = ['diff --git a/parseFoo.ts b/parseFoo.ts', 'new file mode 100644', 'index 0000000..e69de29'].join('\n');
    expect(checkMissionCompletion('add parseFoo()', headerOnly).status).toBe('failed');
  });
});
