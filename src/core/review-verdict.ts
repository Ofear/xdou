export type ReviewDecision = 'approve' | 'request_changes' | 'blocked';

export interface ReviewVerdict {
  verdict: ReviewDecision;
  confidence: number;
  reason: string;
  missingRequirements: string[];
}

export function extractReviewVerdict(output: string): ReviewVerdict {
  const normalizedOutput = normalizeAgentOutput(output);
  const marker = /REVIEW_VERDICT\s*:/i.exec(normalizedOutput);
  if (!marker) return blockedVerdict('Reviewer output missing REVIEW_VERDICT JSON block.');

  const tail = normalizedOutput.slice(marker.index + marker[0].length).trim();
  const json = extractFirstJsonObject(tail);
  if (!json) return blockedVerdict('Reviewer output has REVIEW_VERDICT marker but no JSON object.');

  try {
    const parsed = JSON.parse(json) as Partial<ReviewVerdict>;
    if (!isReviewDecision(parsed.verdict)) return blockedVerdict('Reviewer verdict must be approve, request_changes, or blocked.');
    return {
      verdict: parsed.verdict,
      confidence: clampConfidence(parsed.confidence),
      reason: typeof parsed.reason === 'string' && parsed.reason.trim() ? parsed.reason : 'No reason provided.',
      missingRequirements: Array.isArray(parsed.missingRequirements) ? parsed.missingRequirements.filter((item): item is string => typeof item === 'string') : [],
    };
  } catch (error) {
    return blockedVerdict(`Reviewer verdict JSON could not be parsed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function reviewVerdictBlocks(verdict: ReviewVerdict): boolean {
  return verdict.verdict === 'request_changes' || verdict.verdict === 'blocked';
}

function blockedVerdict(reason: string): ReviewVerdict {
  return { verdict: 'blocked', confidence: 1, reason, missingRequirements: ['structured semantic review verdict'] };
}

function isReviewDecision(value: unknown): value is ReviewDecision {
  return value === 'approve' || value === 'request_changes' || value === 'blocked';
}

function clampConfidence(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

function normalizeAgentOutput(output: string): string {
  const trimmed = output.trim();
  if (!trimmed.startsWith('{')) return output;

  try {
    const parsed = JSON.parse(trimmed) as { result?: unknown; message?: unknown; content?: unknown };
    for (const value of [parsed.result, parsed.message, parsed.content]) {
      if (typeof value === 'string' && /REVIEW_VERDICT\s*:/i.test(value)) return value;
    }
  } catch {
    return output;
  }

  return output;
}

export function extractFirstJsonObject(text: string): string | undefined {
  const start = text.indexOf('{');
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) { escaped = false; continue; }
    if (char === '\\') { escaped = true; continue; }
    if (char === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return undefined;
}
