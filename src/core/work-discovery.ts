import { execa } from 'execa';
import { execaSync } from 'execa';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { McpTool } from './mcp-plugins.js';

export interface DiscoveredWork {
  source: 'github' | 'ci' | 'git' | 'todo' | 'mcp';
  title: string;
  description: string;
  priority: 'high' | 'medium' | 'low';
  suggestedMission: string;
  metadata: Record<string, unknown>;
}

export interface WorkDiscoveryConfig {
  cwd: string;
  github?: {
    owner?: string;
    repo?: string;
    labels?: string[];
  };
  ci?: {
    provider?: 'github' | 'gitlab' | 'custom';
    owner?: string;
    repo?: string;
  };
  todoFiles?: string[];
  mcpTools?: McpTool[];
}

function detectGitHubRepo(cwd: string): { owner: string; repo: string } | null {
  try {
     
    const result = execaSync('git', ['config', '--get', 'remote.origin.url'], { cwd });
    const url = result.stdout.trim();
    const match = url.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
    if (match) return { owner: match[1]!, repo: match[2]! };
  } catch { /* ignore */ }
  return null;
}

async function discoverGitHubIssues(cwd: string, config: WorkDiscoveryConfig['github']): Promise<DiscoveredWork[]> {
  const owner = config?.owner;
  const repoName = config?.repo;
  const repo = owner && repoName ? { owner, repo: repoName } : detectGitHubRepo(cwd);
  if (!repo) return [];

  const labels = config?.labels ?? ['xdou:loop', 'good first issue', 'bug', 'enhancement'];
  const labelFilter = labels.map((l) => `--label="${l}"`).join(' ');
  try {
    const result = await execa('gh', ['issue', 'list', '--state=open', '--json=number,title,body,labels,assignees', labelFilter, '--repo', `${repo.owner}/${repo.repo}`], { cwd, reject: false });
    if (result.exitCode !== 0) return [];
    const issues = JSON.parse(result.stdout) as Array<{
      number: number;
      title: string;
      body: string | null;
      labels: Array<{ name: string }> | null;
      assignees: Array<{ login: string }> | null;
    }>;
    return issues.map((issue) => ({
      source: 'github' as const,
      title: `GitHub Issue #${issue.number}: ${issue.title}`,
      description: issue.body ?? '',
      priority: issue.labels?.some((l: { name: string }) => l.name === 'bug' || l.name === 'xdou:loop') ? 'high' : 'medium',
      suggestedMission: `Address GitHub issue #${issue.number}: ${issue.title}. ${issue.body ?? ''}`,
      metadata: {
        issueNumber: issue.number,
        labels: issue.labels?.map((l: { name: string }) => l.name) ?? [],
        assignees: issue.assignees?.map((a: { login: string }) => a.login) ?? [],
        repo,
      },
    }));
  } catch {
    return [];
  }
}

async function discoverCIFailures(cwd: string, config: WorkDiscoveryConfig['ci']): Promise<DiscoveredWork[]> {
  const owner = config?.owner;
  const repoName = config?.repo;
  const repo = owner && repoName ? { owner, repo: repoName } : detectGitHubRepo(cwd);
  if (!repo) return [];

  try {
    const result = await execa('gh', ['run', 'list', '--limit=20', '--json=conclusion,headBranch,headSha,displayTitle,url', '--repo', `${repo.owner}/${repo.repo}`], { cwd, reject: false });
    if (result.exitCode !== 0) return [];
    const runs = JSON.parse(result.stdout) as Array<{ conclusion: string; displayTitle: string; headBranch: string; headSha: string; url: string }>;
    const failedRuns = runs.filter((run) => run.conclusion === 'failure');
    return failedRuns.slice(0, 5).map((run) => ({
      source: 'ci' as const,
      title: `CI Failure: ${run.displayTitle}`,
      description: `GitHub Actions workflow failed on branch ${run.headBranch}`,
      priority: 'high',
      suggestedMission: `Investigate and fix CI failure in workflow "${run.displayTitle}" on branch ${run.headBranch}. See ${run.url}`,
      metadata: { runUrl: run.url, branch: run.headBranch, sha: run.headSha, repo },
    }));
  } catch {
    return [];
  }
}

