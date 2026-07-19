"""Markdown文書を同名のPDFへ書き出す。"""

from __future__ import annotations

from dataclasses import dataclass, field
from html import escape
from html.parser import HTMLParser
import os
from pathlib import Path
import re
import sys
import tempfile
from typing import TypeAlias
from urllib.parse import unquote, urlparse

from PIL import Image as PillowImage

from .font_support import is_japanese_character
from .markdown_styler import analyze_markdown
from .math_renderer import render_math_png


PDF_BODY_FONT_SIZE = 11
PDF_CODE_FONT_SIZE = 10
PDF_CODE_LANGUAGE_FONT_SIZE = 9
PDF_TABLE_FONT_SIZE = 10
PDF_LIST_BULLET_FONT_SIZE = 4.5
PDF_LIST_NUMBER_FONT_SIZE = 10
PDF_LIST_BULLET_OFFSET_Y = PDF_LIST_BULLET_FONT_SIZE - PDF_BODY_FONT_SIZE
PDF_LIST_NUMBER_OFFSET_Y = PDF_LIST_NUMBER_FONT_SIZE - PDF_BODY_FONT_SIZE
PDF_TABLE_LINE_WIDTH = 0.8
PDF_TABLE_STRONG_LINE_WIDTH = PDF_TABLE_LINE_WIDTH * 2
PDF_HEADING_FONT_SIZES = (22, 19, 17, 15, 13, 12)
PDF_INLINE_MATH_FONT_SIZE = 8
PDF_TABLE_MATH_FONT_SIZE = 10
PDF_DISPLAY_MATH_FONT_SIZE = 15
PDF_INLINE_MATH_DPI = 300
PDF_DISPLAY_MATH_DPI = 150
PDF_DISPLAY_MATH_VERTICAL_PADDING_POINTS = 2.0

_MATH_TOKEN_PREFIX = "MQMMATHTOKEN"
_LIST_TOKEN_PREFIX = "MQMLISTTOKEN"
_VOID_HTML_TAGS = frozenset({"br", "hr", "img", "input", "meta", "link"})
_BLOCK_HTML_TAGS = frozenset(
    {
        "p",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "blockquote",
        "ul",
        "ol",
        "pre",
        "table",
        "hr",
    }
)


@dataclass(slots=True)
class _HtmlNode:
    tag: str
    attrs: dict[str, str] = field(default_factory=dict)
    children: list["_HtmlChild"] = field(default_factory=list)


_HtmlChild: TypeAlias = str | _HtmlNode


class _HtmlTreeParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.root = _HtmlNode("root")
        self._stack = [self.root]

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        node = _HtmlNode(tag.lower(), {name: value or "" for name, value in attrs})
        self._stack[-1].children.append(node)
        if node.tag not in _VOID_HTML_TAGS:
            self._stack.append(node)

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)

    def handle_endtag(self, tag: str) -> None:
        lowered_tag = tag.lower()
        for index in range(len(self._stack) - 1, 0, -1):
            if self._stack[index].tag == lowered_tag:
                del self._stack[index:]
                return

    def handle_data(self, data: str) -> None:
        self._stack[-1].children.append(data)


@dataclass(frozen=True, slots=True)
class _PdfFonts:
    latin: str
    latin_bold: str
    latin_italic: str
    latin_bold_italic: str
    japanese: str
    japanese_bold: str
    monospace: str


@dataclass(frozen=True, slots=True)
class _MathAsset:
    token: str
    source: str
    path: Path | None
    display: bool
    width: float = 0.0
    height: float = 0.0
    baseline: float | None = None
    font_size: int = 0


@dataclass(frozen=True, slots=True)
class _ListItemAsset:
    content: str
    label: str
    depth: int
    ordered: bool


@dataclass(frozen=True, slots=True)
class _ListBlockAsset:
    token: str
    items: tuple[_ListItemAsset, ...]


@dataclass(slots=True)
class _ListTreeItem:
    asset: _ListItemAsset
    children: list["_ListTreeItem"] = field(default_factory=list)


def _font_asset_directory() -> Path:
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        return Path(sys._MEIPASS) / "assets" / "fonts"
    return Path(__file__).resolve().parent.parent / "assets" / "fonts"


def _instantiate_roboto_font(
    source_path: Path,
    output_path: Path,
    weight: int,
    style_name: str,
    postscript_name: str,
) -> None:
    from fontTools.ttLib import TTFont as FontToolsTTFont
    from fontTools.varLib.instancer import instantiateVariableFont

    variable_font = FontToolsTTFont(source_path)
    static_font = instantiateVariableFont(variable_font, {"wght": weight}, inplace=False)
    name_table = static_font["name"]
    names = {
        1: "Roboto",
        2: style_name,
        3: f"Markdown Quick Memo {postscript_name}",
        4: f"Roboto {style_name}",
        6: postscript_name,
        16: "Roboto",
        17: style_name,
        21: "Roboto",
        22: style_name,
    }
    name_table.names = [record for record in name_table.names if record.nameID not in names]
    for name_id, value in names.items():
        name_table.setName(value, name_id, 3, 1, 0x409)
        name_table.setName(value, name_id, 1, 0, 0)
    static_font.save(output_path)
    variable_font.close()
    static_font.close()


