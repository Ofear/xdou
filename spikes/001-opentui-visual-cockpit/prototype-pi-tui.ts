import { ProcessTerminal, TUI, matchesKey, truncateToWidth, visibleWidth, type Component } from '@earendil-works/pi-tui';

type Agent = { id: string; role: string; status: string; last: string };
type VisualEvent = { time: string; agent: string; type: string; text: string };

const reset = '\x1b[0m';
const dim = (value: string) => `\x1b[2m${value}${reset}`;
const bold = (value: string) => `\x1b[1m${value}${reset}`;
const color = (code: number, value: string) => `\x1b[${code}m${value}${reset}`;
const cyan = (value: string) => color(36, value);
const green = (value: string) => color(32, value);
const yellow = (value: string) => color(33, value);
const magenta = (value: string) => color(35, value);
const blue = (value: string) => color(34, value);

function padVisible(value: string, width: number): string {
  const clipped = truncateToWidth(value, width);
  return clipped + ' '.repeat(Math.max(0, width - visibleWidth(clipped)));
}

function line(width: number, left: string, fill = '─', right = ''): string {
  const remaining = Math.max(0, width - visibleWidth(left) - visibleWidth(right));
  return `${left}${fill.repeat(remaining)}${right}`;
}

function box(title: string, lines: string[], width: number, height: number, focused = false): string[] {
  const border = focused ? yellow : dim;
  const top = border(`┌ ${title} ${'─'.repeat(Math.max(0, width - visibleWidth(title) - 4))}┐`);
  const bottom = border(`└${'─'.repeat(Math.max(0, width - 2))}┘`);
  const bodyHeight = Math.max(0, height - 2);
  const body = Array.from({ length: bodyHeight }, (_, index) => {
    const content = lines[index] ?? '';
    return `${border('│')}${padVisible(content, width - 2)}${border('│')}`;
  });
  return [top, ...body, bottom];
}

function hjoin(columns: string[][]): string[] {
  const height = Math.max(...columns.map((column) => column.length));
  return Array.from({ length: height }, (_, row) => columns.map((column) => column[row] ?? '').join(''));
}

class CockpitSpike implements Component {
  private tick = 0;
  private focus = 1;
  private readonly agents: Agent[] = [
    { id: 'claude', role: 'Architect / Reviewer', status: 'planning ✓', last: 'proposed event-sourced cockpit' },
    { id: 'codex', role: 'Implementer / Fixer', status: 'coding …', last: 'editing renderer + event bus' },
    { id: 'aider', role: 'Git / Context', status: 'reviewing', last: 'checking diff/test loop' },
  ];
  private readonly events: VisualEvent[] = [
    { time: '09:44:01', agent: 'operator', type: 'mission', text: 'Build a visual cockpit humans can watch with their eyes.' },
    { time: '09:44:07', agent: 'claude', type: 'plan', text: 'Every agent action should become a visual event.' },
    { time: '09:44:14', agent: 'codex', type: 'tool.call', text: 'write_file src/events/visual-events.ts' },
    { time: '09:44:22', agent: 'codex', type: 'artifact.updated', text: 'diff.patch changed: +214 -18' },
    { time: '09:44:31', agent: 'claude', type: 'review', text: 'Blocker: no status-only screens; show live transcript.' },
    { time: '09:44:39', agent: 'aider', type: 'git', text: 'Use /diff, /undo, /test, repo map, explicit context.' },
  ];

  constructor(private readonly tui: TUI) {
    setInterval(() => {
      this.tick = Math.min(this.tick + 1, this.events.length - 1);
      this.tui.requestRender();
    }, 700).unref();
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (matchesKey(data, 'q') || matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) {
      this.tui.stop();
      process.exit(0);
    }
    if (matchesKey(data, 'tab')) {
      this.focus = (this.focus + 1) % 3;
      this.tui.requestRender();
    }
  }

  render(width: number): string[] {
    const totalWidth = Math.max(96, width);
    const bodyHeight = 20;
    const leftWidth = Math.max(28, Math.floor(totalWidth * 0.25));
    const rightWidth = Math.max(36, Math.floor(totalWidth * 0.32));
    const midWidth = Math.max(38, totalWidth - leftWidth - rightWidth);

    const agents = this.agents.flatMap((agent) => [
      `${magenta(agent.id)} ${green(agent.status)}`,
      dim(agent.role),
      agent.last,
      '',
    ]);

    const transcript = this.events.slice(0, this.tick + 1).flatMap((event) => [
      `${dim(event.time)} ${yellow(`[${event.type}]`)} ${cyan(event.agent)}`,
      event.text,
      '',
    ]);

    const artifact = [
      yellow('plan.md'),
      '1. Add canonical events.ndjson',
      '2. Render visual agent cards',
      '3. Show tool/diff/review cards',
      '4. Keep snapshot/no-TTY fallback',
      '',
      yellow('diff.patch'),
      green('+ agent.message events'),
      green('+ tool.call cards'),
      green('+ keyboard focus ring'),
      '',
      yellow('OpenTUI verdict'),
      'blocked on Node FFI in this env',
      'Pi TUI renders with plain Node',
    ];

    return [
      line(totalWidth, bold(' xdou visual cockpit spike '), '─', dim(' q quit ')),
      `${cyan('Mission')} visual multi-agent co-development  ${cyan('Phase')} renderer spike  ${cyan('Goal')} agents speaking/planning/coding/reviewing in panes`,
      ...hjoin([
        box('Agents', agents, leftWidth, bodyHeight, this.focus === 0),
        box('Live Council Transcript', transcript, midWidth, bodyHeight, this.focus === 1),
        box('Current Artifact', artifact, rightWidth, bodyHeight, this.focus === 2),
      ]),
      line(totalWidth, dim(' [tab] switch pane  [n] new mission  [v] diff  [p] plan  [r] review  [a] apply  [q] quit ')),
    ];
  }
}

const terminal = new ProcessTerminal();
const tui = new TUI(terminal);
const app = new CockpitSpike(tui);
tui.addChild(app);
tui.setFocus(app);
setTimeout(() => {
  tui.stop();
  process.exit(0);
}, 7000).unref();
tui.start();
