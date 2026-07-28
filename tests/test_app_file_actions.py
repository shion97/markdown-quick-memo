from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import Mock, patch

from markdown_quick_memo.app import MarkdownQuickMemoApp, _list_layout_margins


class AppFileActionTests(unittest.TestCase):
    @staticmethod
    def _app_without_tk(current_path: Path) -> MarkdownQuickMemoApp:
        app = MarkdownQuickMemoApp.__new__(MarkdownQuickMemoApp)
        app.current_path = current_path
        app.dirty = False
        app.root = Mock()
        app.editor = Mock()
        app._update_title_and_status = Mock()
        return app

    def test_current_file_is_renamed_without_overwriting_another_file(self) -> None:
        with TemporaryDirectory() as directory:
            current_path = Path(directory) / "memo.md"
            current_path.write_text("memo", encoding="utf-8")
            app = self._app_without_tk(current_path)

            with patch(
                "markdown_quick_memo.app.simpledialog.askstring",
                return_value="renamed",
            ):
                result = app.rename_current_file()

            renamed_path = Path(directory) / "renamed.md"
            self.assertEqual(result, "break")
            self.assertFalse(current_path.exists())
            self.assertTrue(renamed_path.exists())
            self.assertEqual(app.current_path, renamed_path.resolve())

    def test_ordered_list_continuation_uses_one_as_markdown_source(self) -> None:
        self.assertEqual(MarkdownQuickMemoApp._continuation_list_marker("1."), "1.")
        self.assertEqual(MarkdownQuickMemoApp._continuation_list_marker("7."), "1.")
        self.assertEqual(MarkdownQuickMemoApp._continuation_list_marker("3)"), "1.")
        self.assertEqual(MarkdownQuickMemoApp._continuation_list_marker("-"), "-")

    def test_file_action_shortcuts_are_bound(self) -> None:
        app = MarkdownQuickMemoApp.__new__(MarkdownQuickMemoApp)
        app.root = Mock()
        app.editor = Mock()

        app._bind_shortcuts()

        root_bindings = {
            call.args[0]: call.args[1]
            for call in app.root.bind.call_args_list
            if len(call.args) >= 2
        }
        self.assertEqual(
            root_bindings["<Control-Shift-R>"].__func__,
            MarkdownQuickMemoApp.rename_current_file,
        )
        self.assertEqual(
            root_bindings["<Control-Shift-E>"].__func__,
            MarkdownQuickMemoApp.open_save_folder,
        )
        self.assertEqual(
            root_bindings["<Control-q>"].__func__,
            MarkdownQuickMemoApp.hide_window,
        )

    def test_alt_f4_closes_the_window(self) -> None:
        app = MarkdownQuickMemoApp.__new__(MarkdownQuickMemoApp)
        app.root = Mock()

        app._configure_window()

        app.root.protocol.assert_called_once_with("WM_DELETE_WINDOW", app.close)

    def test_list_layout_stays_aligned_between_source_and_preview_markers(self) -> None:
        source_marker_width = 7
        marker_column_width = 18
        spacing_width = 5
        indentation_width = 10

        source_first_margin, source_wrap_margin = _list_layout_margins(
            indentation_width,
            spacing_width,
            source_marker_width,
            marker_column_width,
            preview_is_mounted=False,
        )
        preview_first_margin, preview_wrap_margin = _list_layout_margins(
            indentation_width,
            spacing_width,
            source_marker_width,
            marker_column_width,
            preview_is_mounted=True,
        )

        self.assertEqual(source_wrap_margin, preview_wrap_margin)
        self.assertEqual(
            source_first_margin
            + indentation_width
            + source_marker_width
            + spacing_width,
            source_wrap_margin,
        )
        self.assertEqual(
            preview_first_margin
            + indentation_width
            + marker_column_width
            + spacing_width,
            preview_wrap_margin,
        )

    def test_save_folder_and_exported_pdf_open_with_default_app(self) -> None:
        with TemporaryDirectory() as directory:
            markdown_path = Path(directory) / "memo.md"
            markdown_path.write_text("# PDF", encoding="utf-8")
            pdf_path = markdown_path.with_suffix(".pdf")
            app = self._app_without_tk(markdown_path)
            app.editor.get.return_value = "# PDF"

            with patch("markdown_quick_memo.app.open_with_default_app") as opener:
                self.assertEqual(app.open_save_folder(), "break")
                with patch(
                    "markdown_quick_memo.pdf_exporter.export_markdown_to_pdf",
                    return_value=pdf_path,
                ):
                    self.assertEqual(app.export_pdf(), "break")

            self.assertEqual(opener.call_args_list[0].args, (markdown_path.parent,))
            self.assertEqual(opener.call_args_list[1].args, (pdf_path,))


if __name__ == "__main__":
    unittest.main()