def _register_pdf_fonts(temporary_directory: Path) -> _PdfFonts:
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont
    from reportlab.pdfbase.ttfonts import TTFError, TTFont

    registered = set(pdfmetrics.getRegisteredFontNames())
    font_directory = _font_asset_directory()
    windows_font_directory = Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts"
    latin = "MQM-Segoe-UI"
    latin_bold = "MQM-Segoe-UI-Bold"
    latin_italic = "MQM-Segoe-UI-Italic"
    latin_bold_italic = "MQM-Segoe-UI-Bold-Italic"
    if latin not in registered:
        try:
            pdfmetrics.registerFont(
                TTFont(latin, str(windows_font_directory / "segoeui.ttf"))
            )
            pdfmetrics.registerFont(
                TTFont(latin_bold, str(windows_font_directory / "segoeuib.ttf"))
            )
            pdfmetrics.registerFont(
                TTFont(latin_italic, str(windows_font_directory / "segoeuii.ttf"))
            )
            pdfmetrics.registerFont(
                TTFont(latin_bold_italic, str(windows_font_directory / "segoeuiz.ttf"))
            )
            pdfmetrics.registerFontFamily(
                latin,
                normal=latin,
                bold=latin_bold,
                italic=latin_italic,
                boldItalic=latin_bold_italic,
            )
        except (ImportError, OSError, TTFError, ValueError):
            latin = "MQM-Roboto"
            latin_bold = "MQM-Roboto-Bold"
            latin_italic = "MQM-Roboto-Italic"
            latin_bold_italic = "MQM-Roboto-Bold-Italic"
            if latin not in pdfmetrics.getRegisteredFontNames():
                try:
                    roboto_regular = temporary_directory / "Roboto-Regular.ttf"
                    roboto_bold = temporary_directory / "Roboto-Bold.ttf"
                    roboto_italic = temporary_directory / "Roboto-Italic.ttf"
                    roboto_bold_italic = temporary_directory / "Roboto-Bold-Italic.ttf"
                    _instantiate_roboto_font(
                        font_directory / "Roboto-Variable.ttf",
                        roboto_regular,
                        400,
                        "Regular",
                        "Roboto-Regular",
                    )
                    _instantiate_roboto_font(
                        font_directory / "Roboto-Variable.ttf",
                        roboto_bold,
                        700,
                        "Bold",
                        "Roboto-Bold",
                    )
                    _instantiate_roboto_font(
                        font_directory / "Roboto-Italic-Variable.ttf",
                        roboto_italic,
                        400,
                        "Italic",
                        "Roboto-Italic",
                    )
                    _instantiate_roboto_font(
                        font_directory / "Roboto-Italic-Variable.ttf",
                        roboto_bold_italic,
                        700,
                        "Bold Italic",
                        "Roboto-BoldItalic",
                    )
                    pdfmetrics.registerFont(TTFont(latin, str(roboto_regular)))
                    pdfmetrics.registerFont(TTFont(latin_bold, str(roboto_bold)))
                    pdfmetrics.registerFont(TTFont(latin_italic, str(roboto_italic)))
                    pdfmetrics.registerFont(TTFont(latin_bold_italic, str(roboto_bold_italic)))
                    pdfmetrics.registerFontFamily(
                        latin,
                        normal=latin,
                        bold=latin_bold,
                        italic=latin_italic,
                        boldItalic=latin_bold_italic,
                    )
                except (ImportError, OSError, TTFError, ValueError):
                    latin = "Helvetica"
                    latin_bold = "Helvetica-Bold"
                    latin_italic = "Helvetica-Oblique"
                    latin_bold_italic = "Helvetica-BoldOblique"

    japanese = "MQM-BIZ-UDGothic"
    japanese_bold = "MQM-BIZ-UDGothic-Bold"
    if japanese not in registered:
        try:
            pdfmetrics.registerFont(
                TTFont(japanese, str(windows_font_directory / "BIZ-UDGothicR.ttc"), subfontIndex=0)
            )
            pdfmetrics.registerFont(
                TTFont(
                    japanese_bold,
                    str(windows_font_directory / "BIZ-UDGothicB.ttc"),
                    subfontIndex=0,
                )
            )
            pdfmetrics.registerFontFamily(
                japanese,
                normal=japanese,
                bold=japanese_bold,
                italic=japanese,
                boldItalic=japanese_bold,
            )
        except (OSError, TTFError, ValueError):
            japanese = "HeiseiKakuGo-W5"
            japanese_bold = japanese
            if japanese not in pdfmetrics.getRegisteredFontNames():
                pdfmetrics.registerFont(UnicodeCIDFont(japanese))

    monospace = "MQM-Cascadia-Mono"
    if monospace not in pdfmetrics.getRegisteredFontNames():
        cascadia_path = windows_font_directory / "CascadiaMono.ttf"
        try:
            if not cascadia_path.is_file():
                raise FileNotFoundError(cascadia_path)
            pdfmetrics.registerFont(TTFont(monospace, str(cascadia_path)))
        except (OSError, TTFError, ValueError):
            monospace = japanese

    return _PdfFonts(
        latin,
        latin_bold,
        latin_italic,
        latin_bold_italic,
        japanese,
        japanese_bold,
        monospace,
    )


