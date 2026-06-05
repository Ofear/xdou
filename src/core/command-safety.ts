const unsafePatterns: Array<[RegExp, string]> = [
  [/\brm\s+(-[\w-]*r[\w-]*f|-[-\w]*f[-\w]*r)\b/i, 'rm -rf'],
  [/\bgit\s+reset\s+--hard\b/i, 'git reset --hard'],
  [/\bgit\s+clean\b/i, 'git clean'],
  [/\bgit\s+push\b/i, 'git push'],
  [/\bshutdown\b|\breboot\b/i, 'system shutdown'],
  [/\b(?:curl|wget)\b[\s\S]*\|\s*(?:sh|bash|zsh|fish|powershell|pwsh)\b/i, 'pipe-to-shell'],
  [/>\s*\/(?:etc|usr|bin|sbin|boot)\b/i, 'system path overwrite'],
];

export function detectUnsafeShellCommand(command: string): string | undefined {
  const normalized = command.replace(/\s+/g, ' ').trim();
  return unsafePatterns.find(([pattern]) => pattern.test(normalized))?.[1];
}

export function assertSafeShellCommand(command: string): void {
  const reason = detectUnsafeShellCommand(command);
  if (reason) throw new Error(`Blocked unsafe command (${reason}): ${command}`);
}