function discoverGitChanges(cwd: string): Promise<DiscoveredWork[]> {
  const works: DiscoveredWork[] = [];

  try {
    const status = execaSync('git', ['status', '--porcelain'], { cwd });
    if (status.stdout.trim()) {
      const files = status.stdout.trim().split('\n').map((line) => line.slice(3)).filter(Boolean);
      works.push({
        source: 'git',
        title: `Uncommitted changes (${files.length} file${files.length !== 1 ? 's' : ''})`,
        description: `Working tree has uncommitted changes: ${files.join(', ')}`,
        priority: 'medium',
        suggestedMission: `Review and commit or stash uncommitted changes. Files: ${files.join(', ')}`,
        metadata: { files, type: 'uncommitted' },
      });
    }
  } catch { /* ignore */ }

  try {
    const unpushed = execaSync('git', ['log', '--oneline', '@{u}..HEAD'], { cwd, reject: false });
    if (unpushed.exitCode === 0 && unpushed.stdout.trim()) {
      const commits = unpushed.stdout.trim().split('\n').filter(Boolean);
      works.push({
        source: 'git',
        title: `Unpushed commits (${commits.length})`,
        description: `Local commits not pushed to remote: ${commits.slice(0, 3).join('; ')}${commits.length > 3 ? '...' : ''}`,
        priority: 'low',
        suggestedMission: `Push unpushed commits to remote or create PRs. Commits: ${commits.join('; ')}`,
        metadata: { commits, type: 'unpushed' },
      });
    }
  } catch { /* ignore */ }

  try {
    const behind = execaSync('git', ['rev-list', '--count', 'HEAD..@{u}'], { cwd, reject: false });
    if (behind.exitCode === 0) {
      const count = Number(behind.stdout.trim());
      if (count > 0) {
        works.push({
          source: 'git',
          title: `Branch behind remote (${count} commits)`,
          description: `Local branch is behind upstream by ${count} commit${count !== 1 ? 's' : ''}`,
          priority: 'low',
          suggestedMission: `Pull latest changes from remote and rebase/merge. Local branch is ${count} commit${count !== 1 ? 's' : ''} behind.`,
          metadata: { behindCount: count, type: 'behind' },
        });
      }
    }
  } catch { /* ignore */ }

   
  return Promise.resolve(works);
}

async function discoverTodoFiles(cwd: string, todoFiles: string[] = ['TODO.md', 'xdou-tasks.md', '.xdou/loop-tasks.md']): Promise<DiscoveredWork[]> {
  const works: DiscoveredWork[] = [];

  for (const file of todoFiles) {
    const filePath = join(cwd, file);
    try {
      const content = await readFile(filePath, 'utf8');
      const lines = content.split('\n');  
      let inTaskSection = false;
      for (const line of lines) {
        const trimmed = line.trim();
        if (/^#+\s*(tasks|todos|work|loop\s*tasks)/i.test(trimmed)) {
          inTaskSection = true;
          continue;
        }
        if (inTaskSection && /^#+/.test(trimmed)) break;
        const taskMatch = trimmed.match(/^[-*]\s*\[(?: |x)\]\s*(.+)$/i) || trimmed.match(/^[-*]\s*(.+)$/);
        if (taskMatch && inTaskSection) {
           
          const task: string = taskMatch[1]!.trim();
          const done = /\[x\]/i.test(trimmed);
          if (!done) {
             
            works.push({
              source: 'todo',
              title: `Task from ${file}: ${task.slice(0, 60)}`,
              description: task,
              priority: 'medium',
              suggestedMission: `Complete task from ${file}: ${task}`,
              metadata: { sourceFile: file, task },
            });
          }
        }
      }
    } catch { /* ignore */ }
  }

   
  return works;
}

function discoverMcpWork(cwd: string, tools: McpTool[]): Promise<DiscoveredWork[]> {
  const works: DiscoveredWork[] = [];

  for (const tool of tools) {
     
    if (!tool.name.startsWith('discover') && !tool.name.startsWith('list') && !tool.name.startsWith('get')) continue;
    try {
      // Note: In practice, you'd call the actual MCP tool here.
      // This is a placeholder for the interface.
      console.log(`[work-discovery] MCP tool ${tool.name} available for work discovery`);
    } catch { /* ignore */ }
  }

  return Promise.resolve(works);
}

export async function discoverAllWork(config: WorkDiscoveryConfig): Promise<DiscoveredWork[]> {
  const [github, ci, git, todo, mcp] = await Promise.all([
    discoverGitHubIssues(config.cwd, config.github),
    discoverCIFailures(config.cwd, config.ci),
    discoverGitChanges(config.cwd),
    discoverTodoFiles(config.cwd, config.todoFiles),
    discoverMcpWork(config.cwd, config.mcpTools ?? []),
  ]);

  const all = [...github, ...ci, ...git, ...todo, ...mcp];

  // Sort by priority (high first), then by source priority
  const priorityOrder = { high: 0, medium: 1, low: 2 };
  const sourceOrder = { ci: 0, github: 1, git: 2, todo: 3, mcp: 4 };

  all.sort((a, b) => {
    const pDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
    if (pDiff !== 0) return pDiff;
    return sourceOrder[a.source] - sourceOrder[b.source];
  });

  return all;
}

export function formatWorkForPrompt(works: DiscoveredWork[], maxItems = 5): string {
  if (!works.length) return 'No discoverable work found. Project appears healthy.';

  const lines = works.slice(0, maxItems).map((work, index) => {
    const priority = work.priority.toUpperCase();
    return `${index + 1}. [${work.source}/${priority}] ${work.title}\n   ${work.description.slice(0, 160)}${work.description.length > 160 ? '...' : ''}\n   Suggested: ${work.suggestedMission.slice(0, 200)}`;
  });

  if (works.length > maxItems) {
    lines.push(`... and ${works.length - maxItems} more items.`);
  }

  return `DISCOVERED WORK (${works.length} item${works.length !== 1 ? 's' : ''}):\n\n${lines.join('\n\n')}\n\n---\nChoose ONE item to work on, or respond with "none" if no action is needed.`;
}

export { detectGitHubRepo };