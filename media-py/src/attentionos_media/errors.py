"""Errors with a stable code and a plain-language fix, serialised by the CLI as JSON."""

from __future__ import annotations


class MediaError(Exception):
    """A failure the caller can act on. `code` is stable; `message` and `fix` are plain language."""

    def __init__(self, code: str, message: str, fix: str | None = None, details: dict | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.fix = fix
        self.details = details or {}

    def to_json(self) -> dict:
        out: dict = {"code": self.code, "message": self.message}
        if self.fix:
            out["fix"] = self.fix
        if self.details:
            out["details"] = self.details
        return out


class ToolMissing(MediaError):
    def __init__(self, tool: str, fix: str) -> None:
        super().__init__(f"{tool}_missing", f"{tool} is not installed or not on PATH.", fix)


class NotFound(MediaError):
    def __init__(self, what: str, path: str) -> None:
        super().__init__(
            "not_found", f"{what} not found: {path}", "Check the path; it must be readable by this machine."
        )


class BadInput(MediaError):
    def __init__(self, message: str, details: dict | None = None) -> None:
        super().__init__("bad_input", message, "Check the JSON sent to this command.", details)
