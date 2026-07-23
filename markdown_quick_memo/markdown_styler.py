"""編集欄向けの軽量Markdown解析。

元テキストを一切変更せず、Tk Textに適用する装飾範囲を返す。
"""

from __future__ import annotations

from dataclasses import dataclass, field
import re


@dataclass(frozen=True, slots=True)
class StyleSpan:
    start: int
    end: int
    tag: str
    concealable: bool = False


@dataclass(frozen=True, slots=True)
class LinkReference:
    start: int
    end: int
    target: str
    is_image: bool = False


@dataclass(frozen=True, slots=True)
class HorizontalRule:
    start: int
    end: int


@dataclass(frozen=True, slots=True)
class TableBlock:
    start: int
    end: int
    rows: tuple[tuple[str, ...], ...]
    alignments: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class ListMarker:
    start: int
    end: int
    label: str
    depth: int
    ordered: bool


@dataclass(frozen=True, slots=True)
class QuoteMarker:
    start: int
    end: int
    depth: int


@dataclass(frozen=True, slots=True)
class QuoteLine:
    start: int
    end: int
    content: str
    depth: int


@dataclass(frozen=True, slots=True)
class QuoteBlock:
    start: int
    end: int
    lines: tuple[QuoteLine, ...]


@dataclass(frozen=True, slots=True)
class MathExpression:
    start: int
    end: int
    expression: str
    display: bool
    heading_level: int | None = None


@dataclass(slots=True)
class MarkdownAnalysis:
    spans: list[StyleSpan] = field(default_factory=list)
    links: list[LinkReference] = field(default_factory=list)
    horizontal_rules: list[HorizontalRule] = field(default_factory=list)
    tables: list[TableBlock] = field(default_factory=list)
    list_markers: list[ListMarker] = field(default_factory=list)
    quote_markers: list[QuoteMarker] = field(default_factory=list)
    quote_blocks: list[QuoteBlock] = field(default_factory=list)
    math_expressions: list[MathExpression] = field(default_factory=list)


FENCE_PATTERN = re.compile(r"(?ms)^([ \t]*)(`{3,}|~{3,})[^\n]*\n(.*?)(?:^\1\2[ \t]*$|\Z)")
DISPLAY_MATH_PATTERN = re.compile(r"(?ms)(?<!\\)(?<!\$)\$\$(?!\$)(.+?)(?<!\\)\$\$(?!\$)")
INLINE_MATH_PATTERN = re.compile(r"(?<!\\)(?<!\$)\$(?!\$)(?=\S)(.+?)(?<=\S)(?<!\\)\$(?!\$)")
LIST_ITEM_PATTERN = re.compile(r"^(\s*)([-+*]|\d+[.)])([ \t]+)")
QUOTE_LINE_PATTERN = re.compile(r"^( {0,3})((?:> ?)*>)[ ](.*)$")
QUOTE_INTERRUPT_PATTERN = re.compile(
    r"^( {0,3})(?:"
    r"#{1,6}(?:[ \t]+|$)|"
    r"`{3,}|~{3,}|"
    r"(?:[-+*]|\d+[.)])[ \t]+|"
    r"(?:\*[ \t]*){3,}|"
    r"(?:-[ \t]*){3,}|"
    r"(?:_[ \t]*){3,}"
    r")"
)
INLINE_CODE_PATTERN = re.compile(r"(?<!\\)(`+)(?=\S)(.+?)(?<=\S)\1")
IMAGE_PATTERN = re.compile(r"(?<!\\)!\[([^\]]*)\]\(([^)\s]+)(?:\s+[\"'][^\"']*[\"'])?\)")
LINK_PATTERN = re.compile(r"(?<!!)\[([^\]]+)\]\(([^)\s]+)(?:\s+[\"'][^\"']*[\"'])?\)")
INLINE_PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"(?<!\\)(\*\*\*|___)(?=\S)(.+?)(?<=\S)\1"), "bold_italic"),
    (re.compile(r"(?<!\\)(\*\*|__)(?=\S)(.+?)(?<=\S)\1"), "bold"),
    (re.compile(r"(?<!\\)(?<!~)(~~)(?=\S)(.+?)(?<=\S)\1"), "strike"),
    (re.compile(r"(?<!\\)(?<!\*)(\*)(?!\*)(?=\S)(.+?)(?<=\S)\1(?!\*)"), "italic"),
    (re.compile(r"(?<!\\)(?<!_)(_)(?!_)(?=\S)(.+?)(?<=\S)\1(?!_)"), "italic"),
    (INLINE_CODE_PATTERN, "inline_code"),
)


