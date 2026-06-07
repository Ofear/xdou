import base64
import os
from pathlib import Path

from terminal_bench.agents.installed_agents.abstract_installed_agent import AbstractInstalledAgent
from terminal_bench.terminal.models import TerminalCommand


class XdouAgent(AbstractInstalledAgent):
    """Terminal-Bench installed-agent adapter for xdou.

    The task command is intentionally tiny. The real benchmark logic lives in
    /installed-agent/xdou-run-task.sh, written by xdou-setup.sh.j2. Terminal-
    Bench sends commands through tmux; very large pasted commands can stall and
    time out before execution.
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
        env = {
            key: os.environ[key]
            for key in [
                "OPENAI_API_KEY",
                "ANTHROPIC_API_KEY",
                "OPENROUTER_API_KEY",
                "XDOU_CODEX_AUTH_JSON_B64",
                "XDOU_CLAUDE_CREDENTIALS_JSON_B64",
                "XDOU_CLAUDE_JSON_B64",
                "XDOU_INSTALL_FULL",
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
MAX_FIX_ATTEMPTS={self._max_fix_attempts} /installed-agent/xdou-run-task.sh
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
