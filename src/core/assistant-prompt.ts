// One turn of the cockpit conversation (mirrors the cockpit's ConversationEntry, kept local to avoid
// a core -> tui dependency).
export interface AssistantTurn { author: string; text: string; mine?: boolean }

// Hard cap on the verbatim transcript fed to the agent, in characters (~roughly a few thousand
// tokens). Older turns beyond this are dropped — the auto-summary preserves their gist.
export const CONTEXT_CHAR_BUDGET = 8000;

// Approximate size of a turn when serialized into the transcript.
function turnSize(turn: AssistantTurn): number { return turn.text.length + turn.author.length + 4; }

export function turnChars(turns: AssistantTurn[]): number {
  return turns.reduce((total, turn) => total + turnSize(turn), 0);
}

// Keep the most recent turns that fit within `budgetChars`, dropping the oldest first.
export function capHistory(turns: AssistantTurn[], budgetChars: number = CONTEXT_CHAR_BUDGET): AssistantTurn[] {
  const kept: AssistantTurn[] = [];
  let total = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if (!turn) continue;
    const size = turnSize(turn);
    if (total + size > budgetChars && kept.length) break;
    total += size;
    kept.unshift(turn);
  }
  return kept;
}

function transcriptOf(turns: AssistantTurn[]): string {
  return turns
    .filter((entry) => entry.author !== 'system' && entry.text.trim())
    .map((entry) => `${entry.mine ? 'User' : entry.author}: ${entry.text}`)
    .join('\n\n');
}

// Build the assistant prompt with a summary of earlier conversation + the recent verbatim transcript
// (auto-capped) prepended, so the agent (a stateless CLI invocation) has bounded session memory.
export function buildAssistantPrompt(cwd: string, prompt: string, history: AssistantTurn[] = [], summary = ''): string {
  const transcript = transcriptOf(capHistory(history));
  const summaryBlock = summary.trim() ? `Summary of earlier conversation:\n${summary.trim()}\n\n` : '';
  const contextBlock = transcript ? `Recent conversation (most recent last):\n${transcript}\n\n` : '';
  return `You are the xdou cockpit assistant. Answer directly and concisely. Do not modify files unless explicitly asked. Current folder: ${cwd}\n\n${summaryBlock}${contextBlock}Reply to the user's latest message:\n${prompt}`;
}

// Strict research prompt: the agent must use its web tools, must not fabricate, and must declare
// whether it actually searched (parsed back out via parseWebProvenance).
export function buildWebSearchPrompt(query: string, history: AssistantTurn[] = [], summary = ''): string {
  const transcript = transcriptOf(capHistory(history));
  const summaryBlock = summary.trim() ? `Summary of earlier conversation:\n${summary.trim()}\n\n` : '';
  const contextBlock = transcript ? `Recent conversation (most recent last):\n${transcript}\n\n` : '';
  return [
    'You are the xdou research assistant. Answer with CURRENT information from the web.',
    '',
    'Rules:',
    '- Use your WebSearch/WebFetch tools to find and open real sources. Base every fact on a page you actually opened.',
    "- Do NOT invent or guess prices, dates, times, statistics, or URLs. If you didn't open a page, don't cite it.",
    '- Cite sources as markdown links to the exact URLs you opened.',
    '- If you cannot access the web, do NOT fabricate a live answer — say so plainly, then give general background clearly labeled as not live.',
    '',
    'After the answer, output EXACTLY ONE final line on its own:',
    '[[WEB_USED:yes]] if you actually searched/fetched the web for this answer, or [[WEB_USED:no]] if you answered from memory.',
    '',
    summaryBlock + contextBlock + `Question: ${query}`,
  ].join('\n');
}

// Pull the provenance marker out of a research answer. Returns whether the web was used (undefined if
// the agent didn't emit a marker) and the answer text with the marker line stripped.
export function parseWebProvenance(text: string): { used: boolean | undefined; clean: string } {
  // Only honor the marker as the final token, so a marker quoted inside the answer body can't flip
  // the banner or get scrubbed from legitimate content.
  const match = text.match(/\s*\[\[WEB_USED:\s*(yes|no)\s*\]\]\s*$/i);
  if (!match) return { used: undefined, clean: text.trim() };
  return { used: match[1]?.toLowerCase() === 'yes', clean: text.slice(0, match.index).trim() };
}

// Prompt that asks an agent to compress the conversation into a compact, fact-preserving briefing.
export function buildSummaryPrompt(priorSummary: string, turns: AssistantTurn[]): string {
  const prior = priorSummary.trim() ? `Existing summary to extend (fold the new turns into it):\n${priorSummary.trim()}\n\n` : '';
  return `Summarize the following conversation into a compact briefing (<= 200 words). Preserve facts, decisions, names, file paths, numbers, and open questions. Output only the summary, no preamble.\n\n${prior}Conversation:\n${transcriptOf(turns)}`;
}
