import tkinter as tk
from tkinter import font as tkfont
from tkinter import ttk
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from markdown_quick_memo.app import (
    EDITOR_SCROLL_PIXELS_PER_NOTCH,
    DISPLAY_MATH_DPI,
    DISPLAY_MATH_FONT_SIZE,
    DISPLAY_MATH_VERTICAL_PADDING_POINTS,
    INLINE_MATH_DISPLAY_DPI,
    INLINE_MATH_FONT_SIZE,
    INLINE_MATH_RENDER_DPI,
    INLINE_MATH_TOP_PADDING,
    MarkdownQuickMemoApp,
    TABLE_LINE_COLOR,
    TABLE_LINE_WIDTH,
    TABLE_STRONG_LINE_WIDTH,
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
        self.assertTrue(
            all(
                widget.bind("<MouseWheel>") and widget.bind("<Button-1>")
                for decoration in self.app._decoration_widgets
                for widget in (decoration, *_descendants(decoration))
            )
        )
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
        self.assertEqual(bullet_font.actual("size"), 6)
        self.assertEqual(self.app.editor.get("1.0", "end-1c"), markdown)

    def test_view_menu_is_removed_and_table_shortcut_is_bound(self) -> None:
        menu = self.root.nametowidget(self.root.cget("menu"))
        labels = [menu.entrycget(index, "label") for index in range(menu.index("end") + 1)]
        file_menu = self.root.nametowidget(menu.entrycget(0, "menu"))
        file_labels = [
            file_menu.entrycget(index, "label")
            for index in range(file_menu.index("end") + 1)
            if file_menu.type(index) != "separator"
        ]

        self.assertEqual(labels, ["ファイル", "編集"])
        self.assertIn("PDFに書き出す", file_labels)
        self.assertTrue(self.root.bind("<Control-t>"))
        self.assertTrue(self.root.bind("<Control-Shift-P>"))
        self.assertTrue(self.root.bind("<Control-Shift-O>"))

    def test_status_is_placed_between_title_and_marker_toggle(self) -> None:
        header = self.app.status_label.master
        title_label = next(
            widget
            for widget in header.winfo_children()
            if isinstance(widget, ttk.Label) and widget.cget("text") == "Markdown Quick Memo"
        )
        marker_toggle = next(
            widget for widget in header.winfo_children() if isinstance(widget, ttk.Checkbutton)
        )

        self.assertEqual(int(title_label.grid_info()["column"]), 0)
        self.assertEqual(int(self.app.status_label.grid_info()["column"]), 1)
        self.assertEqual(int(marker_toggle.grid_info()["column"]), 2)
        self.assertNotEqual(self.app.status_text.get(), "")

    def test_pdf_export_saves_markdown_before_writing_pdf(self) -> None:
        self.app._replace_text("# PDF")
        with TemporaryDirectory() as directory:
            markdown_path = Path(directory) / "memo.md"
            self.app._save_to(markdown_path)
            self.app.editor.insert("end", "\n更新")
            self.app._on_modified()
            pdf_path = markdown_path.with_suffix(".pdf")

            with patch(
                "markdown_quick_memo.pdf_exporter.export_markdown_to_pdf",
                return_value=pdf_path,
            ) as exporter:
                result = self.app.export_pdf()

            self.assertEqual(result, "break")
            self.assertEqual(markdown_path.read_text(encoding="utf-8"), "# PDF\n更新")
            exporter.assert_called_once_with("# PDF\n更新", markdown_path.resolve(), pdf_path.resolve())
            self.assertIn("PDFを書き出しました", self.app.status_text.get())

    def test_window_transparency_can_be_toggled(self) -> None:
        self.assertFalse(self.app.transparent_mode.get())
        self.assertAlmostEqual(float(self.root.attributes("-alpha")), 1.0)

        self.app.toggle_window_transparency()

        self.assertTrue(self.app.transparent_mode.get())
        self.assertAlmostEqual(float(self.root.attributes("-alpha")), 0.6)
        self.assertNotIn("透過 60%", self.app.status_text.get())

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

    def test_table_preview_draws_borders_and_forwards_mousewheel(self) -> None:
        markdown = (
            "| name | value |\n"
            "| --- | --- |\n"
            "| p | q |\n"
            "| r | s |"
        )
        self.app._replace_text(markdown)
        table_widget = self.app._create_table_widget(self.app._analysis.tables[0])
        self.app._bind_editor_decoration_events(table_widget)
        self.root.update_idletasks()

        line_widgets = sorted(
            (
                child
                for child in table_widget.winfo_children()
                if isinstance(child, tk.Frame) and child.cget("background") == TABLE_LINE_COLOR
            ),
            key=lambda widget: int(widget.grid_info()["row"]),
        )
        self.assertEqual(
            [int(widget.cget("height")) for widget in line_widgets],
            [
                TABLE_STRONG_LINE_WIDTH,
                TABLE_STRONG_LINE_WIDTH,
                TABLE_LINE_WIDTH,
                TABLE_STRONG_LINE_WIDTH,
            ],
        )
        self.assertTrue(
            all(widget.bind("<MouseWheel>") for widget in (table_widget, *_descendants(table_widget)))
        )

        wheel_event = tk.Event()
        wheel_event.delta = 120
        with (
            patch.object(self.app.editor, "yview", return_value=(0.2, 0.6)),
            patch.object(self.app.editor, "winfo_height", return_value=400),
            patch.object(self.app.editor, "yview_moveto") as scroll,
        ):
            result = self.app._forward_editor_mousewheel(wheel_event)

        expected_fraction = 0.2 - EDITOR_SCROLL_PIXELS_PER_NOTCH * (0.6 - 0.2) / 400
        scroll.assert_called_once()
        self.assertAlmostEqual(scroll.call_args.args[0], expected_fraction)
        self.assertEqual(result, "break")

    def test_scroll_redraw_is_coalesced_until_idle(self) -> None:
        self.app._scroll_redraw_job = None

        with (
            patch.object(self.app._editor_scrollbar, "set") as update_scrollbar,
            patch.object(self.root, "after_idle", return_value="scroll-redraw") as after_idle,
        ):
            self.app._on_editor_yview_changed("0.1", "0.5")
            self.app._on_editor_yview_changed("0.2", "0.6")

        self.assertEqual(update_scrollbar.call_count, 2)
        after_idle.assert_called_once_with(self.app._flush_editor_scroll_redraw)

        with patch.object(self.app.editor, "update_idletasks") as update_idletasks:
            self.app._flush_editor_scroll_redraw()

        update_idletasks.assert_called_once_with()
        self.assertIsNone(self.app._scroll_redraw_job)

    def test_clicking_horizontal_rule_activates_its_markdown_line(self) -> None:
        markdown = "先頭\n\n---\n\n末尾"
        self.app._replace_text(markdown)
        self.app.editor.mark_set("insert", "end-1c")
        self.app.render_markdown()
        rule_widget = next(
            widget
            for widget in self.app._decoration_widgets
            if isinstance(widget, tk.Frame) and int(widget.cget("height")) == 18
        )

        self.root.deiconify()
        self.root.update()
        rule_widget.event_generate("<Button-1>", x=2, y=2)
        self.root.update()

        self.assertEqual(self.app.editor.index("insert linestart"), "3.0")
        self.assertNotIn(rule_widget, self.app._decoration_widgets)

    def test_cursor_line_change_reuses_analysis_and_unaffected_decorations(self) -> None:
        markdown = "---\n\n数式 $x^2$\n\n末尾"
        self.app._replace_text(markdown)
        self.app.editor.mark_set("insert", "end-1c")
        self.app.render_markdown()
        rule_widget = next(
            widget
            for widget in self.app._decoration_widgets
            if isinstance(widget, tk.Frame) and int(widget.cget("height")) == 18
        )
        math_widget = next(
            widget
            for widget in self.app._decoration_widgets
            if isinstance(widget, tk.Label) and hasattr(widget, "image")
        )

        self.app.editor.mark_set("insert", "1.0")
        with (
            patch("markdown_quick_memo.app.analyze_markdown") as analyze,
            patch.object(self.app, "_apply_script_fonts") as apply_script_fonts,
        ):
            self.app._on_cursor_moved()

        analyze.assert_not_called()
        apply_script_fonts.assert_not_called()
        self.assertNotIn(rule_widget, self.app._decoration_widgets)
        self.assertIn(math_widget, self.app._decoration_widgets)
        self.assertEqual(self.app.editor.get("1.0", "end-1c"), markdown)

    def test_cursor_line_change_updates_marker_visibility_on_affected_lines(self) -> None:
        markdown = "**先頭**\n\n**末尾**"
        self.app._replace_text(markdown)
        self.assertNotIn("marker_hidden", self.app.editor.tag_names("1.0"))

        self.app.editor.mark_set("insert", "3.2")
        self.app._on_cursor_moved()

        self.assertIn("marker_hidden", self.app.editor.tag_names("1.0"))
        self.assertNotIn("marker_hidden", self.app.editor.tag_names("3.0"))
        self.assertEqual(self.app.editor.get("1.0", "end-1c"), markdown)

    def test_search_widgets_and_script_fonts_are_initialized_lazily(self) -> None:
        self.assertIsNone(self.app.search_entry)
        self.assertFalse(self.app._script_font_tags_ready)

        self.app.show_search()

        self.assertIsNotNone(self.app.search_entry)
        self.assertTrue(self.app._search_visible)
        self.app.hide_search()

        self.app._replace_text("English 日本語")

        self.assertTrue(self.app._script_font_tags_ready)
        self.assertIn("script_font_latin_body", self.app.editor.tag_names("1.0"))

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
        self.assertEqual(latin_font.actual("family"), "Segoe UI")
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

    def test_inline_math_is_supersampled_without_changing_display_size(self) -> None:
        from io import BytesIO

        from PIL import Image

        expression = MathExpression(0, 0, r"E=mc^2", False)
        widget = self.app._create_math_widget(expression)
        with Image.open(
            BytesIO(
                render_math_png(
                    expression.expression,
                    font_size=INLINE_MATH_FONT_SIZE,
                    dpi=INLINE_MATH_RENDER_DPI,
                )
            )
        ) as high_resolution_image:
            expected_width = round(
                high_resolution_image.width * INLINE_MATH_DISPLAY_DPI / INLINE_MATH_RENDER_DPI
            )
            expected_height = round(
                high_resolution_image.height * INLINE_MATH_DISPLAY_DPI / INLINE_MATH_RENDER_DPI
            )
        with Image.open(
            BytesIO(
                render_math_png(
                    expression.expression,
                    font_size=INLINE_MATH_FONT_SIZE,
                    dpi=INLINE_MATH_DISPLAY_DPI,
                )
            )
        ) as legacy_resolution_image:
            legacy_width = legacy_resolution_image.width
            legacy_height = legacy_resolution_image.height

        self.assertEqual(INLINE_MATH_RENDER_DPI, INLINE_MATH_DISPLAY_DPI * 2)
        self.assertEqual(widget.image.width(), expected_width)  # type: ignore[attr-defined]
        self.assertEqual(  # type: ignore[attr-defined]
            widget.image.height(),
            expected_height + INLINE_MATH_TOP_PADDING,
        )
        self.assertAlmostEqual(widget.image.width(), legacy_width, delta=1)  # type: ignore[attr-defined]
        self.assertAlmostEqual(  # type: ignore[attr-defined]
            widget.image.height() - INLINE_MATH_TOP_PADDING,
            legacy_height,
            delta=1,
        )

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