def _prepare_math_assets(markdown_text: str, temporary_directory: Path) -> tuple[str, dict[str, _MathAsset]]:
    from .math_renderer import _math_baseline_from_top, normalize_math_expression

    analysis = analyze_markdown(markdown_text)
    assets: dict[str, _MathAsset] = {}
    replacements: list[tuple[int, int, str]] = []

    for index, expression in enumerate(analysis.math_expressions):
        token = f"{_MATH_TOKEN_PREFIX}{index}END"
        if expression.display:
            font_size = PDF_DISPLAY_MATH_FONT_SIZE
        elif expression.heading_level is not None:
            font_size = PDF_HEADING_FONT_SIZES[expression.heading_level - 1]
        elif any(table.start <= expression.start < table.end for table in analysis.tables):
            font_size = PDF_TABLE_MATH_FONT_SIZE
        else:
            font_size = PDF_INLINE_MATH_FONT_SIZE
        render_dpi = PDF_DISPLAY_MATH_DPI if expression.display else PDF_INLINE_MATH_DPI
        try:
            image_bytes = render_math_png(
                expression.expression,
                font_size,
                render_dpi,
                vertical_padding_points=(
                    PDF_DISPLAY_MATH_VERTICAL_PADDING_POINTS if expression.display else 0.0
                ),
                allow_structured=expression.display,
            )
            image_path = temporary_directory / f"math-{index}.png"
            image_path.write_bytes(image_bytes)
            with PillowImage.open(image_path) as rendered_image:
                width = rendered_image.width * 72.0 / render_dpi
                height = rendered_image.height * 72.0 / render_dpi
            baseline = None
            if not expression.display:
                baseline = (
                    _math_baseline_from_top(
                        normalize_math_expression(expression.expression),
                        font_size,
                        render_dpi,
                        0.0,
                        "#20242b",
                    )
                    * 72.0
                    / render_dpi
                )
            maximum_inline_height = font_size * 1.65
            if not expression.display and height > maximum_inline_height:
                scale = maximum_inline_height / height
                width *= scale
                height *= scale
                if baseline is not None:
                    baseline *= scale
            asset = _MathAsset(
                token,
                expression.expression,
                image_path,
                expression.display,
                width,
                height,
                baseline,
                font_size,
            )
        except (OSError, RuntimeError, ValueError):
            delimiter = "$$" if expression.display else "$"
            asset = _MathAsset(
                token,
                f"{delimiter}{expression.expression}{delimiter}",
                None,
                expression.display,
                font_size=font_size,
            )
        assets[token] = asset
        replacements.append((expression.start, expression.end, token))

    converted_text = markdown_text
    for start, end, token in reversed(replacements):
        converted_text = f"{converted_text[:start]}{token}{converted_text[end:]}"
    return converted_text, assets


def _prepare_list_assets(markdown_text: str) -> tuple[str, dict[str, _ListBlockAsset]]:
    markers = analyze_markdown(markdown_text).list_markers
    if not markers:
        return markdown_text, {}

    line_starts = [0]
    line_starts.extend(match.end() for match in re.finditer(r"\n", markdown_text))
    line_start_to_number = {start: number for number, start in enumerate(line_starts)}
    records: list[tuple[int, int, int, _ListItemAsset]] = []
    for marker in markers:
        line_start = markdown_text.rfind("\n", 0, marker.start) + 1
        line_end = markdown_text.find("\n", marker.end)
        if line_end == -1:
            line_end = len(markdown_text)
        content_start = marker.end
        while content_start < line_end and markdown_text[content_start] in " \t":
            content_start += 1
        records.append(
            (
                line_start_to_number[line_start],
                line_start,
                line_end,
                _ListItemAsset(
                    markdown_text[content_start:line_end],
                    marker.label,
                    marker.depth,
                    marker.ordered,
                ),
            )
        )

    groups: list[list[tuple[int, int, int, _ListItemAsset]]] = []
    for record in records:
        if not groups or record[0] != groups[-1][-1][0] + 1:
            groups.append([record])
        else:
            groups[-1].append(record)

    assets: dict[str, _ListBlockAsset] = {}
    replacements: list[tuple[int, int, str]] = []
    for index, group in enumerate(groups):
        token = f"{_LIST_TOKEN_PREFIX}{index}END"
        block_start = group[0][1]
        block_end = group[-1][2]
        if block_end < len(markdown_text) and markdown_text[block_end] == "\n":
            block_end += 1
        assets[token] = _ListBlockAsset(token, tuple(record[3] for record in group))
        replacements.append((block_start, block_end, f"\n\n{token}\n\n"))

    converted_text = markdown_text
    for start, end, replacement in reversed(replacements):
        converted_text = f"{converted_text[:start]}{replacement}{converted_text[end:]}"
    return converted_text, assets


def _convert_task_markers(markdown_text: str) -> str:
    pattern = re.compile(r"(?m)^(\s*[-+*][ \t]+)\[([ xX])\][ \t]+")
    return pattern.sub(lambda match: f"{match.group(1)}{'☑' if match.group(2).lower() == 'x' else '☐'} ", markdown_text)


def _normalize_list_indentation(markdown_text: str) -> str:
    """Adapt the editor's flexible list indentation to Python-Markdown's four-space nesting."""

    replacements: dict[tuple[int, int], str] = {}
    for marker in analyze_markdown(markdown_text).list_markers:
        line_start = markdown_text.rfind("\n", 0, marker.start) + 1
        indentation = markdown_text[line_start:marker.start]
        if indentation.strip():
            continue
        replacements[(line_start, marker.start)] = "    " * marker.depth

    normalized = markdown_text
    for (start, end), indentation in sorted(replacements.items(), reverse=True):
        normalized = f"{normalized[:start]}{indentation}{normalized[end:]}"
    return normalized


def _markdown_to_html(markdown_text: str) -> str:
    import markdown
    from markdown.extensions import Extension
    from markdown.inlinepatterns import SimpleTagInlineProcessor

    class _StrikethroughExtension(Extension):
        def extendMarkdown(self, markdown_instance: markdown.Markdown) -> None:  # type: ignore[name-defined]
            if "$" not in markdown_instance.ESCAPED_CHARS:
                markdown_instance.ESCAPED_CHARS.append("$")
            markdown_instance.inlinePatterns.register(
                SimpleTagInlineProcessor(r"()~~(?!\s)(.+?)(?<!\s)~~", "del"),
                "mqm-strikethrough",
                175,
            )

    return markdown.markdown(
        _convert_task_markers(_normalize_list_indentation(markdown_text)),
        extensions=["extra", "legacy_em", "sane_lists", "nl2br", _StrikethroughExtension()],
        output_format="html5",
    )


def _parse_html(rendered_html: str) -> _HtmlNode:
    parser = _HtmlTreeParser()
    parser.feed(rendered_html)
    parser.close()
    return parser.root


def _uses_japanese_font(character: str) -> bool:
    return is_japanese_character(character) or ord(character) >= 0x2500


