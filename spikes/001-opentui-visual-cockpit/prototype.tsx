import { createCliRenderer } from '@opentui/core';
import { createRoot, useKeyboard, useTerminalDimensions } from '@opentui/react';
import React, { useEffect, useMemo, useState } from 'react';

type Agent = { id: string; role: string; status: string; last: string; color: string };
type Event = { time: string; agent: string; type: string; text: string };

const agents: Agent[] = [
  { id: 'claude', role: 'Architect / Reviewer', status: 'planning ✓', last: 'Proposed pane-first cockpit architecture', color: '#a78bfa' },
  { id: 'codex', role: 'Implementer / Fixer', status: 'coding …', last: 'Editing event bus + OpenTUI renderer', color: '#60a5fa' },
  { id: 'aider', role: 'Git / Context specialist', status: 'reviewing', last: 'Checking repo-map and diff workflow', color: '#34d399' },
];

const baseEvents: Event[] = [
  { time: '09:44:01', agent: 'operator', type: 'mission', text: 'Build a visual cockpit where humans can watch agents plan, code, review, and act.' },
  { time: '09:44:07', agent: 'claude', type: 'plan', text: 'Separate core event stream from UI. Every agent action becomes a visual event.' },
  { time: '09:44:14', agent: 'codex', type: 'tool.call', text: 'write_file src/events/visual-events.ts' },
  { time: '09:44:22', agent: 'codex', type: 'artifact.updated', text: 'diff.patch changed: +214 -18' },
  { time: '09:44:31', agent: 'claude', type: 'review', text: 'Blocker: cockpit must show live transcript, not just final summaries.' },
  { time: '09:44:39', agent: 'aider', type: 'git', text: 'Recommend /diff, /undo, /test pattern and explicit context files.' },
];

function Panel({ title, children, focused = false, width, height }: { title: string; children: React.ReactNode; focused?: boolean; width?: number | string; height?: number | string }) {
  return (
    <box
      title={title}
      style={{
        border: true,
        borderStyle: 'rounded',
        borderColor: focused ? '#facc15' : '#3f3f46',
        paddingLeft: 1,
        paddingRight: 1,
        width,
        height,
        flexDirection: 'column',
      }}
    >
      {children}
    </box>
  );
}

function App() {
  const { width, height } = useTerminalDimensions();
  const [tick, setTick] = useState(0);
  const [focus, setFocus] = useState<'agents' | 'transcript' | 'artifact'>('transcript');
  const visibleEvents = useMemo(() => baseEvents.slice(0, Math.min(baseEvents.length, 1 + tick)), [tick]);

  useEffect(() => {
    const timer = setInterval(() => setTick((value) => Math.min(value + 1, baseEvents.length - 1)), 700);
    const shutdown = setTimeout(() => process.exit(0), 7000);
    return () => { clearInterval(timer); clearTimeout(shutdown); };
  }, []);

  useKeyboard((key) => {
    if (key.name === 'q' || key.name === 'escape') process.exit(0);
    if (key.name === 'tab') setFocus((current) => current === 'agents' ? 'transcript' : current === 'transcript' ? 'artifact' : 'agents');
  });

  const leftWidth = Math.max(26, Math.floor(width * 0.25));
  const rightWidth = Math.max(34, Math.floor(width * 0.31));
  const middleWidth = Math.max(40, width - leftWidth - rightWidth - 6);
  const bodyHeight = Math.max(14, height - 6);

  return (
    <box style={{ flexDirection: 'column', width, height, backgroundColor: '#09090b' }}>
      <box style={{ height: 3, border: true, borderColor: '#52525b', paddingLeft: 1, justifyContent: 'space-between' }}>
        <text fg="#f4f4f5">xdou visual cockpit spike</text>
        <text fg="#a1a1aa">mission: visual multi-agent co-development | phase: spike | q quit</text>
      </box>

      <box style={{ flexDirection: 'row', height: bodyHeight }}>
        <Panel title="Agents" focused={focus === 'agents'} width={leftWidth} height="100%">
          {agents.map((agent) => (
            <box key={agent.id} style={{ flexDirection: 'column', marginBottom: 1 }}>
              <text fg={agent.color}>{agent.id} — {agent.status}</text>
              <text fg="#a1a1aa">{agent.role}</text>
              <text fg="#d4d4d8">{agent.last}</text>
            </box>
          ))}
        </Panel>

        <Panel title="Live Council Transcript" focused={focus === 'transcript'} width={middleWidth} height="100%">
          <scrollbox focused={focus === 'transcript'} style={{ flexGrow: 1 }}>
            {visibleEvents.map((event, index) => (
              <box key={`${event.time}-${index}`} style={{ flexDirection: 'column', marginBottom: 1 }}>
                <text fg="#71717a">{event.time} [{event.type}]</text>
                <text fg={event.agent === 'claude' ? '#a78bfa' : event.agent === 'codex' ? '#60a5fa' : event.agent === 'aider' ? '#34d399' : '#facc15'}>{event.agent}: {event.text}</text>
              </box>
            ))}
          </scrollbox>
        </Panel>

        <Panel title="Current Artifact" focused={focus === 'artifact'} width={rightWidth} height="100%">
          <text fg="#facc15">plan.md</text>
          <text fg="#e4e4e7">1. Add canonical events.ndjson</text>
          <text fg="#e4e4e7">2. Render events as visual agent cards</text>
          <text fg="#e4e4e7">3. Add diff/review/test panes</text>
          <text fg="#e4e4e7">4. Keep --snapshot for CI/no-TTY</text>
          <text fg="#71717a"> </text>
          <text fg="#facc15">diff.patch</text>
          <text fg="#22c55e">+ agent.message events</text>
          <text fg="#22c55e">+ tool.call cards</text>
          <text fg="#22c55e">+ keyboard focus ring</text>
        </Panel>
      </box>

      <box style={{ height: 3, border: true, borderColor: '#52525b', paddingLeft: 1 }}>
        <text fg="#a1a1aa">[tab] switch pane  [n] new mission  [v] diff  [p] plan  [r] review  [a] apply  [q] quit</text>
      </box>
    </box>
  );
}

const renderer = await createCliRenderer({
  exitOnCtrlC: true,
  clearOnShutdown: true,
  screenMode: 'alternate-screen',
  targetFps: 30,
});

createRoot(renderer).render(<App />);
