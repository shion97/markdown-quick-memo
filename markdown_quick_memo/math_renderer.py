"""MathTextの遅延読み込み、互換変換、複合数式描画、PNGキャッシュ。"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from functools import lru_cache
from io import BytesIO
from math import ceil
import re
from threading import Event, RLock
from typing import Any


MathRenderRequest = tuple[str, int, int, float]
_render_lock = RLock()
_preload_complete = Event()
_font_properties: type[Any] | None = None
_math_text_parser: Any | None = None
_figure_type: type[Any] | None = None
MATH_FONT_FAMILY = "cm"
MATH_HORIZONTAL_PADDING_POINTS = 3.0
MATH_MIN_VERTICAL_PADDING_POINTS = 1.0
MATH_RENDER_HORIZONTAL_PADDING_FONT_RATIO = 0.5
MATH_RENDER_VERTICAL_PADDING_FONT_RATIO = 0.5
MATH_CELL_VERTICAL_PADDING_POINTS = 1.5
MATH_COLUMN_GAP_POINTS = 4.0
MATH_ROW_GAP_POINTS = 2.5
MAX_MATH_ENVIRONMENT_ROWS = 20
MAX_MATH_ENVIRONMENT_COLUMNS = 20

_COMMAND_ALIASES = {"tfrac": "frac"}
_SUPPORTED_ENVIRONMENTS = {
    "matrix",
    "pmatrix",
    "bmatrix",
    "Bmatrix",
    "vmatrix",
    "Vmatrix",
    "cases",
    "aligned",
    "align",
    "align*",
}
_ENVIRONMENT_PATTERN = re.compile(
    r"\\begin\{(?P<name>[A-Za-z*]+)\}(?P<body>.*?)\\end\{(?P=name)\}",
    re.DOTALL,
)


@dataclass(frozen=True, slots=True)
class MathEnvironment:
    name: str
    rows: tuple[tuple[str, ...], ...]
    prefix: str = ""
    suffix: str = ""


def normalize_math_expression(expression: str) -> str:
    """MathTextで扱える同等コマンドへ、コマンド単位で安全に変換する。"""

    normalized: list[str] = []
    index = 0
    while index < len(expression):
        if expression[index] != "\\" or index + 1 >= len(expression):
            normalized.append(expression[index])
            index += 1
            continue

        command_end = index + 1
        while command_end < len(expression) and expression[command_end].isalpha():
            command_end += 1
        if command_end == index + 1:
            normalized.append(expression[index])
            index += 1
            continue

        command = expression[index + 1 : command_end]
        normalized.append(f"\\{_COMMAND_ALIASES.get(command, command)}")
        index = command_end
    return "".join(normalized)


def _split_math_rows(value: str) -> tuple[str, ...]:
    rows: list[str] = []
    current: list[str] = []
    brace_depth = 0
    index = 0
    while index < len(value):
        character = value[index]
        if character == "\\":
            if index + 1 < len(value) and value[index + 1] == "\\" and brace_depth == 0:
                rows.append("".join(current).strip())
                current.clear()
                index += 2
                continue
            current.append(character)
            if index + 1 < len(value) and value[index + 1] in "{}&":
                current.append(value[index + 1])
                index += 2
            else:
                index += 1
            continue
        if character == "{":
            brace_depth += 1
        elif character == "}":
            brace_depth -= 1
            if brace_depth < 0:
                raise ValueError("数式の波括弧が対応していません。")
        current.append(character)
        index += 1

    if brace_depth != 0:
        raise ValueError("数式の波括弧が対応していません。")
    rows.append("".join(current).strip())
    while len(rows) > 1 and not rows[-1]:
        rows.pop()
    return tuple(rows)


def _split_math_columns(value: str) -> tuple[str, ...]:
    columns: list[str] = []
    current: list[str] = []
    brace_depth = 0
    index = 0
    while index < len(value):
        character = value[index]
        if character == "\\":
            current.append(character)
            if index + 1 < len(value) and value[index + 1] in "{}&":
                current.append(value[index + 1])
                index += 2
            else:
                index += 1
            continue
        if character == "{":
            brace_depth += 1
        elif character == "}":
            brace_depth -= 1
            if brace_depth < 0:
                raise ValueError("数式の波括弧が対応していません。")
        elif character == "&" and brace_depth == 0:
            columns.append("".join(current).strip())
            current.clear()
            index += 1
            continue
        current.append(character)
        index += 1

    if brace_depth != 0:
        raise ValueError("数式の波括弧が対応していません。")
    columns.append("".join(current).strip())
    return tuple(columns)


def parse_math_environment(expression: str) -> MathEnvironment | None:
    """対応する環境またはトップレベルの複数行数式を解析する。"""

    normalized_expression = normalize_math_expression(expression.strip())
    environment_match = _ENVIRONMENT_PATTERN.search(normalized_expression)
    if environment_match is not None:
        source_name = environment_match.group("name")
        if source_name not in _SUPPORTED_ENVIRONMENTS:
            raise ValueError(f"未対応の数式環境です: {source_name}")
        environment_name = "aligned" if source_name in {"align", "align*"} else source_name
        body = environment_match.group("body")
        prefix = normalized_expression[: environment_match.start()].strip()
        suffix = normalized_expression[environment_match.end() :].strip()
        if "\\begin{" in prefix or "\\begin{" in suffix:
            raise ValueError("一つの独立数式で使用できる複合環境は一つです。")
    else:
        environment_name = "aligned"
        body = normalized_expression
        prefix = ""
        suffix = ""

    source_rows = _split_math_rows(body)
    rows = tuple(_split_math_columns(row) for row in source_rows)
    has_layout_markers = len(rows) > 1 or any(len(row) > 1 for row in rows)
    if environment_match is None and not has_layout_markers:
        return None
    if not rows or all(not any(cell for cell in row) for row in rows):
        raise ValueError("複合数式が空です。")
    if len(rows) > MAX_MATH_ENVIRONMENT_ROWS:
        raise ValueError(f"複合数式は最大{MAX_MATH_ENVIRONMENT_ROWS}行です。")
    if max(len(row) for row in rows) > MAX_MATH_ENVIRONMENT_COLUMNS:
        raise ValueError(f"複合数式は最大{MAX_MATH_ENVIRONMENT_COLUMNS}列です。")
    return MathEnvironment(environment_name, rows, prefix, suffix)


def is_structured_math_expression(expression: str) -> bool:
    return parse_math_environment(expression) is not None


def _load_renderer() -> tuple[type[Any], Any, type[Any]]:
    global _font_properties, _math_text_parser, _figure_type
    if _font_properties is None or _math_text_parser is None or _figure_type is None:
        from matplotlib.figure import Figure
        from matplotlib.font_manager import FontProperties
        from matplotlib.mathtext import MathTextParser

        _font_properties = FontProperties
        _math_text_parser = MathTextParser("path")
        _figure_type = Figure
    return _font_properties, _math_text_parser, _figure_type


@lru_cache(maxsize=512)
def _measure_simple_math(expression: str, font_size: int) -> tuple[float, float, float]:
    font_properties, math_text_parser, _ = _load_renderer()
    properties = font_properties(size=font_size, math_fontfamily=MATH_FONT_FAMILY)
    width, height, depth, _, _ = math_text_parser.parse(
        f"${expression}$",
        dpi=72,
        prop=properties,
    )
    return float(width), float(height), float(depth)


def _effective_vertical_padding(vertical_padding_points: float) -> float:
    return max(MATH_MIN_VERTICAL_PADDING_POINTS, vertical_padding_points)


@lru_cache(maxsize=256)
def _render_simple_math_result_cached(
    expression: str,
    font_size: int,
    dpi: int,
    color: str,
    vertical_padding_points: float,
) -> tuple[bytes, float]:
    font_properties, _, figure_type = _load_renderer()
    formula = f"${expression}$"
    properties = font_properties(size=font_size, math_fontfamily=MATH_FONT_FAMILY)
    width, height, depth = _measure_simple_math(expression, font_size)
    effective_vertical_padding = _effective_vertical_padding(vertical_padding_points)
    render_horizontal_padding = max(
        MATH_HORIZONTAL_PADDING_POINTS,
        font_size * MATH_RENDER_HORIZONTAL_PADDING_FONT_RATIO,
    )
    render_vertical_padding = max(
        effective_vertical_padding,
        font_size * MATH_RENDER_VERTICAL_PADDING_FONT_RATIO,
    )
    padded_width = width + render_horizontal_padding * 2
    padded_height = height + render_vertical_padding * 2

    image_buffer = BytesIO()
    figure = figure_type(figsize=(padded_width / 72.0, padded_height / 72.0))
    figure.text(
        render_horizontal_padding / padded_width,
        (depth + render_vertical_padding) / padded_height,
        formula,
        fontproperties=properties,
        color=color,
    )
    figure.savefig(image_buffer, dpi=dpi, format="png")

    from PIL import Image, ImageChops

    rendered_image = Image.open(image_buffer).convert("RGBA")
    background = Image.new(
        "RGB",
        rendered_image.size,
        rendered_image.getpixel((0, 0))[:3],
    )
    content_bounds = ImageChops.difference(
        rendered_image.convert("RGB"),
        background,
    ).getbbox()
    if content_bounds is None:
        raise ValueError("数式を描画できませんでした。")
    horizontal_padding = _points_to_pixels(MATH_HORIZONTAL_PADDING_POINTS, dpi)
    vertical_padding = _points_to_pixels(effective_vertical_padding, dpi)
    crop_left = max(0, content_bounds[0] - horizontal_padding)
    crop_right = min(rendered_image.width, content_bounds[2] + horizontal_padding)
    crop_top = max(0, content_bounds[1] - vertical_padding)
    crop_bottom = min(rendered_image.height, content_bounds[3] + vertical_padding)
    cropped_image = rendered_image.crop((crop_left, crop_top, crop_right, crop_bottom))
    baseline_from_top = (
        rendered_image.height - (depth + render_vertical_padding) * dpi / 72.0 - crop_top
    )
    cropped_buffer = BytesIO()
    cropped_image.save(cropped_buffer, format="PNG")
    return cropped_buffer.getvalue(), baseline_from_top


def _render_simple_math_png_cached(
    expression: str,
    font_size: int,
    dpi: int,
    color: str,
    vertical_padding_points: float,
) -> bytes:
    return _render_simple_math_result_cached(
        expression,
        font_size,
        dpi,
        color,
        vertical_padding_points,
    )[0]


def _points_to_pixels(points: float, dpi: int) -> int:
    return max(1, round(points * dpi / 72.0))


def _blank_math_cell(font_size: int, dpi: int):
    from PIL import Image

    height = max(1, round(font_size * dpi / 72.0 * 1.25))
    return Image.new("RGBA", (1, height), (255, 255, 255, 255))


def _math_baseline_from_top(
    expression: str,
    font_size: int,
    dpi: int,
    vertical_padding_points: float,
    color: str,
) -> float:
    return _render_simple_math_result_cached(
        expression,
        font_size,
        dpi,
        color,
        vertical_padding_points,
    )[1]


def _baseline_aligned_row_layout(
    cell_heights: tuple[int, ...],
    cell_baselines: tuple[float, ...],
) -> tuple[int, tuple[int, ...]]:
    row_baseline = ceil(max(cell_baselines))
    row_descent = ceil(
        max(height - baseline for height, baseline in zip(cell_heights, cell_baselines))
    )
    offsets = tuple(round(row_baseline - baseline) for baseline in cell_baselines)
    return row_baseline + row_descent, offsets


def _cell_alignment(environment_name: str, column: int) -> str:
    if environment_name == "aligned":
        return "right" if column % 2 == 0 else "left"
    if environment_name == "cases":
        return "right" if column == 0 else "left"
    return "center"


def _delimiter_specification(environment_name: str) -> tuple[str | None, str | None]:
    return {
        "matrix": (None, None),
        "pmatrix": ("left_parenthesis", "right_parenthesis"),
        "bmatrix": ("left_bracket", "right_bracket"),
        "Bmatrix": ("left_brace", "right_brace"),
        "vmatrix": ("left_bar", "right_bar"),
        "Vmatrix": ("left_double_bar", "right_double_bar"),
        "cases": ("left_brace", None),
        "aligned": (None, None),
    }[environment_name]


def _render_delimiter_image(
    kind: str,
    content_height: int,
    font_size: int,
    dpi: int,
    color: str,
):
    from PIL import Image, ImageChops

    token = {
        "left_parenthesis": "(",
        "right_parenthesis": ")",
        "left_bracket": "[",
        "right_bracket": "]",
        "left_brace": r"\{",
        "right_brace": r"\}",
        "left_bar": "|",
        "right_bar": "|",
        "left_double_bar": r"\Vert",
        "right_double_bar": r"\Vert",
    }[kind]
    image_bytes = _render_simple_math_png_cached(
        token,
        font_size,
        dpi,
        color,
        MATH_CELL_VERTICAL_PADDING_POINTS,
    )
    rendered_image = Image.open(BytesIO(image_bytes)).convert("RGBA")
    background = Image.new(
        "RGB",
        rendered_image.size,
        rendered_image.getpixel((0, 0))[:3],
    )
    content_bounds = ImageChops.difference(rendered_image.convert("RGB"), background).getbbox()
    if content_bounds is None:
        raise ValueError(f"数式区切りを描画できませんでした: {kind}")
    delimiter_image = rendered_image.crop(content_bounds)
    return delimiter_image.resize(
        (delimiter_image.width, content_height),
        Image.Resampling.LANCZOS,
    )


@lru_cache(maxsize=64)
def _render_math_environment_png_cached(
    environment: MathEnvironment,
    font_size: int,
    dpi: int,
    color: str,
    vertical_padding_points: float,
) -> bytes:
    from PIL import Image

    def render_affix(value: str):
        if not value:
            return None
        image_bytes = _render_simple_math_png_cached(
            " ".join(value.splitlines()),
            font_size,
            dpi,
            color,
            MATH_CELL_VERTICAL_PADDING_POINTS,
        )
        return Image.open(BytesIO(image_bytes)).convert("RGBA")

    column_count = max(len(row) for row in environment.rows)
    cell_images: list[list[Any]] = []
    cell_y_offsets: list[tuple[int, ...]] = []
    column_widths = [0] * column_count
    row_heights: list[int] = []
    for row in environment.rows:
        image_row: list[Any] = []
        baseline_row: list[float] = []
        for column in range(column_count):
            cell = row[column] if column < len(row) else ""
            if cell:
                cell_bytes = _render_simple_math_png_cached(
                    " ".join(cell.splitlines()),
                    font_size,
                    dpi,
                    color,
                    MATH_CELL_VERTICAL_PADDING_POINTS,
                )
                cell_image = Image.open(BytesIO(cell_bytes)).convert("RGBA")
                cell_baseline = _math_baseline_from_top(
                    " ".join(cell.splitlines()),
                    font_size,
                    dpi,
                    MATH_CELL_VERTICAL_PADDING_POINTS,
                    color,
                )
            else:
                cell_image = _blank_math_cell(font_size, dpi)
                cell_baseline = cell_image.height * 0.75
            image_row.append(cell_image)
            baseline_row.append(cell_baseline)
            column_widths[column] = max(column_widths[column], cell_image.width)
        cell_images.append(image_row)
        row_height, row_offsets = _baseline_aligned_row_layout(
            tuple(image.height for image in image_row),
            tuple(baseline_row),
        )
        row_heights.append(row_height)
        cell_y_offsets.append(row_offsets)

    column_gap = _points_to_pixels(MATH_COLUMN_GAP_POINTS, dpi)
    row_gap = _points_to_pixels(MATH_ROW_GAP_POINTS, dpi)
    content_width = sum(column_widths) + column_gap * max(0, column_count - 1)
    content_height = sum(row_heights) + row_gap * max(0, len(row_heights) - 1)
    left_kind, right_kind = _delimiter_specification(environment.name)
    left_delimiter = (
        _render_delimiter_image(left_kind, content_height, font_size, dpi, color)
        if left_kind is not None
        else None
    )
    right_delimiter = (
        _render_delimiter_image(right_kind, content_height, font_size, dpi, color)
        if right_kind is not None
        else None
    )
    left_width = left_delimiter.width if left_delimiter is not None else 0
    right_width = right_delimiter.width if right_delimiter is not None else 0
    prefix_image = render_affix(environment.prefix)
    suffix_image = render_affix(environment.suffix)
    prefix_width = prefix_image.width if prefix_image is not None else 0
    suffix_width = suffix_image.width if suffix_image is not None else 0
    delimiter_gap = _points_to_pixels(1.5, dpi)
    left_gap = delimiter_gap if left_kind is not None else 0
    right_gap = delimiter_gap if right_kind is not None else 0
    affix_gap = _points_to_pixels(0.5, dpi)
    prefix_gap = affix_gap if prefix_image is not None else 0
    suffix_gap = affix_gap if suffix_image is not None else 0
    horizontal_padding = _points_to_pixels(MATH_HORIZONTAL_PADDING_POINTS, dpi)
    vertical_padding = _points_to_pixels(vertical_padding_points, dpi)
    structured_width = left_width + left_gap + content_width + right_gap + right_width
    inner_height = max(
        content_height,
        prefix_image.height if prefix_image is not None else 0,
        suffix_image.height if suffix_image is not None else 0,
    )
    total_width = (
        horizontal_padding * 2
        + prefix_width
        + prefix_gap
        + structured_width
        + suffix_gap
        + suffix_width
    )
    total_height = vertical_padding * 2 + inner_height
    output = Image.new("RGBA", (total_width, total_height), (255, 255, 255, 255))

    structured_x = horizontal_padding + prefix_width + prefix_gap
    content_x = structured_x + left_width + left_gap
    content_y = vertical_padding + (inner_height - content_height) // 2
    current_y = content_y
    for row_index, image_row in enumerate(cell_images):
        current_x = content_x
        for column, cell_image in enumerate(image_row):
            alignment = _cell_alignment(environment.name, column)
            if alignment == "right":
                cell_x = current_x + column_widths[column] - cell_image.width
            elif alignment == "center":
                cell_x = current_x + (column_widths[column] - cell_image.width) // 2
            else:
                cell_x = current_x
            cell_y = current_y + cell_y_offsets[row_index][column]
            output.alpha_composite(cell_image, (cell_x, cell_y))
            current_x += column_widths[column] + column_gap
        current_y += row_heights[row_index] + row_gap

    if prefix_image is not None:
        prefix_y = vertical_padding + (inner_height - prefix_image.height) // 2
        output.alpha_composite(prefix_image, (horizontal_padding, prefix_y))
    if left_delimiter is not None:
        output.alpha_composite(left_delimiter, (structured_x, content_y))
    if right_delimiter is not None:
        output.alpha_composite(
            right_delimiter,
            (content_x + content_width + right_gap, content_y),
        )
    if suffix_image is not None:
        suffix_x = structured_x + structured_width + suffix_gap
        suffix_y = vertical_padding + (inner_height - suffix_image.height) // 2
        output.alpha_composite(suffix_image, (suffix_x, suffix_y))

    image_buffer = BytesIO()
    output.save(image_buffer, format="PNG")
    return image_buffer.getvalue()


def render_math_png(
    expression: str,
    font_size: int,
    dpi: int,
    color: str = "#20242b",
    *,
    vertical_padding_points: float = 0.0,
    allow_structured: bool = True,
) -> bytes:
    """数式をPNGへ変換する。同じ条件の結果は再利用する。"""

    normalized_expression = normalize_math_expression(expression.strip())
    environment = parse_math_environment(normalized_expression)
    if environment is not None and not allow_structured:
        raise ValueError("複合数式は独立数式でのみ使用できます。")

    with _render_lock:
        if environment is not None:
            return _render_math_environment_png_cached(
                environment,
                font_size,
                dpi,
                color,
                vertical_padding_points,
            )
        return _render_simple_math_png_cached(
            " ".join(normalized_expression.splitlines()),
            font_size,
            dpi,
            color,
            vertical_padding_points,
        )


def preload_math_renderer(requests: Iterable[MathRenderRequest]) -> None:
    """代表的な数式を描画し、初回importとフォント初期化を先に済ませる。"""

    try:
        for expression, font_size, dpi, vertical_padding_points in requests:
            render_math_png(
                expression,
                font_size,
                dpi,
                vertical_padding_points=vertical_padding_points,
            )
    except Exception:
        return
    _preload_complete.set()


def is_math_renderer_preloaded() -> bool:
    return _preload_complete.is_set()
