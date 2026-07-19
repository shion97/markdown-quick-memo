"""Markdown文書の読み書きに関する処理。"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path


def ensure_markdown_suffix(path: str | Path) -> Path:
    """拡張子がないパスに .md を付ける。"""
    markdown_path = Path(path)
    if not markdown_path.suffix:
        return markdown_path.with_suffix(".md")
    return markdown_path


def read_markdown(path: str | Path) -> str:
    """UTF-8 Markdownファイルを読み込む。BOMも許容する。"""
    return Path(path).read_text(encoding="utf-8-sig")


def write_markdown(path: str | Path, content: str) -> Path:
    """同じフォルダ内の一時ファイルを経由して安全に保存する。"""
    destination = ensure_markdown_suffix(path)
    destination.parent.mkdir(parents=True, exist_ok=True)

    file_descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{destination.name}.", suffix=".tmp", dir=destination.parent
    )
    temporary_path = Path(temporary_name)
    try:
        with os.fdopen(file_descriptor, "w", encoding="utf-8", newline="") as stream:
            stream.write(content)
        temporary_path.replace(destination)
    except Exception:
        temporary_path.unlink(missing_ok=True)
        raise
    return destination
