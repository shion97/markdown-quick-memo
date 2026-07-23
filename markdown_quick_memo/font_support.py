"""Bundled font registration and language-aware editor font runs."""

from __future__ import annotations

from collections import Counter, defaultdict
from collections.abc import Iterable
import ctypes
from dataclasses import dataclass
from functools import lru_cache
import os
from pathlib import Path
import sys

from .markdown_styler import StyleSpan


LATIN_FONT_FAMILY = "Segoe UI"
JAPANESE_FONT_FAMILY = "BIZ UDGothic"
MONOSPACE_FONT_FAMILY = "Cascadia Mono"
MATH_SOURCE_FONT_FAMILY = "Cambria Math"

_BUNDLED_FONT_FILES = (
    "Roboto-Variable.ttf",
    "Roboto-Italic-Variable.ttf",
)
_FONT_RELEVANT_TAGS = frozenset(
    {
        "bold",
        "italic",
        "bold_italic",
        "inline_code",
        "code_block",
        "code_language",
        "table",
        "table_delimiter",
        "math_inline",
        "math_block",
        "quote_marker",
        "list_marker",
        *(f"heading{level}" for level in range(1, 7)),
    }
)


@dataclass(frozen=True, slots=True)
class FontRun:
    start: int
    end: int
    script: str
    style: str

    @property
    def tag(self) -> str:
        return f"script_font_{self.script}_{self.style}"


def _font_asset_directory() -> Path:
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        return Path(sys._MEIPASS) / "assets" / "fonts"
    return Path(__file__).resolve().parent.parent / "assets" / "fonts"


@lru_cache(maxsize=1)
def register_bundled_fonts() -> tuple[Path, ...]:
    """Register bundled fonts privately for this Windows process."""

    if os.name != "nt":
        return ()

    font_directory = _font_asset_directory()
    registered: list[Path] = []
    add_font_resource = ctypes.windll.gdi32.AddFontResourceExW
    add_font_resource.argtypes = (ctypes.c_wchar_p, ctypes.c_uint, ctypes.c_void_p)
    add_font_resource.restype = ctypes.c_int
    private_font = 0x10

    for filename in _BUNDLED_FONT_FILES:
        path = font_directory / filename
        if path.is_file() and add_font_resource(str(path), private_font, None) > 0:
            registered.append(path)
    return tuple(registered)


def is_japanese_character(character: str) -> bool:
    """Return whether a character should use the Japanese text font."""

    if not character:
        return False
    codepoint = ord(character)
    return (
        0x3000 <= codepoint <= 0x303F  # CJK symbols and punctuation
        or 0x3040 <= codepoint <= 0x30FF  # Hiragana and Katakana
        or 0x31F0 <= codepoint <= 0x31FF  # Katakana phonetic extensions
        or 0x3400 <= codepoint <= 0x4DBF  # CJK Extension A
        or 0x4E00 <= codepoint <= 0x9FFF  # CJK Unified Ideographs
        or 0xF900 <= codepoint <= 0xFAFF  # CJK compatibility ideographs
        or 0xFE00 <= codepoint <= 0xFE1F  # variation selectors and vertical forms
        or 0xFF01 <= codepoint <= 0xFF60  # full-width forms
        or 0xFF61 <= codepoint <= 0xFF9F  # half-width Japanese punctuation/Katakana
        or 0xFFE0 <= codepoint <= 0xFFEE  # full-width symbols
        or 0x20000 <= codepoint <= 0x2FA1F
        or 0x30000 <= codepoint <= 0x3134F
    )


def _font_style(active_tags: Counter[str]) -> str:
    if active_tags["code_language"]:
        return "mono_bold"
    if any(active_tags[tag] for tag in ("inline_code", "code_block", "table", "table_delimiter")):
        return "mono"

    math = active_tags["math_inline"] or active_tags["math_block"]
    italic = active_tags["italic"] or active_tags["bold_italic"]
    for level in range(1, 7):
        heading = f"heading{level}"
        if active_tags[heading]:
            if math:
                return f"math_{heading}"
            return f"{heading}_italic" if italic else heading
    if math:
        return "math"

    bold = active_tags["bold"] or active_tags["bold_italic"]
    bold = bold or active_tags["quote_marker"] or active_tags["list_marker"]
    if bold and italic:
        return "bold_italic"
    if bold:
        return "bold"
    if italic:
        return "italic"
    return "body"


def build_font_runs(text: str, spans: Iterable[StyleSpan]) -> tuple[FontRun, ...]:
    """Combine Markdown styles and character scripts into non-overlapping font runs."""

    if not text:
        return ()

    starts: dict[int, list[str]] = defaultdict(list)
    ends: dict[int, list[str]] = defaultdict(list)
    for span in spans:
        if span.tag not in _FONT_RELEVANT_TAGS or span.start >= span.end:
            continue
        starts[span.start].append(span.tag)
        ends[span.end].append(span.tag)

    boundaries = sorted(
        position
        for position in {0, len(text), *starts, *ends}
        if 0 <= position <= len(text)
    )
    active_tags: Counter[str] = Counter()
    runs: list[FontRun] = []
    run_start: int | None = None
    current_key: tuple[str, str] | None = None

    for boundary_index, segment_start in enumerate(boundaries[:-1]):
        for tag in ends.get(segment_start, ()):
            active_tags[tag] -= 1
        for tag in starts.get(segment_start, ()):
            active_tags[tag] += 1

        style = _font_style(active_tags)
        segment_end = boundaries[boundary_index + 1]
        for offset in range(segment_start, segment_end):
            script = "japanese" if is_japanese_character(text[offset]) else "latin"
            key = (script, style)
            if current_key is None:
                current_key = key
                run_start = offset
            elif key != current_key:
                assert run_start is not None
                runs.append(FontRun(run_start, offset, *current_key))
                current_key = key
                run_start = offset

    if current_key is not None and run_start is not None:
        runs.append(FontRun(run_start, len(text), *current_key))
    return tuple(runs)
