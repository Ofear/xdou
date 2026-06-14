export interface MissionCheck {
  status: 'passed' | 'failed' | 'skipped';
  expectedSymbols: string[];
  missingSymbols: string[];
  message: string;
}

const IGNORED_SYMBOLS = new Set(['add', 'update', 'print', 'test', 'run', 'export', 'import']);

export function expectedSymbolsFromMission(mission: string): string[] {
  const symbols = new Set<string>();
  for (const match of mission.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
    const symbol = match[1];
    if (symbol && !IGNORED_SYMBOLS.has(symbol.toLowerCase())) symbols.add(symbol);
  }
  return [...symbols];
}

// Only the lines a change actually adds (`+`, excluding the `+++` file header) count as evidence a
// symbol was implemented — so a symbol that merely appears in surrounding context or a removed line
// can't falsely satisfy the gate.
function addedLines(diff: string): string {
  return diff.split(/\r?\n/).filter((line) => line.startsWith('+') && !line.startsWith('+++')).join('\n');
}

export function checkMissionCompletion(mission: string, diff: string): MissionCheck {
  const expectedSymbols = expectedSymbolsFromMission(mission);
  const effectiveDiff = diff.trim() === 'No diff produced.' ? '' : diff;
  const added = addedLines(effectiveDiff);
  if (!expectedSymbols.length) {
    return { status: effectiveDiff.trim() ? 'passed' : 'skipped', expectedSymbols, missingSymbols: [], message: effectiveDiff.trim() ? 'No explicit function symbols found in mission; non-empty diff produced.' : 'No explicit function symbols found in mission.' };
  }
  const missingSymbols = expectedSymbols.filter((symbol) => !new RegExp(`\\b${escapeRegExp(symbol)}\\b`).test(added));
  return {
    status: missingSymbols.length ? 'failed' : 'passed',
    expectedSymbols,
    missingSymbols,
    message: missingSymbols.length ? `Produced diff is missing mission symbol(s): ${missingSymbols.join(', ')}` : 'Produced diff contains all explicit mission symbols.',
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