def _line_ranges(text: str):
    offset = 0
    for line in text.splitlines(keepends=True):
        content = line.rstrip("\r\n")
        yield offset, content
        offset += len(line)
    if not text or text.endswith(("\n", "\r")):
        yield offset, ""


def _overlaps(start: int, end: int, ranges: list[tuple[int, int]]) -> bool:
    return any(start < range_end and end > range_start for range_start, range_end in ranges)


def _delimiter_spans(match: re.Match[str], tag: str) -> list[StyleSpan]:
    opening_start, opening_end = match.span(1)
    content_start, content_end = match.span(2)
    closing_start = match.end(0) - (opening_end - opening_start)
    return [
        StyleSpan(content_start, content_end, tag),
        StyleSpan(opening_start, opening_end, "marker", True),
        StyleSpan(closing_start, match.end(0), "marker", True),
    ]


def _split_table_row(line: str) -> list[str]:
    row = line.strip()
    if row.startswith("|"):
        row = row[1:]
    if row.endswith("|"):
        row = row[:-1]

    cells: list[str] = []
    current: list[str] = []
    math_delimiter_length = 0
    index = 0
    while index < len(row):
        character = row[index]
        if character == "\\" and index + 1 < len(row):
            current.extend((character, row[index + 1]))
            index += 2
            continue
        if character == "$":
            delimiter_length = 2 if row.startswith("$$", index) else 1
            if math_delimiter_length == 0:
                math_delimiter_length = delimiter_length
            elif math_delimiter_length == delimiter_length:
                math_delimiter_length = 0
            current.append("$" * delimiter_length)
            index += delimiter_length
            continue
        if character == "|" and math_delimiter_length == 0:
            cells.append("".join(current).strip())
            current.clear()
        else:
            current.append(character)
        index += 1
    cells.append("".join(current).strip())
    return cells


def _heading_level_at(text: str, offset: int) -> int | None:
    line_start = text.rfind("\n", 0, offset) + 1
    line_end = text.find("\n", offset)
    if line_end == -1:
        line_end = len(text)
    heading = re.match(r"^( {0,3})(#{1,6})([ \t]+)", text[line_start:line_end])
    if heading is None or offset < line_start + heading.end(0):
        return None
    return len(heading.group(2))


def _table_alignments(line: str) -> tuple[str, ...] | None:
    cells = _split_table_row(line)
    if len(cells) < 2 or any(not re.fullmatch(r":?-{3,}:?", cell) for cell in cells):
        return None
    alignments: list[str] = []
    for cell in cells:
        if cell.startswith(":") and cell.endswith(":"):
            alignments.append("center")
        elif cell.endswith(":"):
            alignments.append("right")
        else:
            alignments.append("left")
    return tuple(alignments)


def _normalize_table_row(cells: list[str], column_count: int) -> tuple[str, ...]:
    normalized = cells[:column_count]
    normalized.extend([""] * (column_count - len(normalized)))
    return tuple(normalized)