def _text_font_markup(
    value: str,
    fonts: _PdfFonts,
    *,
    bold: bool = False,
    italic: bool = False,
    monospace: bool = False,
) -> str:
    if not value:
        return ""
    fragments: list[str] = []
    run: list[str] = []
    current_font: str | None = None
    for character in value:
        if _uses_japanese_font(character):
            font_name = fonts.japanese_bold if bold else fonts.japanese
        elif monospace:
            font_name = fonts.monospace
        elif bold and italic:
            font_name = fonts.latin_bold_italic
        elif bold:
            font_name = fonts.latin_bold
        elif italic:
            font_name = fonts.latin_italic
        else:
            font_name = fonts.latin
        if current_font is None:
            current_font = font_name
        elif font_name != current_font:
            fragments.append(f'<font name="{current_font}">{escape("".join(run))}</font>')
            run.clear()
            current_font = font_name
        run.append(character)
    if run and current_font is not None:
        fragments.append(f'<font name="{current_font}">{escape("".join(run))}</font>')
    return "".join(fragments)


class _PdfFlowableRenderer:
    def __init__(
        self,
        *,
        fonts: _PdfFonts,
        math_assets: dict[str, _MathAsset],
        list_assets: dict[str, _ListBlockAsset],
        markdown_directory: Path,
        available_width: float,
    ) -> None:
        from reportlab.lib import colors
        from reportlab.lib.enums import TA_CENTER, TA_LEFT
        from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet

        self.fonts = fonts
        self.math_assets = math_assets
        self.list_assets = list_assets
        self.markdown_directory = markdown_directory
        self.available_width = available_width
        sample_styles = getSampleStyleSheet()
        self.styles: dict[str, object] = {
            "body": ParagraphStyle(
                "MQMBody",
                parent=sample_styles["BodyText"],
                fontName=fonts.latin,
                fontSize=PDF_BODY_FONT_SIZE,
                leading=16,
                textColor=colors.HexColor("#20242b"),
                alignment=TA_LEFT,
                spaceBefore=0,
                spaceAfter=6,
            ),
            "quote": ParagraphStyle(
                "MQMQuote",
                parent=sample_styles["BodyText"],
                fontName=fonts.latin,
                fontSize=PDF_BODY_FONT_SIZE,
                leading=16,
                textColor=colors.HexColor("#4b5563"),
                leftIndent=14,
                rightIndent=6,
                spaceAfter=6,
            ),
            "list": ParagraphStyle(
                "MQMList",
                parent=sample_styles["BodyText"],
                fontName=fonts.latin,
                fontSize=PDF_BODY_FONT_SIZE,
                leading=15,
                textColor=colors.HexColor("#20242b"),
                spaceAfter=2,
            ),
            "table": ParagraphStyle(
                "MQMTable",
                parent=sample_styles["BodyText"],
                fontName=fonts.latin,
                fontSize=PDF_TABLE_FONT_SIZE,
                leading=14,
                textColor=colors.HexColor("#20242b"),
            ),
            "code": ParagraphStyle(
                "MQMCode",
                parent=sample_styles["Code"],
                fontName=fonts.monospace,
                fontSize=PDF_CODE_FONT_SIZE,
                leading=14,
                textColor=colors.HexColor("#111827"),
                backColor=colors.HexColor("#f3f4f6"),
                borderPadding=7,
                leftIndent=4,
                rightIndent=4,
                spaceBefore=4,
                spaceAfter=8,
            ),
            "code_language": ParagraphStyle(
                "MQMCodeLanguage",
                parent=sample_styles["BodyText"],
                fontName=fonts.latin_bold,
                fontSize=PDF_CODE_LANGUAGE_FONT_SIZE,
                leading=14,
                textColor=colors.HexColor("#6b7280"),
                backColor=colors.HexColor("#f3f4f6"),
                borderPadding=(5, 7, 3, 7),
                leftIndent=4,
                rightIndent=4,
                spaceBefore=4,
                spaceAfter=2,
            ),
            "caption": ParagraphStyle(
                "MQMCaption",
                parent=sample_styles["BodyText"],
                fontName=fonts.latin,
                fontSize=8.5,
                leading=11,
                textColor=colors.HexColor("#6b7280"),
                alignment=TA_CENTER,
                spaceAfter=7,
            ),
        }
        for level, font_size in enumerate(PDF_HEADING_FONT_SIZES, start=1):
            self.styles[f"h{level}"] = ParagraphStyle(
                f"MQMHeading{level}",
                parent=sample_styles[f"Heading{min(level, 6)}"],
                fontName=fonts.latin_bold,
                fontSize=font_size,
                leading=font_size * 1.25,
                textColor=colors.HexColor("#111827"),
                spaceBefore=10 if level > 1 else 4,
                spaceAfter=6,
                keepWithNext=True,
            )

    def render(self, root: _HtmlNode) -> list[object]:
        return self._render_children(root, quote_depth=0)

    def _render_children(self, node: _HtmlNode, *, quote_depth: int) -> list[object]:
        flowables: list[object] = []
        for child in node.children:
            if isinstance(child, str):
                if child.strip():
                    flowables.append(self._paragraph(_text_font_markup(child.strip(), self.fonts), "body"))
                continue
            flowables.extend(self._render_block(child, quote_depth=quote_depth))
        return flowables

    def _render_block(self, node: _HtmlNode, *, quote_depth: int) -> list[object]:
        from reportlab.lib import colors
        from reportlab.platypus import HRFlowable, Spacer
        from reportlab.platypus.xpreformatted import XPreformatted

        tag = node.tag
        if tag in {"script", "style"}:
            return []
        if tag == "p":
            list_asset = self._single_list_asset(node)
            if list_asset is not None:
                return self._list_asset_flowables(list_asset, quote_depth=quote_depth)
            math_asset = self._single_display_math(node)
            if math_asset is not None:
                return [self._math_image(math_asset), Spacer(1, 7)]
            standalone_image = self._single_image(node)
            if standalone_image is not None:
                return self._standalone_image(standalone_image)
            style_name = "quote" if quote_depth else "body"
            return self._paragraph_flowables(
                node,
                style_name=style_name,
                quote_depth=quote_depth,
            )
        if re.fullmatch(r"h[1-6]", tag):
            return [self._paragraph(self._inline_markup(node, bold=True), tag)]
        if tag == "blockquote":
            return self._render_children(node, quote_depth=quote_depth + 1)
        if tag in {"ul", "ol"}:
            return [self._list_flowable(node, depth=0, quote_depth=quote_depth)]
        if tag == "pre":
            code_node = next(self._descendants(node, "code"), None)
            code_text = self._raw_text(code_node or node).rstrip("\n")
            flowables: list[object] = []
            if code_node is not None:
                classes = code_node.attrs.get("class", "").split()
                language = next(
                    (value.removeprefix("language-") for value in classes if value.startswith("language-")),
                    "",
                )
                if language:
                    flowables.append(
                        self._paragraph(
                            _text_font_markup(language, self.fonts, bold=True),
                            "code_language",
                        )
                    )
            flowables.append(XPreformatted(escape(code_text), self.styles["code"]))
            return flowables
        if tag == "table":
            return [self._table_flowable(node)]
        if tag == "hr":
            return [
                Spacer(1, 4),
                HRFlowable(width="100%", thickness=0.8, color=colors.HexColor("#9ca3af")),
                Spacer(1, 8),
            ]
        if tag == "img":
            return self._standalone_image(node)
        return self._render_children(node, quote_depth=quote_depth)

    def _paragraph(self, markup: str, style_name: str, *, quote_depth: int = 0):
        from reportlab.platypus import Paragraph

        style = self.styles[style_name]
        if quote_depth and style_name == "quote":
            markup = self._quote_markup(markup, quote_depth)
        if quote_depth <= 1 or style_name != "quote":
            return Paragraph(markup, style)
        derived_style = style.clone(f"MQMQuoteDepth{quote_depth}")
        derived_style.leftIndent += (quote_depth - 1) * 12
        return Paragraph(markup, derived_style)

    @staticmethod
    def _quote_markup(markup: str, quote_depth: int) -> str:
        markers = " ".join("&gt;" for _ in range(quote_depth))
        marker = f'<font color="#94a3b8"><b>{markers}</b></font> '
        return marker + markup.replace("<br/>", f"<br/>{marker}")

    def _paragraph_flowables(
        self,
        node: _HtmlNode,
        *,
        style_name: str,
        quote_depth: int = 0,
    ) -> list[object]:
        from reportlab.platypus import Spacer

        display_tokens = {
            token: asset
            for token, asset in self.math_assets.items()
            if asset.display
        }
        if not display_tokens:
            markup = self._inline_markup(node)
            return [self._paragraph(markup or "&#160;", style_name, quote_depth=quote_depth)]

        token_pattern = re.compile(
            "(" + "|".join(re.escape(token) for token in display_tokens) + ")"
        )
        segments: list[list[_HtmlChild] | _MathAsset] = []
        inline_children: list[_HtmlChild] = []

        def flush_inline() -> None:
            while (
                inline_children
                and isinstance(inline_children[-1], _HtmlNode)
                and inline_children[-1].tag == "br"
            ):
                inline_children.pop()
            if inline_children:
                segments.append(inline_children.copy())
                inline_children.clear()

        for child in node.children:
            if not isinstance(child, str):
                inline_children.append(child)
                continue
            for part in token_pattern.split(child):
                asset = display_tokens.get(part)
                if asset is None:
                    if part:
                        inline_children.append(part)
                else:
                    flush_inline()
                    segments.append(asset)
        flush_inline()

        flowables: list[object] = []
        for segment in segments:
            if isinstance(segment, _MathAsset):
                flowables.extend((self._math_image(segment), Spacer(1, 7)))
                continue
            temporary_node = _HtmlNode("span", children=segment)
            markup = self._inline_markup(temporary_node)
            if markup.strip():
                flowables.append(
                    self._paragraph(markup, style_name, quote_depth=quote_depth)
                )
        return flowables or [self._paragraph("&#160;", style_name, quote_depth=quote_depth)]

    def _inline_markup(
        self,
        node: _HtmlNode,
        *,
        bold: bool = False,
        italic: bool = False,
        monospace: bool = False,
    ) -> str:
        fragments: list[str] = []
        for child in node.children:
            if isinstance(child, str):
                fragments.append(
                    self._text_with_math_markup(
                        child,
                        bold=bold,
                        italic=italic,
                        monospace=monospace,
                    )
                )
                continue
            if child.tag in {"strong", "b"}:
                fragments.append(
                    self._inline_markup(
                        child,
                        bold=True,
                        italic=italic,
                        monospace=monospace,
                    )
                )
            elif child.tag in {"em", "i"}:
                fragments.append(
                    self._inline_markup(
                        child,
                        bold=bold,
                        italic=True,
                        monospace=monospace,
                    )
                )
            elif child.tag in {"del", "s", "strike"}:
                content = self._inline_markup(
                    child,
                    bold=bold,
                    italic=italic,
                    monospace=monospace,
                )
                fragments.append(f"<strike>{content}</strike>")
            elif child.tag == "code":
                code_content = self._inline_markup(
                    child,
                    bold=False,
                    italic=False,
                    monospace=True,
                )
                fragments.append(
                    f'<font backColor="#f3f4f6">{code_content}</font>'
                )
            elif child.tag == "a":
                content = self._inline_markup(
                    child,
                    bold=bold,
                    italic=italic,
                    monospace=monospace,
                )
                href = child.attrs.get("href", "")
                if self._safe_link(href):
                    fragments.append(
                        f'<u><a href="{escape(href, quote=True)}" color="#2563eb">'
                        f"{content}</a></u>"
                    )
                else:
                    fragments.append(content)
            elif child.tag == "br":
                fragments.append("<br/>")
            elif child.tag == "img":
                fragments.append(self._inline_image_markup(child))
            elif child.tag not in {"script", "style"}:
                fragments.append(
                    self._inline_markup(
                        child,
                        bold=bold,
                        italic=italic,
                        monospace=monospace,
                    )
                )
        return "".join(fragments)

    def _text_with_math_markup(
        self,
        value: str,
        *,
        bold: bool,
        italic: bool,
        monospace: bool,
    ) -> str:
        tokens = [token for token in self.math_assets if token in value]
        if not tokens:
            return _text_font_markup(
                value,
                self.fonts,
                bold=bold,
                italic=italic,
                monospace=monospace,
            )
        pattern = re.compile("(" + "|".join(re.escape(token) for token in tokens) + ")")
        fragments: list[str] = []
        for part in pattern.split(value):
            asset = self.math_assets.get(part)
            if asset is None:
                fragments.append(
                    _text_font_markup(
                        part,
                        self.fonts,
                        bold=bold,
                        italic=italic,
                        monospace=monospace,
                    )
                )
            elif asset.path is None:
                fragments.append(
                    _text_font_markup(
                        asset.source,
                        self.fonts,
                        bold=bold,
                        italic=italic,
                        monospace=monospace,
                    )
                )
            else:
                if asset.baseline is None:
                    vertical_alignment = -max(0.0, asset.height * 0.18)
                else:
                    vertical_alignment = -max(0.0, asset.height - asset.baseline)
                fragments.append(
                    f'<img src="{escape(str(asset.path), quote=True)}" '
                    f'width="{asset.width:.2f}" height="{asset.height:.2f}" '
                    f'valign="{vertical_alignment:.2f}"/>'
                )
        return "".join(fragments)

    def _single_display_math(self, node: _HtmlNode) -> _MathAsset | None:
        if any(isinstance(child, _HtmlNode) for child in node.children):
            return None
        text = "".join(child for child in node.children if isinstance(child, str)).strip()
        asset = self.math_assets.get(text)
        return asset if asset is not None and asset.display else None

    def _single_list_asset(self, node: _HtmlNode) -> _ListBlockAsset | None:
        if any(isinstance(child, _HtmlNode) and child.tag != "br" for child in node.children):
            return None
        text = "".join(child for child in node.children if isinstance(child, str)).strip()
        return self.list_assets.get(text)

    def _math_image(self, asset: _MathAsset):
        from reportlab.platypus import Image

        if asset.path is None:
            return self._paragraph(_text_font_markup(asset.source, self.fonts), "body")
        width = asset.width
        height = asset.height
        if width > self.available_width:
            scale = self.available_width / width
            width *= scale
            height *= scale
        image = Image(str(asset.path), width=width, height=height)
        image.hAlign = "CENTER"
        return image

    def _single_image(self, node: _HtmlNode) -> _HtmlNode | None:
        meaningful_children = [
            child for child in node.children if not (isinstance(child, str) and not child.strip())
        ]
        if len(meaningful_children) == 1 and isinstance(meaningful_children[0], _HtmlNode):
            image = meaningful_children[0]
            return image if image.tag == "img" else None
        return None

    def _resolve_image_path(self, source: str) -> Path | None:
        parsed = urlparse(source)
        if parsed.scheme and parsed.scheme.lower() != "file":
            return None
        if parsed.scheme.lower() == "file":
            candidate = Path(unquote(parsed.path.lstrip("/")))
        else:
            candidate = Path(unquote(parsed.path))
        if not candidate.is_absolute():
            candidate = self.markdown_directory / candidate
        try:
            resolved = candidate.resolve()
        except OSError:
            return None
        return resolved if resolved.is_file() else None

    def _standalone_image(self, node: _HtmlNode) -> list[object]:
        from reportlab.platypus import Image, Paragraph, Spacer

        source = node.attrs.get("src", "")
        alt_text = node.attrs.get("alt", "")
        image_path = self._resolve_image_path(source)
        if image_path is None:
            label = alt_text or source or "画像"
            return [Paragraph(_text_font_markup(f"[画像: {label}]", self.fonts), self.styles["caption"])]
        try:
            image = Image(str(image_path))
            maximum_height = 520.0
            scale = min(1.0, self.available_width / image.imageWidth, maximum_height / image.imageHeight)
            image.drawWidth = image.imageWidth * scale
            image.drawHeight = image.imageHeight * scale
            image.hAlign = "CENTER"
        except (OSError, ValueError):
            label = alt_text or image_path.name
            return [Paragraph(_text_font_markup(f"[画像: {label}]", self.fonts), self.styles["caption"])]
        return [image, Spacer(1, 7)]

    def _inline_image_markup(self, node: _HtmlNode) -> str:
        image_path = self._resolve_image_path(node.attrs.get("src", ""))
        if image_path is None:
            return _text_font_markup(f"[画像: {node.attrs.get('alt', '') or '未表示'}]", self.fonts)
        try:
            with PillowImage.open(image_path) as image:
                width, height = image.size
        except (OSError, ValueError):
            return _text_font_markup(f"[画像: {node.attrs.get('alt', '') or '未表示'}]", self.fonts)
        maximum_height = 16.0
        scale = min(1.0, maximum_height / max(1, height))
        return (
            f'<img src="{escape(str(image_path), quote=True)}" '
            f'width="{width * scale:.2f}" height="{height * scale:.2f}" valign="-2"/>'
        )

    @staticmethod
    def _safe_link(target: str) -> bool:
        scheme = urlparse(target).scheme.lower()
        return scheme in {"", "http", "https", "mailto"}

    def _list_flowable(self, node: _HtmlNode, *, depth: int, quote_depth: int):
        from reportlab.platypus import ListFlowable, ListItem

        list_items: list[object] = []
        for child in node.children:
            if not isinstance(child, _HtmlNode) or child.tag != "li":
                continue
            item_flowables: list[object] = []
            inline_children: list[_HtmlChild] = []
            for item_child in child.children:
                if isinstance(item_child, _HtmlNode) and item_child.tag in {"ul", "ol"}:
                    if inline_children:
                        item_flowables.append(self._list_item_paragraph(inline_children, quote_depth))
                        inline_children = []
                    item_flowables.append(
                        self._list_flowable(item_child, depth=depth + 1, quote_depth=quote_depth)
                    )
                elif isinstance(item_child, _HtmlNode) and item_child.tag in _BLOCK_HTML_TAGS:
                    if inline_children:
                        item_flowables.append(self._list_item_paragraph(inline_children, quote_depth))
                        inline_children = []
                    if item_child.tag == "p":
                        item_flowables.append(self._list_item_paragraph(item_child.children, quote_depth))
                    else:
                        item_flowables.extend(self._render_block(item_child, quote_depth=quote_depth))
                else:
                    inline_children.append(item_child)
            if inline_children:
                item_flowables.append(self._list_item_paragraph(inline_children, quote_depth))
            if not item_flowables:
                item_flowables.append(self._paragraph("&#160;", "list"))
            list_items.append(ListItem(item_flowables, leftIndent=9))

        ordered = node.tag == "ol"
        start_value: int | str
        if ordered:
            try:
                start_value = int(node.attrs.get("start", "1"))
            except ValueError:
                start_value = 1
        else:
            start_value = "●" if depth == 0 else "○"
        return ListFlowable(
            list_items,
            bulletType="1" if ordered else "bullet",
            start=start_value,
            leftIndent=18,
            bulletFontName=self.fonts.japanese_bold if not ordered else self.fonts.latin_bold,
            bulletFontSize=(
                PDF_LIST_NUMBER_FONT_SIZE if ordered else PDF_LIST_BULLET_FONT_SIZE
            ),
            bulletOffsetY=(
                PDF_LIST_NUMBER_OFFSET_Y if ordered else PDF_LIST_BULLET_OFFSET_Y
            ),
            bulletFormat="%s." if ordered else None,
            spaceAfter=4,
        )

    def _list_asset_flowables(
        self,
        block: _ListBlockAsset,
        *,
        quote_depth: int,
    ) -> list[object]:
        roots: list[_ListTreeItem] = []
        last_at_depth: dict[int, _ListTreeItem] = {}
        for asset in block.items:
            node = _ListTreeItem(asset)
            parent = last_at_depth.get(asset.depth - 1)
            if asset.depth > 0 and parent is not None:
                parent.children.append(node)
            else:
                roots.append(node)
            last_at_depth[asset.depth] = node
            for deeper_depth in [depth for depth in last_at_depth if depth > asset.depth]:
                del last_at_depth[deeper_depth]
        return self._render_list_groups(roots, depth=0, quote_depth=quote_depth)

    def _render_list_groups(
        self,
        nodes: list[_ListTreeItem],
        *,
        depth: int,
        quote_depth: int,
    ) -> list[object]:
        from reportlab.platypus import ListFlowable, ListItem

        flowables: list[object] = []
        group: list[_ListTreeItem] = []
        group_key: tuple[bool, str] | None = None

        def flush_group() -> None:
            nonlocal group, group_key
            if not group or group_key is None:
                return
            ordered, suffix = group_key
            list_items: list[object] = []
            for tree_item in group:
                item_flowables = self._list_content_flowables(
                    tree_item.asset.content,
                    quote_depth=quote_depth,
                )
                if tree_item.children:
                    item_flowables.extend(
                        self._render_list_groups(
                            tree_item.children,
                            depth=depth + 1,
                            quote_depth=quote_depth,
                        )
                    )
                list_item = ListItem(item_flowables, leftIndent=8)
                if ordered:
                    match = re.match(r"\d+", tree_item.asset.label)
                    if match is not None:
                        list_item.value = int(match.group(0))
                list_items.append(list_item)

            if ordered:
                first_match = re.match(r"\d+", group[0].asset.label)
                start: int | str = int(first_match.group(0)) if first_match else 1
            else:
                start = "●" if depth == 0 else "○"
            flowables.append(
                ListFlowable(
                    list_items,
                    bulletType="1" if ordered else "bullet",
                    start=start,
                    leftIndent=18,
                    bulletFontName=(
                        self.fonts.latin_bold if ordered else self.fonts.japanese_bold
                    ),
                    bulletFontSize=(
                        PDF_LIST_NUMBER_FONT_SIZE if ordered else PDF_LIST_BULLET_FONT_SIZE
                    ),
                    bulletOffsetY=(
                        PDF_LIST_NUMBER_OFFSET_Y if ordered else PDF_LIST_BULLET_OFFSET_Y
                    ),
                    bulletFormat=f"%s{suffix}" if ordered else None,
                    spaceAfter=4,
                )
            )
            group = []
            group_key = None

        for node in nodes:
            suffix = ")" if node.asset.label.endswith(")") else "."
            key = (node.asset.ordered, suffix)
            if group_key is not None and key != group_key:
                flush_group()
            group_key = key
            group.append(node)
        flush_group()
        return flowables

    def _list_content_flowables(self, content: str, *, quote_depth: int) -> list[object]:
        root = _parse_html(_markdown_to_html(content))
        flowables: list[object] = []
        for child in root.children:
            if isinstance(child, str):
                if child.strip():
                    flowables.append(
                        self._paragraph(_text_font_markup(child, self.fonts), "list")
                    )
            elif child.tag == "p":
                flowables.extend(
                    self._paragraph_flowables(
                        child,
                        style_name="quote" if quote_depth else "list",
                        quote_depth=quote_depth,
                    )
                )
            else:
                flowables.extend(self._render_block(child, quote_depth=quote_depth))
        return flowables or [self._paragraph("&#160;", "list")]

    def _list_item_paragraph(self, children: list[_HtmlChild], quote_depth: int):
        temporary_node = _HtmlNode("span", children=children)
        return self._paragraph(
            self._inline_markup(temporary_node) or "&#160;",
            "quote" if quote_depth else "list",
            quote_depth=quote_depth,
        )

    def _table_flowable(self, node: _HtmlNode):
        from reportlab.lib import colors
        from reportlab.platypus import Paragraph, Table, TableStyle

        rows: list[list[object]] = []
        alignments: dict[tuple[int, int], str] = {}
        for row_node in self._descendants(node, "tr"):
            row: list[object] = []
            for column, cell in enumerate(
                child
                for child in row_node.children
                if isinstance(child, _HtmlNode) and child.tag in {"th", "td"}
            ):
                markup = self._inline_markup(cell, bold=cell.tag == "th") or "&#160;"
                row.append(Paragraph(markup, self.styles["table"]))
                style_value = cell.attrs.get("style", "")
                alignment_match = re.search(r"text-align\s*:\s*(left|center|right)", style_value)
                if alignment_match:
                    alignments[(len(rows), column)] = alignment_match.group(1).upper()
            if row:
                rows.append(row)

        if not rows:
            return self._paragraph("&#160;", "body")
        column_count = max(len(row) for row in rows)
        for row in rows:
            row.extend([Paragraph("&#160;", self.styles["table"])] * (column_count - len(row)))
        table = Table(
            rows,
            colWidths=[self.available_width / column_count] * column_count,
            repeatRows=1,
            hAlign="LEFT",
        )
        commands: list[tuple[object, ...]] = [
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            (
                "LINEABOVE",
                (0, 0),
                (-1, 0),
                PDF_TABLE_STRONG_LINE_WIDTH,
                colors.HexColor("#6b7280"),
            ),
            ("BOTTOMPADDING", (0, 0), (-1, 0), 6),
            ("TOPPADDING", (0, 1), (-1, -1), 5),
            ("BOTTOMPADDING", (0, 1), (-1, -1), 5),
            ("LEFTPADDING", (0, 0), (-1, -1), 5),
            ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ]
        if len(rows) > 1:
            commands.append(
                (
                    "LINEBELOW",
                    (0, 0),
                    (-1, 0),
                    PDF_TABLE_STRONG_LINE_WIDTH,
                    colors.HexColor("#6b7280"),
                )
            )
            for row_index in range(1, len(rows) - 1):
                commands.append(
                    (
                        "LINEBELOW",
                        (0, row_index),
                        (-1, row_index),
                        PDF_TABLE_LINE_WIDTH,
                        colors.HexColor("#9ca3af"),
                    )
                )
        commands.append(
            (
                "LINEBELOW",
                (0, -1),
                (-1, -1),
                PDF_TABLE_STRONG_LINE_WIDTH,
                colors.HexColor("#6b7280"),
            )
        )
        for (row_index, column_index), alignment in alignments.items():
            commands.append(("ALIGN", (column_index, row_index), (column_index, row_index), alignment))
        table.setStyle(TableStyle(commands))
        return table

    @staticmethod
    def _descendants(node: _HtmlNode, tag: str):
        for child in node.children:
            if not isinstance(child, _HtmlNode):
                continue
            if child.tag == tag:
                yield child
            else:
                yield from _PdfFlowableRenderer._descendants(child, tag)

    @staticmethod
    def _raw_text(node: _HtmlNode) -> str:
        fragments: list[str] = []
        for child in node.children:
            if isinstance(child, str):
                fragments.append(child)
            else:
                fragments.append(_PdfFlowableRenderer._raw_text(child))
        return "".join(fragments)


