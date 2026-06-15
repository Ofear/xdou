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
  return `You are the xdou cockpit assistant. Answer directly and concisely. Do not modify files unless explicitly asked. Current folder: ${cwd}

This is a SINGLE synchronous turn: whatever you produce now is the complete, final reply shown to the user — there is no background processing and no later turn. Therefore:
- NEVER claim work is "running"/"in progress" or that you will "compile results", "report back", or "follow up" later. You cannot run other agents (codex/claude) or background tasks from here.
- Do the work now and give the actual answer in this reply. If it genuinely needs the multi-agent pipeline (e.g. "review the whole codebase with codex and claude"), say so plainly and tell the user to run it as a mission: /code <task> or /plan <task>. Do not pretend to orchestrate agents yourself.

${summaryBlock}${contextBlock}Reply to the user's latest message:\n${prompt}`;
}

// Read-only codebase analysis prompt: the agent reads the project and reports concrete findings for
// `request` (e.g. "find possible bugs") WITHOUT modifying anything. Used by the auto-routed review path.
export function buildReviewPrompt(cwd: string, request: string): string {
  return [
    `You are reviewing the software project at ${cwd}.`,
    `Task: ${request}`,
    '',
    'Rules:',
    '- READ-ONLY: inspect files with your read/search tools. Do NOT modify, create, or delete any files.',
    '- Base every finding on code you actually read — cite file paths and line numbers. Do not speculate or invent issues.',
    '- Report concrete, actionable findings. For each: what & where (file:line), why it is a problem, and a suggested fix.',
    '- If you find nothing notable in an area, say so rather than padding.',
    '- This is a single synchronous turn: produce the complete findings now. Do not claim work is still running or that you will follow up later.',
    '',
    'Format: a short summary line, then a markdown list of findings ordered by severity.',
  ].join('\n');
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
    '- Search snippets are second-hand and often stale, cached, or mislabeled. Do NOT answer from snippets alone.',
    '- For any volatile or precise value (stock/crypto price, score, exchange rate, weather, release date, version, statistic), open the SINGLE most authoritative primary source with WebFetch and read the value off that page. Examples: a finance quote page (e.g. Google Finance) for prices, the official release/changelog for versions.',
    '- Always report the value WITH its timestamp/as-of from the page (e.g. "last close Fri Jun 12, 4:00pm ET"). If the live market/source is closed or the figure is not live, say so and give the last known value with its time.',
    "- If snippets conflict, do NOT refuse and do NOT pick one arbitrarily — resolve it by opening one authoritative page and trusting that timestamped value. Only state you can't get a clear answer after actually trying to fetch a primary source and failing.",
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
