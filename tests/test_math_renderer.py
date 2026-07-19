import unittest
from io import BytesIO

from PIL import Image, ImageChops

from markdown_quick_memo.math_renderer import (
    MAX_MATH_ENVIRONMENT_ROWS,
    _baseline_aligned_row_layout,
    _math_baseline_from_top,
    normalize_math_expression,
    parse_math_environment,
    render_math_png,
)


class MathRendererTests(unittest.TestCase):
    @staticmethod
    def _content_margins(rendered: bytes) -> tuple[int, int, int, int]:
        image = Image.open(BytesIO(rendered)).convert("RGB")
        background = Image.new("RGB", image.size, image.getpixel((0, 0)))
        bounds = ImageChops.difference(image, background).getbbox()
        if bounds is None:
            raise AssertionError("数式画像に描画内容がありません。")
        return (
            bounds[0],
            bounds[1],
            image.width - bounds[2],
            image.height - bounds[3],
        )

    def test_common_mathtext_commands_and_tfrac_compatibility_render(self) -> None:
        expression = (
            r"\tfrac{a}{b}+\dfrac{c}{d}+\operatorname{rank}(A)"
            r"+\boldsymbol{\alpha}+\overset{!}{=}+\underset{x}{\lim}"
        )

        self.assertIn(r"\frac{a}{b}", normalize_math_expression(expression))
        rendered = render_math_png(expression, font_size=15, dpi=150)
        self.assertTrue(rendered.startswith(b"\x89PNG"))

    def test_supported_environments_are_parsed_and_rendered(self) -> None:
        samples = {
            "matrix": r"\begin{matrix}a&b\\c&d\end{matrix}",
            "pmatrix": r"\begin{pmatrix}a&b\\c&d\end{pmatrix}",
            "bmatrix": r"\begin{bmatrix}a&b\\c&d\end{bmatrix}",
            "Bmatrix": r"\begin{Bmatrix}a&b\\c&d\end{Bmatrix}",
            "vmatrix": r"\begin{vmatrix}a&b\\c&d\end{vmatrix}",
            "Vmatrix": r"\begin{Vmatrix}a&b\\c&d\end{Vmatrix}",
            "cases": r"\begin{cases}x&x>0\\-x&x<0\end{cases}",
            "aligned": r"\begin{aligned}a&=b\\c&=d\end{aligned}",
            "align": r"\begin{align*}a&=b\\c&=d\end{align*}",
        }

        for expected_name, expression in samples.items():
            with self.subTest(environment=expected_name):
                environment = parse_math_environment(expression)
                self.assertIsNotNone(environment)
                normalized_name = "aligned" if expected_name == "align" else expected_name
                self.assertEqual(environment.name, normalized_name)
                rendered = render_math_png(
                    expression,
                    font_size=15,
                    dpi=150,
                    vertical_padding_points=2.0,
                )
                self.assertTrue(rendered.startswith(b"\x89PNG"))

    def test_top_level_rows_and_alignment_markers_are_parsed(self) -> None:
        environment = parse_math_environment(r"a&=b\\c&=d")

        self.assertIsNotNone(environment)
        self.assertEqual(environment.name, "aligned")
        self.assertEqual(environment.rows, (("a", "=b"), ("c", "=d")))

    def test_cases_environment_accepts_surrounding_expression(self) -> None:
        expression = (
            "f(x)=\n"
            r"\begin{cases}x^2&x\geq 0\\-x&x<0\end{cases}"
            "+c"
        )
        environment = parse_math_environment(expression)

        self.assertIsNotNone(environment)
        self.assertEqual(environment.name, "cases")
        self.assertEqual(environment.prefix, "f(x)=")
        self.assertEqual(environment.suffix, "+c")
        rendered = render_math_png(
            expression,
            font_size=15,
            dpi=150,
            vertical_padding_points=2.0,
        )
        self.assertTrue(rendered.startswith(b"\x89PNG"))

    def test_simple_math_keeps_content_away_from_every_edge(self) -> None:
        expressions = (
            r"AVfgjpqy",
            r"A \ni V \cap B \subseteq C",
            r"x_{ij}^{n+1}+y_k^2",
            r"\int_{-\infty}^{\infty} e^{-x^2}\,dx",
            r"\sqrt[3]{x^2+y^2}",
            r"\hat{x}+\vec{v}+\overline{AB}+\ddot{q}",
        )
        configurations = ((8, 120), (10, 120), (22, 120), (15, 150))

        for font_size, dpi in configurations:
            for expression in expressions:
                with self.subTest(font_size=font_size, dpi=dpi, expression=expression):
                    margins = self._content_margins(
                        render_math_png(
                            expression,
                            font_size=font_size,
                            dpi=dpi,
                            allow_structured=False,
                        )
                    )
                    self.assertGreaterEqual(min(margins), 1)

    def test_structured_row_cells_are_aligned_to_their_math_baselines(self) -> None:
        expressions = (r"\sum_{i=1}^n x_i", "y")
        images = [
            Image.open(
                BytesIO(
                    render_math_png(
                        expression,
                        font_size=15,
                        dpi=150,
                        vertical_padding_points=1.5,
                        allow_structured=False,
                    )
                )
            )
            for expression in expressions
        ]
        baselines = tuple(
            _math_baseline_from_top(
                expression,
                font_size=15,
                dpi=150,
                vertical_padding_points=1.5,
                color="#20242b",
            )
            for expression in expressions
        )
        _row_height, offsets = _baseline_aligned_row_layout(
            tuple(image.height for image in images),
            baselines,
        )
        placed_baselines = tuple(offset + baseline for offset, baseline in zip(offsets, baselines))

        self.assertLessEqual(max(placed_baselines) - min(placed_baselines), 1.0)

    def test_structured_math_is_rejected_for_inline_rendering(self) -> None:
        with self.assertRaisesRegex(ValueError, "独立数式"):
            render_math_png(
                r"\begin{matrix}a&b\\c&d\end{matrix}",
                font_size=10,
                dpi=120,
                allow_structured=False,
            )

    def test_environment_row_limit_is_enforced(self) -> None:
        rows = r"\\".join("x" for _ in range(MAX_MATH_ENVIRONMENT_ROWS + 1))

        with self.assertRaisesRegex(ValueError, "最大20行"):
            parse_math_environment(rf"\begin{{matrix}}{rows}\end{{matrix}}")


if __name__ == "__main__":
    unittest.main()
