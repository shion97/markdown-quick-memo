"""Markdown Quick Memo package."""

from __future__ import annotations

from importlib import import_module
from typing import Any

__all__ = ["MarkdownQuickMemoApp"]
__version__ = "1.0.0"


def __getattr__(name: str) -> Any:
    if name == "MarkdownQuickMemoApp":
        return import_module(".app", __name__).MarkdownQuickMemoApp
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
