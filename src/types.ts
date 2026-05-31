export type AgentRole = 'brainstormer' | 'architect' | 'critic' | 'implementer' | 'reviewer' | 'fixer' | 'tester' | 'debugger' | 'security' | 'docs';
export type AgentType = 'claude-code' | 'codex' | 'opencode' | 'openrouter';
export type ContextBudget = 'minimal' | 'balanced' | 'full';
export type RunStatus = 'created' | 'running' | 'blocked' | 'failed' | 'completed' | 'aborted';

export interface TaskSpec { id: string; title: string; objective: string; files?: string[]; validation?: string[] }
export interface ValidationResult { command: string; status: 'passed' | 'failed' | 'skipped'; output: string; exitCode?: number }
export interface AgentInput { cwd: string; prompt: string; runDir: string; timeoutMs?: number }
export interface AgentInvocation { command: string; args: string[]; cwd: string; shell: false; env?: Record<string,string>; stdin?: string }
export interface AgentRunResult { agent: string; command: string; args: string[]; exitCode: number; stdout: string; stderr: string; durationMs: number; ok: boolean }
export interface AgentAdapter { id: string; type: AgentType; roles: AgentRole[]; buildInvocation(input: AgentInput): AgentInvocation; detect(): Promise<{available: boolean; path?: string; version?: string; error?: string}>; run(input: AgentInput): Promise<AgentRunResult> }

export interface RunManifest { id: string; mission: string; createdAt: string; updatedAt: string; status: RunStatus; phase: string; artifactDir: string; events: number; worktreePath?: string; baseRef?: string; fixAttempts?: number; processPid?: number; abortedReason?: string; appliedAt?: string }
