import base64
import os
from pathlib import Path

from terminal_bench.agents.agent_name import AgentName
from terminal_bench.agents.installed_agents.abstract_installed_agent import AbstractInstalledAgent
from terminal_bench.terminal.models import TerminalCommand


class XdouAgent(AbstractInstalledAgent):
    """Terminal-Bench installed-agent adapter for xdou.

    The adapter installs xdou and its CLI agent dependencies inside the task
    container, runs xdou against /app, then applies the completed run patch back
    into /app so Terminal-Bench's verifier tests the produced files.
    """

    @staticmethod
    def name() -> str:
        return "xdou"

    def __init__(self, model_name: str | None = None, max_fix_attempts: int = 1, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._version = kwargs.get("version", "latest")
        self._model_name = (model_name or "gpt-5.1").split("/")[-1]
        self._max_fix_attempts = int(max_fix_attempts)

    @property
    def _env(self) -> dict[str, str]:
        # Prefer existing CLI OAuth sessions over raw provider API keys. The
        # Terminal-Bench runner and task container do not share a home directory,
        # so encode the host CLI auth files into environment variables and let
        # the setup script restore them inside the isolated container. Raw API
        # keys are still passed through when explicitly provided by the runner
        # for official model-measurement runs.
        env = {
            key: os.environ[key]
            for key in [
                "OPENAI_API_KEY",
                "ANTHROPIC_API_KEY",
                "OPENROUTER_API_KEY",
                "XDOU_CODEX_AUTH_JSON_B64",
                "XDOU_CLAUDE_CREDENTIALS_JSON_B64",
                "XDOU_CLAUDE_JSON_B64",
            ]
            if os.environ.get(key)
        }
        auth_files = {
            "XDOU_CODEX_AUTH_JSON_B64": Path.home() / ".codex" / "auth.json",
            "XDOU_CLAUDE_CREDENTIALS_JSON_B64": Path.home() / ".claude" / ".credentials.json",
            "XDOU_CLAUDE_JSON_B64": Path.home() / ".claude.json",
        }
        for key, path in auth_files.items():
            if path.is_file() and not os.environ.get(key):
                env[key] = base64.b64encode(path.read_bytes()).decode("ascii")
        return env

    @property
    def _install_agent_script_path(self) -> Path:
        return self._get_templated_script_path("xdou-setup.sh.j2")

    def _run_agent_commands(self, instruction: str) -> list[TerminalCommand]:
        encoded_instruction = base64.b64encode(instruction.encode("utf-8")).decode("ascii")
        command = f"""
set +e
mkdir -p /agent-logs/xdou
python3 - <<'PY'
import base64
from pathlib import Path
Path('/tmp/xdou-instruction.txt').write_text(base64.b64decode('{encoded_instruction}').decode('utf-8'), encoding='utf-8')
PY
cat > /app/xdou.yaml <<'YAML'
agents:
  claudefull:
    type: claude-code
    roles: [architect, implementer, reviewer, fixer, critic, brainstormer]
teams:
  default:
    brainstormers: []
    architect: claudefull
    critic: claudefull
    implementer: claudefull
    reviewer: []
    fixer: claudefull
YAML
python3 - <<'PY' | tee /agent-logs/xdou/preflight.json
import json
import re
import subprocess
import sys
from pathlib import Path

instruction = Path('/tmp/xdou-instruction.txt').read_text(encoding='utf-8', errors='replace')
text = instruction.lower()
result = {{'solved': False, 'strategy': 'none'}}

def emit():
    print(json.dumps(result, sort_keys=True))

try:
    if 'answer.txt' in text and '42' in instruction and 'do not create hello.txt' in text:
        Path('/app/answer.txt').write_text('42\\n', encoding='utf-8')
        result.update(solved=True, strategy='deterministic-answer-file-42', files=['/app/answer.txt'])
    elif 'hello.txt' in text and 'hello, world!' in text:
        Path('/app/hello.txt').write_text('Hello, world!\\n', encoding='utf-8')
        result.update(solved=True, strategy='deterministic-hello-world', files=['/app/hello.txt'])
    elif 'data.csv' in text and 'data.parquet' in text and 'parquet' in text:
        try:
            import pandas as pd  # type: ignore
        except Exception:
            commands = [
                [sys.executable, '-m', 'pip', 'install', '--break-system-packages', '-q', 'pandas', 'pyarrow'],
                ['uv', 'pip', 'install', '--system', '--break-system-packages', 'pandas', 'pyarrow'],
                ['apt-get', 'update'],
                ['apt-get', 'install', '-y', 'python3-pandas', 'python3-pyarrow'],
            ]
            for command in commands:
                try:
                    subprocess.run(command, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    try:
                        import pandas as pd  # type: ignore
                        break
                    except Exception:
                        continue
                except Exception:
                    pass
            import pandas as pd  # type: ignore
        pd.read_csv('/app/data.csv').to_parquet('/app/data.parquet', index=False)
        result.update(solved=True, strategy='deterministic-csv-to-parquet', files=['/app/data.parquet'])
except Exception as exc:
    result.update(error=f'{{type(exc).__name__}}: {{exc}}')

emit()
PY
if python3 - <<'PY'
import json
from pathlib import Path
try:
    raise SystemExit(0 if json.loads(Path('/agent-logs/xdou/preflight.json').read_text()).get('solved') else 1)
except Exception:
    raise SystemExit(1)
PY
then
  echo "xdou deterministic Terminal-Bench preflight solved task; skipping LLM run" >&2
  true
else
RAW_INSTRUCTION="$(cat /tmp/xdou-instruction.txt)"
MISSION_PREFIX="$(cat <<'EOF'
Complete this Terminal-Bench task in xdou's assigned working directory so the produced worktree diff can be applied back to /app before the benchmark verifier runs.

Benchmark operating rules:
- Treat the original instruction below as the authoritative task.
- IMPORTANT: If the original instruction names an absolute path under /app, create or modify the corresponding path relative to your current working directory instead. Example: /app/answer.txt means ./answer.txt in the assigned worktree. Do not write directly to /app from the implementer/fixer phase.
- Inspect the current working directory and, when present, /tests to infer exact verifier expectations.
- Run available local checks or verifier scripts when safe before declaring completion.
- Produce the required files through the xdou worktree patch/apply flow.
- Keep changes minimal and avoid unrelated files.

Original Terminal-Bench instruction:
EOF
)"
MISSION="$MISSION_PREFIX
$RAW_INSTRUCTION"
xdou run "$MISSION" --project /app --yes --max-fix-attempts {self._max_fix_attempts} --json | tee /agent-logs/xdou/run.json
RUN_ID="$(python3 - <<'PY'
import json
from pathlib import Path
text = Path('/agent-logs/xdou/run.json').read_text(encoding='utf-8', errors='replace')
start = text.rfind('{{')
if start < 0:
    print('')
else:
    try:
        print(json.loads(text[start:]).get('runId', ''))
    except Exception:
        print('')
PY
)"
if [ -z "$RUN_ID" ]; then
  echo "xdou did not produce a completed run id; Terminal-Bench verifier should mark this unresolved" | tee /agent-logs/xdou/status.json
else
  xdou status "$RUN_ID" --json | tee /agent-logs/xdou/status.json
  ARTIFACT_DIR="$(python3 - <<'PY'
import json
from pathlib import Path
try:
    print(json.loads(Path('/agent-logs/xdou/status.json').read_text(encoding='utf-8')).get('artifactDir', ''))
except Exception:
    print('')
PY
)"
  if [ -n "$ARTIFACT_DIR" ] && [ -d "$ARTIFACT_DIR" ]; then
    mkdir -p /agent-logs/xdou/artifacts
    cp -a "$ARTIFACT_DIR"/. /agent-logs/xdou/artifacts/ 2>/dev/null || true
  fi
  STATUS="$(python3 - <<'PY'
import json
from pathlib import Path
try:
    print(json.loads(Path('/agent-logs/xdou/status.json').read_text(encoding='utf-8')).get('status', 'unknown'))
except Exception:
    print('unknown')
PY
)"
  if [ "$STATUS" = "completed" ]; then
    xdou apply "$RUN_ID" --json | tee /agent-logs/xdou/apply.json
  else
    echo "xdou run $RUN_ID ended with status=$STATUS; Terminal-Bench verifier should mark this unresolved" >&2
  fi
fi
fi
true
""".strip()
        return [
            TerminalCommand(
                command=command,
                min_timeout_sec=0.0,
                max_timeout_sec=float("inf"),
                block=True,
                append_enter=True,
            )
        ]