def analyze_markdown(text: str) -> MarkdownAnalysis:
    """一般的なMarkdown記法を装飾範囲へ変換する。"""
    analysis = MarkdownAnalysis()
    protected_ranges: list[tuple[int, int]] = []

    for fence_match in FENCE_PATTERN.finditer(text):
        start, end = fence_match.span(0)
        protected_ranges.append((start, end))
        first_newline = text.find("\n", start, end)
        if first_newline == -1:
            first_newline = end
        closing_start = text.rfind("\n", start, end)
        if closing_start <= first_newline:
            closing_start = end
        else:
            closing_start += 1
        opening_marker_end = fence_match.end(2)
        language_start = opening_marker_end
        while language_start < first_newline and text[language_start].isspace():
            language_start += 1
        language_end = first_newline
        while language_end > language_start and text[language_end - 1].isspace():
            language_end -= 1
        analysis.spans.append(StyleSpan(start, end, "code_block"))
        analysis.spans.append(StyleSpan(start, opening_marker_end, "marker", True))
        if language_start < language_end:
            analysis.spans.append(StyleSpan(language_start, language_end, "code_language"))
        analysis.spans.append(StyleSpan(closing_start, end, "marker", True))

    math_protected_ranges = [
        *protected_ranges,
        *(match.span(0) for match in INLINE_CODE_PATTERN.finditer(text)),
        *(match.span(2) for match in IMAGE_PATTERN.finditer(text)),
        *(match.span(2) for match in LINK_PATTERN.finditer(text)),
    ]
    math_ranges: list[tuple[int, int]] = []
    for math_match in DISPLAY_MATH_PATTERN.finditer(text):
        start, end = math_match.span(0)
        if _overlaps(start, end, math_protected_ranges):
            continue
        expression = math_match.group(1).strip()
        if not expression:
            continue
        math_ranges.append((start, end))
        analysis.math_expressions.append(
            MathExpression(start, end, expression, True, _heading_level_at(text, start))
        )
        analysis.spans.extend(
            [
                StyleSpan(math_match.start(1), math_match.end(1), "math_block"),
                StyleSpan(start, start + 2, "marker", True),
                StyleSpan(end - 2, end, "marker", True),
            ]
        )

    for math_match in INLINE_MATH_PATTERN.finditer(text):
        start, end = math_match.span(0)
        if _overlaps(start, end, math_protected_ranges + math_ranges):
            continue
        expression = math_match.group(1)
        math_ranges.append((start, end))
        analysis.math_expressions.append(
            MathExpression(start, end, expression, False, _heading_level_at(text, start))
        )
        analysis.spans.extend(
            [
                StyleSpan(math_match.start(1), math_match.end(1), "math_inline"),
                StyleSpan(start, start + 1, "marker", True),
                StyleSpan(end - 1, end, "marker", True),
            ]
        )

    line_records = list(_line_ranges(text))
    table_line_indexes: set[int] = set()
    for delimiter_index in range(1, len(line_records)):
        delimiter_start, delimiter_line = line_records[delimiter_index]
        alignments = _table_alignments(delimiter_line)
        if alignments is None or delimiter_index - 1 in table_line_indexes:
            continue
        delimiter_end = delimiter_start + len(delimiter_line)
        if _overlaps(delimiter_start, delimiter_end, protected_ranges):
            continue
        header_start, header_line = line_records[delimiter_index - 1]
        header_cells = _split_table_row(header_line)
        if "|" not in header_line or len(header_cells) < 2:
            continue

        column_count = len(alignments)
        rows = [_normalize_table_row(header_cells, column_count)]
        last_row_index = delimiter_index
        body_index = delimiter_index + 1
        while body_index < len(line_records):
            body_start, body_line = line_records[body_index]
            body_end = body_start + len(body_line)
            if not body_line.strip() or "|" not in body_line:
                break
            if _overlaps(body_start, body_end, protected_ranges):
                break
            rows.append(_normalize_table_row(_split_table_row(body_line), column_count))
            last_row_index = body_index
            body_index += 1

        block_end = line_records[last_row_index + 1][0] if last_row_index + 1 < len(line_records) else len(text)
        analysis.tables.append(TableBlock(header_start, block_end, tuple(rows), alignments))
        table_line_indexes.update(range(delimiter_index - 1, last_row_index + 1))
        for row_index in range(delimiter_index - 1, last_row_index + 1):
            row_start, row_line = line_records[row_index]
            row_end = row_start + len(row_line)
            tag = "table_delimiter" if row_index == delimiter_index else "table"
            analysis.spans.append(StyleSpan(row_start, row_end, tag))

    list_indent_levels: list[int] = []
    ordered_counters: dict[int, int] = {}
    previous_list_types: dict[int, str] = {}
    previous_was_list = False
    current_quote_depth = 0
    quote_paragraph_open = False
    current_quote_lines: list[QuoteLine] = []

    def flush_quote_block() -> None:
        if not current_quote_lines:
            return
        analysis.quote_blocks.append(
            QuoteBlock(
                current_quote_lines[0].start,
                current_quote_lines[-1].end,
                tuple(current_quote_lines),
            )
        )
        current_quote_lines.clear()

    for line_index, (line_start, line) in enumerate(line_records):
        line_end = line_start + len(line)
        if _overlaps(line_start, line_end, protected_ranges):
            flush_quote_block()
            previous_was_list = False
            current_quote_depth = 0
            quote_paragraph_open = False
            continue

        quote = QUOTE_LINE_PATTERN.match(line)
        if quote:
            explicit_quote_depth = quote.group(2).count(">")
            quote_content = quote.group(3)
            content_continues_paragraph = bool(
                quote_content.strip()
                and not QUOTE_INTERRUPT_PATTERN.match(quote_content)
            )
            if (
                explicit_quote_depth < current_quote_depth
                and quote_paragraph_open
                and content_continues_paragraph
            ):
                effective_quote_depth = current_quote_depth
            else:
                effective_quote_depth = explicit_quote_depth
            current_quote_depth = effective_quote_depth
            quote_paragraph_open = content_continues_paragraph
            marker_end = line_start + quote.start(3)
            style_end = min(line_end + 1, len(text))
            analysis.spans.append(StyleSpan(line_start, style_end, "quote"))
            analysis.spans.append(StyleSpan(line_start, marker_end, "quote_marker", True))
            analysis.quote_markers.append(
                QuoteMarker(line_start, marker_end, current_quote_depth)
            )
            current_quote_lines.append(
                QuoteLine(
                    line_start,
                    line_end,
                    quote_content,
                    current_quote_depth,
                )
            )
        elif (
            current_quote_depth
            and quote_paragraph_open
            and line.strip()
            and not QUOTE_INTERRUPT_PATTERN.match(line)
        ):
            style_end = min(line_end + 1, len(text))
            analysis.spans.append(StyleSpan(line_start, style_end, "quote"))
            analysis.quote_markers.append(
                QuoteMarker(line_start, line_start, current_quote_depth)
            )
            current_quote_lines.append(
                QuoteLine(line_start, line_end, line, current_quote_depth)
            )
        else:
            flush_quote_block()
            current_quote_depth = 0
            quote_paragraph_open = False

        heading = re.match(r"^( {0,3})(#{1,6})([ \t]+)(.*)$", line)
        if heading:
            level = len(heading.group(2))
            marker_end = line_start + heading.start(4)
            analysis.spans.append(StyleSpan(marker_end, line_end, f"heading{level}"))
            analysis.spans.append(StyleSpan(line_start, marker_end, "marker", True))

        list_item = LIST_ITEM_PATTERN.match(line)
        if list_item:
            indent_width = len(list_item.group(1).expandtabs(4))
            if not previous_was_list:
                list_indent_levels = [indent_width]
                ordered_counters.clear()
                previous_list_types.clear()
            elif indent_width > list_indent_levels[-1]:
                list_indent_levels.append(indent_width)
            elif indent_width < list_indent_levels[-1]:
                while len(list_indent_levels) > 1 and indent_width < list_indent_levels[-1]:
                    list_indent_levels.pop()
                if indent_width < list_indent_levels[0]:
                    list_indent_levels = [indent_width]
                elif indent_width > list_indent_levels[-1]:
                    list_indent_levels.append(indent_width)

            depth = len(list_indent_levels) - 1
            for deeper_depth in [value for value in ordered_counters if value > depth]:
                ordered_counters.pop(deeper_depth, None)
                previous_list_types.pop(deeper_depth, None)

            marker_start = line_start + list_item.start(2)
            marker_end = line_start + list_item.end(2)
            source_marker = list_item.group(2)
            ordered = source_marker[0].isdigit()
            if ordered:
                if previous_list_types.get(depth) == "ordered":
                    ordered_counters[depth] += 1
                else:
                    ordered_counters[depth] = int(re.match(r"\d+", source_marker).group(0))  # type: ignore[union-attr]
                suffix = ")" if source_marker.endswith(")") else "."
                preview_label = f"{ordered_counters[depth]}{suffix}"
                previous_list_types[depth] = "ordered"
            else:
                preview_label = "●" if depth == 0 else "○"
                previous_list_types[depth] = "unordered"

            analysis.spans.append(StyleSpan(line_start, line_end, "list_item"))
            analysis.spans.append(StyleSpan(marker_start, marker_end, "list_marker"))
            analysis.list_markers.append(ListMarker(marker_start, marker_end, preview_label, depth, ordered))
            previous_was_list = True
        else:
            previous_was_list = False
            list_indent_levels.clear()
            ordered_counters.clear()
            previous_list_types.clear()

        checkbox = re.match(r"^\s*[-+*][ \t]+(\[[ xX]\])", line)
        if checkbox:
            start = line_start + checkbox.start(1)
            end = line_start + checkbox.end(1)
            checked = line[checkbox.start(1) + 1].lower() == "x"
            analysis.spans.append(StyleSpan(start, end, "checkbox_checked" if checked else "checkbox"))

        if line_index not in table_line_indexes and re.match(r"^\s{0,3}(([-*_])\s*){3,}$", line):
            analysis.spans.append(StyleSpan(line_start, line_end, "horizontal_rule"))
            analysis.spans.append(StyleSpan(line_start, line_end, "marker", True))
            analysis.horizontal_rules.append(HorizontalRule(line_start, line_end))

    flush_quote_block()

    image_ranges: list[tuple[int, int]] = []
    for match in IMAGE_PATTERN.finditer(text):
        start, end = match.span(0)
        if _overlaps(start, end, protected_ranges):
            continue
        image_ranges.append((start, end))
        analysis.spans.append(StyleSpan(start, end, "image_reference"))
        analysis.links.append(LinkReference(start, end, match.group(2), True))

    link_ranges: list[tuple[int, int]] = []
    for match in LINK_PATTERN.finditer(text):
        start, end = match.span(0)
        if _overlaps(start, end, protected_ranges):
            continue
        link_ranges.append((start, end))
        analysis.spans.append(StyleSpan(match.start(1), match.end(1), "link"))
        analysis.spans.append(StyleSpan(start, match.start(1), "marker", True))
        analysis.spans.append(StyleSpan(match.end(1), end, "marker", True))
        analysis.links.append(LinkReference(start, end, match.group(2), False))

    excluded_ranges = protected_ranges + math_ranges + image_ranges + link_ranges
    for pattern, tag in INLINE_PATTERNS:
        for match in pattern.finditer(text):
            start, end = match.span(0)
            if _overlaps(start, end, excluded_ranges):
                continue
            analysis.spans.extend(_delimiter_spans(match, tag))

    escaped = re.compile(r"\\([\\`*{}\[\]()#+\-.!_>~|])")
    for match in escaped.finditer(text):
        if not _overlaps(match.start(), match.end(), protected_ranges):
            analysis.spans.append(StyleSpan(match.start(), match.start() + 1, "marker", True))

    analysis.spans.sort(key=lambda span: (span.start, span.end, span.tag))
    analysis.math_expressions.sort(key=lambda expression: expression.start)
    return analysis
