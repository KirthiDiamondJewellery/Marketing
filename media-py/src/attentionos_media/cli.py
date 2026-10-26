"""`attentionos-media <command>`: JSON on stdin, JSON on stdout.

Commands: probe, prep, asr, cut-plan, render, finish, qc, embed (local text embeddings), trial-plan / trial-render /
trial-verify (Instagram trial-reel variations), models (list | path | download), version, and `synth` (synthetic test
clips for tests and demos).

Contract:
- stdout carries exactly one JSON document: the result on success (exit 0), or `{"error": {code, message, fix?}}`
  on failure (exit 1 for runtime errors, 2 for bad input).
- stderr carries progress as JSON lines (`{"progress": "..."}`) plus any tool chatter. Native libraries that print
  to stdout are redirected to stderr, so stdout stays parseable.
"""

from __future__ import annotations

import json
import os
import sys
import traceback
from collections.abc import Callable

from pydantic import ValidationError

from . import __version__
from .errors import MediaError


def _commands() -> dict[str, Callable[[dict], dict]]:
    from .asr import transcribe
    from .cutplan import cut_plan
    from .embed import embed
    from .finish import finish
    from .prep import prep
    from .probe import probe
    from .qc import qc
    from .render import render
    from .testing import synth
    from .trial import trial_plan, trial_render, trial_verify

    return {
        "probe": probe,
        "prep": prep,
        "asr": transcribe,
        "cut-plan": cut_plan,
        "render": render,
        "finish": finish,
        "qc": qc,
        "embed": embed,
        "synth": synth,
        "trial-plan": trial_plan,
        "trial-render": trial_render,
        "trial-verify": trial_verify,
    }


def _read_stdin() -> dict:
    if sys.stdin is None or sys.stdin.isatty():
        return {}
    raw = sys.stdin.read()
    if not raw.strip():
        return {}
    data = json.loads(raw)
    if not isinstance(data, dict):
        raise MediaError("bad_input", "Input must be a JSON object.")
    return data


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    # Keep the real stdout for our JSON; send everything else written to fd 1 (native libs) to stderr.
    sys.stdout.flush()
    real_out = os.fdopen(os.dup(1), "w", encoding="utf-8")
    os.dup2(2, 1)
    sys.stdout = sys.stderr

    def emit(obj: dict, code: int) -> int:
        real_out.write(json.dumps(obj, ensure_ascii=False) + "\n")
        real_out.flush()
        return code

    if not args or args[0] in ("-h", "--help", "help"):
        return emit(
            {
                "usage": "attentionos-media <probe|prep|asr|cut-plan|render|finish|qc|embed|trial-plan|trial-render|trial-verify|models|version> < input.json",
                "doc": (__doc__ or "").strip(),
            },
            0,
        )
    cmd = args[0]
    try:
        if cmd in ("version", "--version"):
            return emit({"version": __version__, "python": sys.version.split()[0]}, 0)
        payload = _read_stdin()
        if cmd == "models":
            from .models import models_command

            action = args[1] if len(args) > 1 else "list"
            return emit(models_command(action, payload), 0)
        commands = _commands()
        if cmd not in commands:
            return emit(
                {
                    "error": {
                        "code": "unknown_command",
                        "message": f"Unknown command '{cmd}'.",
                        "fix": f"Use one of: {', '.join([*commands, 'models', 'version'])}.",
                    }
                },
                2,
            )
        return emit(commands[cmd](payload), 0)
    except ValidationError as exc:
        issues = [{"path": ".".join(str(p) for p in e["loc"]), "message": e["msg"]} for e in exc.errors()[:20]]
        return emit(
            {
                "error": {
                    "code": "bad_input",
                    "message": f"Invalid input for '{cmd}'.",
                    "fix": "Check the fields listed in details.",
                    "details": {"issues": issues},
                }
            },
            2,
        )
    except json.JSONDecodeError as exc:
        return emit({"error": {"code": "bad_input", "message": f"stdin is not valid JSON: {exc}"}}, 2)
    except MediaError as exc:
        return emit({"error": exc.to_json()}, 2 if exc.code == "bad_input" else 1)
    except Exception as exc:  # unexpected: keep the contract, include a short trace for bug reports
        tb = traceback.format_exc().splitlines()[-6:]
        return emit(
            {"error": {"code": "internal", "message": f"{type(exc).__name__}: {exc}", "details": {"trace": tb}}}, 1
        )


if __name__ == "__main__":
    raise SystemExit(main())
