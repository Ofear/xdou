export function shouldAnswerAskLocally(prompt: string): boolean {
  const normalized = prompt.trim().toLowerCase().replace(/[.!?]+$/g, '');
  if (!normalized) return true;
  return /^(hi|hello|hey|yo|thanks|thank you|thx|ok|okay)$/.test(normalized);
}