def export_markdown_to_pdf(markdown_text: str, markdown_path: Path, output_path: Path) -> Path:
    """Render ``markdown_text`` to an atomically replaced PDF file."""

    from reportlab.lib.pagesizes import A4
    from reportlab.lib.units import mm
    from reportlab.platypus import SimpleDocTemplate

    markdown_path = markdown_path.resolve()
    output_path = output_path.with_suffix(".pdf").resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_pdf_handle, temporary_pdf_name = tempfile.mkstemp(
        prefix=f".{output_path.stem}-",
        suffix=".pdf.tmp",
        dir=output_path.parent,
    )
    os.close(temporary_pdf_handle)
    temporary_pdf_path = Path(temporary_pdf_name)
    try:
        with tempfile.TemporaryDirectory(prefix="markdown-quick-memo-pdf-") as directory:
            temporary_directory = Path(directory)
            fonts = _register_pdf_fonts(temporary_directory)
            math_markdown, math_assets = _prepare_math_assets(
                markdown_text,
                temporary_directory,
            )
            prepared_markdown, list_assets = _prepare_list_assets(math_markdown)
            root = _parse_html(_markdown_to_html(prepared_markdown))
            document = SimpleDocTemplate(
                str(temporary_pdf_path),
                pagesize=A4,
                rightMargin=20 * mm,
                leftMargin=20 * mm,
                topMargin=18 * mm,
                bottomMargin=18 * mm,
                title=markdown_path.stem,
                author="Markdown Quick Memo",
            )
            renderer = _PdfFlowableRenderer(
                fonts=fonts,
                math_assets=math_assets,
                list_assets=list_assets,
                markdown_directory=markdown_path.parent,
                available_width=document.width,
            )
            story = renderer.render(root)
            if not story:
                story.append(renderer._paragraph("&#160;", "body"))
            document.build(story)
        os.replace(temporary_pdf_path, output_path)
    finally:
        temporary_pdf_path.unlink(missing_ok=True)
    return output_path
