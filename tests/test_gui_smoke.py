import tkinter as tk
from tkinter import font as tkfont
import unittest

from markdown_quick_memo.app import (
    DISPLAY_MATH_DPI,
    DISPLAY_MATH_FONT_SIZE,
    DISPLAY_MATH_VERTICAL_PADDING_POINTS,
    MarkdownQuickMemoApp,
    build_table_template,
)
from markdown_quick_memo.math_renderer import is_math_renderer_preloaded, render_math_png
from markdown_quick_memo.markdown_styler import MathExpression


def _descendants(widget: tk.Misc):
    for child in widget.winfo_children():
        yield child
        yield from _descendants(child)


class GuiSmokeTests(unittest.TestCase):
    def setUp(self) -> None:
        try:
            self.root = tk.Tk()
        except tk.TclError as error:
            self.skipTest(f"Tkを起動できない環境です: {error}")
        self.root.withdraw()
        self.app = MarkdownQuickMemoApp(self.root)

    def tearDown(self) -> None:
        if hasattr(self, "root"):
            self.app._cancel_scheduled_jobs()
            self.root.destroy()

    def test_editor_renders_without_changing_markdown(self) -> None:
        markdown = (
            "# 見出し\n\n- [x] 完了\n\n**太字** と [リンク](https://example.com)\n\n"
            "数式 $E=mc^2$\n\n$$\\frac{a}{b}$$\n\n"
            "---\n\n| 名前 | 状態 |\n|---|---|\n| 保存 | 完了 |"
        )
        self.app._replace_text(markdown)
        self.app.render_markdown()
        self.root.update_idletasks()

        self.assertEqual(self.app.editor.get("1.0", "end-1c"), markdown)
        self.assertIn("heading1", self.app.editor.tag_names())
        self.assertIn("marker_hidden", self.app.editor.tag_names())
        self.assertEqual(len(self.app._analysis.links), 1)
        self.assertEqual(len(self.app._decoration_widgets), 5)
        self.assertFalse(self.app.dirty)
        image_widgets = []
        for widget in self.app._decoration_widgets:
            image_widgets.extend(child for child in [widget, *widget.winfo_children()] if hasattr(child, "image"))
        self.assertEqual(len(image_widgets), 2)
        inline_math_widget = next(
            widget
            for widget in self.app._decoration_widgets
            if isinstance(widget, tk.Label) and hasattr(widget, "image")
        )
        self.assertLessEqual(inline_math_widget.image.height(), 24)
        rule_index = self.app.editor.search("---", "1.0", stopindex="end", elide=True)
        self.assertTrue(
            all("marker_hidden" in self.app.editor.tag_names(f"{rule_index} + {offset}c") for offset in range(3))
        )
        table_row_index = self.app.editor.search("| 保存 | 完了 |", "1.0", stopindex="end", elide=True)
        self.assertIn("marker_hidden", self.app.editor.tag_names(f"{table_row_index} lineend -1c"))

        self.app.render_markdown()
        self.assertEqual(self.app.editor.get("1.0", "end-1c"), markdown)
        self.assertEqual(len(self.app._decoration_widgets), 5)

        table_index = self.app.editor.search("| 名前", "1.0", stopindex="end", elide=True)
        self.app.editor.mark_set("insert", table_index)
        self.app.render_markdown()
        self.assertEqual(self.app.editor.get("1.0", "end-1c"), markdown)
        self.assertEqual(len(self.app._decoration_widgets), 4)

    def test_list_preview_uses_sequential_and_nested_markers(self) -> None:
        markdown = "1. 1番目\n1. 2番目\n   - 子要素\n   1. 子番号\n\nカーソル行"
        self.app._replace_text(markdown)
        self.app.editor.mark_set("insert", "end-1c")
        self.app.render_markdown()

        preview_labels = [
            widget.cget("text")
            for widget in self.app._decoration_widgets
            if isinstance(widget, tk.Label) and widget.cget("text")
        ]
        self.assertCountEqual(preview_labels, ["1.", "2.", "○", "1."])
        bullet_widget = next(
            widget
            for widget in self.app._decoration_widgets
            if isinstance(widget, tk.Label) and widget.cget("text") == "○"
        )
        bullet_font = tkfont.Font(font=bullet_widget.cget("font"))
        self.assertEqual(bullet_font.actual("size"), 9)
        self.assertEqual(self.app.editor.get("1.0", "end-1c"), markdown)

    def test_view_menu_is_removed_and_table_shortcut_is_bound(self) -> None:
        menu = self.root.nametowidget(self.root.cget("menu"))
        labels = [menu.entrycget(index, "label") for index in range(menu.index("end") + 1)]

        self.assertEqual(labels, ["ファイル", "編集"])
        self.assertTrue(self.root.bind("<Control-t>"))
        self.assertTrue(self.root.bind("<Control-Shift-O>"))

    def test_window_transparency_can_be_toggled(self) -> None:
        self.assertFalse(self.app.transparent_mode.get())
        self.assertAlmostEqual(float(self.root.attributes("-alpha")), 1.0)

        self.app.toggle_window_transparency()

        self.assertTrue(self.app.transparent_mode.get())
        self.assertAlmostEqual(float(self.root.attributes("-alpha")), 0.6)
        self.assertIn("透過 60%", self.app.status_text.get())

        self.app.toggle_window_transparency()

        self.assertFalse(self.app.transparent_mode.get())
        self.assertAlmostEqual(float(self.root.attributes("-alpha")), 1.0)
        self.assertNotIn("透過 60%", self.app.status_text.get())

    def test_table_template_replaces_selection(self) -> None:
        self.assertEqual(
            build_table_template(2, 3),
            "| q | q | q |\n| --- | --- | --- |\n| q | q | q |",
        )
        markdown = "前\n置換対象\n後"
        self.app._replace_text(markdown)
        start = self.app.editor.search("置換対象", "1.0")
        self.app.editor.tag_add("sel", start, f"{start} + {len('置換対象')}c")
        insertion_target = self.app._selection_indices()
        self.app.editor.tag_remove("sel", "1.0", "end")

        self.app._insert_table(2, 3, insertion_target)

        self.assertEqual(
            self.app.editor.get("1.0", "end-1c"),
            "前\n| q | q | q |\n| --- | --- | --- |\n| q | q | q |\n後",
        )
        self.assertTrue(self.app.dirty)

    def test_editor_uses_language_specific_fonts(self) -> None:
        markdown = "# English 日本語\n\n**Bold 太字**"
        self.app._replace_text(markdown)
        self.app.render_markdown()

        english_index = self.app.editor.search("English", "1.0")
        japanese_index = self.app.editor.search("日本語", "1.0")
        bold_index = self.app.editor.search("Bold", "1.0")
        japanese_bold_index = self.app.editor.search("太字", "1.0")

        self.assertIn("script_font_latin_heading1", self.app.editor.tag_names(english_index))
        self.assertIn("script_font_japanese_heading1", self.app.editor.tag_names(japanese_index))
        self.assertIn("script_font_latin_bold", self.app.editor.tag_names(bold_index))
        self.assertIn("script_font_japanese_bold", self.app.editor.tag_names(japanese_bold_index))

        latin_font_name = self.app.editor.tag_cget("script_font_latin_heading1", "font")
        japanese_font_name = self.app.editor.tag_cget("script_font_japanese_heading1", "font")
        latin_font = tkfont.Font(root=self.root, font=latin_font_name)
        japanese_font = tkfont.Font(root=self.root, font=japanese_font_name)
        self.assertEqual(latin_font.actual("family"), "Roboto")
        self.assertTrue(str(japanese_font.actual("family")).startswith("BIZ UD"))

    def test_heading_math_uses_heading_size(self) -> None:
        markdown = "# 見出し $x^2$\n\n本文 $x^2$\n\nカーソル"
        self.app._replace_text(markdown)
        self.app.editor.mark_set("insert", "end-1c")
        self.app.render_markdown()

        math_widgets = [
            widget
            for widget in self.app._decoration_widgets
            if isinstance(widget, tk.Label) and hasattr(widget, "image")
        ]
        heights = sorted(widget.image.height() for widget in math_widgets)  # type: ignore[attr-defined]

        self.assertEqual(
            [expression.heading_level for expression in self.app._analysis.math_expressions],
            [1, None],
        )
        self.assertEqual(len(heights), 2)
        self.assertGreater(heights[1], heights[0])

    def test_structured_display_math_and_table_cell_math_render(self) -> None:
        markdown = (
            "$$f(x)=\\begin{cases}x^2&x\\geq 0\\\\-x&x<0\\end{cases}$$\n\n"
            "| 数式 | 説明 |\n"
            "|---|---|\n"
            "| $a \\cap c$ | 値 $x^2$ |\n\n"
            "カーソル"
        )
        self.app._replace_text(markdown)
        self.app.editor.mark_set("insert", "end-1c")
        self.app.render_markdown()

        image_widgets = [
            child
            for decoration in self.app._decoration_widgets
            for child in (decoration, *_descendants(decoration))
            if hasattr(child, "image")
        ]

        self.assertEqual(self.app.editor.get("1.0", "end-1c"), markdown)
        self.assertEqual(len(self.app._decoration_widgets), 2)
        self.assertEqual(len(image_widgets), 3)

    def test_inline_structured_math_falls_back_to_source(self) -> None:
        expression = MathExpression(
            0,
            0,
            r"\begin{matrix}a&b\\c&d\end{matrix}",
            False,
        )

        widget = self.app._create_math_widget(expression)

        self.assertFalse(hasattr(widget, "image"))
        self.assertEqual(widget.cget("text"), rf"${expression.expression}$")

    def test_math_renderer_can_be_preloaded_in_background(self) -> None:
        self.app._start_math_preload()

        self.assertIsNotNone(self.app._math_preload_thread)
        self.app._math_preload_thread.join(timeout=15)

        self.assertFalse(self.app._math_preload_thread.is_alive())
        self.assertTrue(is_math_renderer_preloaded())

    def test_math_renderer_keeps_left_glyph_padding(self) -> None:
        from io import BytesIO

        from PIL import Image, ImageChops

        rendered_image = Image.open(
            BytesIO(render_math_png(r"A \ni V", font_size=15, dpi=120))
        ).convert("RGB")
        background = Image.new("RGB", rendered_image.size, rendered_image.getpixel((0, 0)))
        content_bounds = ImageChops.difference(rendered_image, background).getbbox()

        self.assertIsNotNone(content_bounds)
        self.assertGreaterEqual(content_bounds[0], 2)

    def test_display_math_renderer_keeps_edge_padding(self) -> None:
        from io import BytesIO

        from PIL import Image, ImageChops

        for expression in (r"a \cap c", r"\int_0^\infty e^{-x}\,dx"):
            with self.subTest(expression=expression):
                rendered_image = Image.open(
                    BytesIO(
                        render_math_png(
                            expression,
                            font_size=DISPLAY_MATH_FONT_SIZE,
                            dpi=DISPLAY_MATH_DPI,
                            vertical_padding_points=DISPLAY_MATH_VERTICAL_PADDING_POINTS,
                        )
                    )
                ).convert("RGB")
                background = Image.new(
                    "RGB",
                    rendered_image.size,
                    rendered_image.getpixel((0, 0)),
                )
                content_bounds = ImageChops.difference(
                    rendered_image,
                    background,
                ).getbbox()

                self.assertIsNotNone(content_bounds)
                self.assertGreaterEqual(content_bounds[0], 2)
                self.assertGreaterEqual(content_bounds[1], 2)
                self.assertGreaterEqual(rendered_image.width - content_bounds[2], 2)
                self.assertGreaterEqual(rendered_image.height - content_bounds[3], 2)


if __name__ == "__main__":
    unittest.main()
