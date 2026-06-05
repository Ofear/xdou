import { describe, expect, it } from 'vitest';
import { extractReviewVerdict, reviewVerdictBlocks } from '../src/core/review-verdict.js';

describe('structured review verdicts', () => {
  it('extracts semantic reviewer verdict JSON embedded in markdown', () => {
    const verdict = extractReviewVerdict(`Summary\n\nREVIEW_VERDICT:\n{\n  "verdict": "request_changes",\n  "confidence": 0.91,\n  "reason": "divide returns multiplication",\n  "missingRequirements": ["correct divide behavior"]\n}\n`);

    expect(verdict).toEqual({
      verdict: 'request_changes',
      confidence: 0.91,
      reason: 'divide returns multiplication',
      missingRequirements: ['correct divide behavior'],
    });
    expect(reviewVerdictBlocks(verdict)).toBe(true);
  });

  it('extracts verdicts from JSON agent envelopes before scanning raw escaped output', () => {
    const envelope = JSON.stringify({
      type: 'result',
      result: 'Verified on disk.\n\nREVIEW_VERDICT:\n{"verdict":"approve","confidence":0.97,"reason":"verified green","missingRequirements":[]}',
    });

    const verdict = extractReviewVerdict(envelope);

    expect(verdict).toEqual({
      verdict: 'approve',
      confidence: 0.97,
      reason: 'verified green',
      missingRequirements: [],
    });
    expect(reviewVerdictBlocks(verdict)).toBe(false);
  });

  it('treats malformed or absent verdicts as blocking semantic review failures', () => {
    const verdict = extractReviewVerdict('Looks fine, no machine verdict.');

    expect(verdict.verdict).toBe('blocked');
    expect(verdict.reason).toContain('missing REVIEW_VERDICT');
    expect(reviewVerdictBlocks(verdict)).toBe(true);
  });
});
