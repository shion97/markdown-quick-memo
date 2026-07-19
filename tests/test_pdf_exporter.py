from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from PIL import Image

from markdown_quick_memo.pdf_exporter import (
    PDF_LIST_BULLET_FONT_SIZE,
    PDF_LIST_BULLET_OFFSET_Y,
    PDF_LIST_NUMBER_OFFSET_Y,
    PDF_TABLE_LINE_WIDTH,
    PDF_TABLE_STRONG_LINE_WIDTH,
    _PdfFlowableRenderer,
    _PdfFonts,
    _prepare_list_assets,
    _prepare_math_assets,
    _markdown_to_html,
    _parse_html,
    export_markdown_to_pdf,
)


class PdfExporterTests(unittest.TestCase):
    def test_pdf_feature_corpus_prepares_every_math_and_exact_list_labels(self) -> None:
        fixture_path = Path(__file__).parent / "fixtures" / "pdf_all_features.md"
        markdown = fixture_path.read_text(encoding="utf-8")

        with TemporaryDirectory() as directory:
            prepared_math, math_assets = _prepare_math_assets(markdown, Path(directory))
            _prepared_lists, list_assets = _prepare_list_assets(prepared_math)

            self.assertEqual(len(math_assets), 24)
            self.assertTrue(all(asset.path is not None for asset in math_assets.values()))
            self.assertEqual(sum(asset.display for asset in math_assets.values()), 11)
            self.assertEqual(
                {asset.font_size for asset in math_assets.values()},
                {8, 10, 15, 22},
            )
            self.assertTrue(
                all(
                    asset.baseline is None
                    if asset.display
                    else 0 < asset.baseline <= asset.height
                    for asset in math_assets.values()
                )
            )
            labels = [
                item.label
                for block in list_assets.values()
                for item in block.items
            ]
            self.assertEqual(
                labels,
                [
                    "●", "1.", "2.", "○", "1)", "○", "○", "●", "●",
                    "1.", "2.", "3.", "○", "1.", "4.", "1)", "2)",
                    "●", "●", "●",
                ],
            )

    def test_list_type_transition_stays_at_the_editor_depth(self) -> None:
        markdown = "- A\n - B\n1. C\n1. D\n - E\n1) F"

        _prepared_markdown, list_assets = _prepare_list_assets(markdown)
        items = next(iter(list_assets.values())).items

        self.assertEqual([item.label for item in items], ["●", "○", "1.", "2.", "○", "3)"])
        self.assertEqual([item.depth for item in items], [0, 1, 0, 0, 1, 0])
        self.assertEqual(
            [item.ordered for item in items],
            [False, False, True, True, False, True],
        )

    def test_underscore_emphasis_and_escaped_dollar_match_editor_syntax(self) -> None:
        rendered_html = _markdown_to_html(
            r"__太字__、_斜体_、___太字斜体___、\$数式ではない\$"
        )

        self.assertIn("<strong>太字</strong>", rendered_html)
        self.assertIn("<em>斜体</em>", rendered_html)
        self.assertIn("<strong><em>太字斜体</em></strong>", rendered_html)
        self.assertIn("$数式ではない$", rendered_html)
        self.assertNotIn(r"\$", rendered_html)

    def test_latin_emphasis_selects_distinct_pdf_fonts(self) -> None:
        root = _parse_html(_markdown_to_html("**bold** *italic* ***both*** `code`"))
        renderer = _PdfFlowableRenderer(
            fonts=_PdfFonts(
                "LatinRegular",
                "LatinBold",
                "LatinItalic",
                "LatinBoldItalic",
                "Japanese",
                "JapaneseBold",
                "Monospace",
            ),
            math_assets={},
            list_assets={},
            markdown_directory=Path("."),
            available_width=400,
        )

        markup = renderer._inline_markup(root.children[0])

        self.assertIn('<font name="LatinBold">bold</font>', markup)
        self.assertIn('<font name="LatinItalic">italic</font>', markup)
        self.assertIn('<font name="LatinBoldItalic">both</font>', markup)
        self.assertIn('<font name="Monospace">code</font>', markup)

    def test_pdf_table_uses_strong_outer_and_header_lines(self) -> None:
        root = _parse_html(
            _markdown_to_html(
                "| name | value |\n"
                "| --- | --- |\n"
                "| p | q |\n"
                "| r | s |"
            )
        )
        renderer = _PdfFlowableRenderer(
            fonts=_PdfFonts(
                "Helvetica",
                "Helvetica-Bold",
                "Helvetica-Oblique",
                "Helvetica-BoldOblique",
                "Helvetica",
                "Helvetica-Bold",
                "Courier",
            ),
            math_assets={},
            list_assets={},
            markdown_directory=Path("."),
            available_width=400,
        )
        table_node = next(child for child in root.children if getattr(child, "tag", "") == "table")

        table = renderer._table_flowable(table_node)
        line_commands = [
            (command[0], command[1], command[2], command[3])
            for command in table._linecmds
        ]

        self.assertEqual(
            line_commands,
            [
                ("LINEABOVE", (0, 0), (-1, 0), PDF_TABLE_STRONG_LINE_WIDTH),
                ("LINEBELOW", (0, 0), (-1, 0), PDF_TABLE_STRONG_LINE_WIDTH),
                ("LINEBELOW", (0, 1), (-1, 1), PDF_TABLE_LINE_WIDTH),
                ("LINEBELOW", (0, -1), (-1, -1), PDF_TABLE_STRONG_LINE_WIDTH),
            ],
        )

    def test_pdf_list_markers_are_smaller_and_lowered_to_the_text_baseline(self) -> None:
        self.assertEqual(PDF_LIST_BULLET_FONT_SIZE, 4.5)
        self.assertLess(PDF_LIST_BULLET_OFFSET_Y, 0)
        self.assertLess(PDF_LIST_NUMBER_OFFSET_Y, 0)

    def test_pdf_feature_corpus_is_exported(self) -> None:
        fixture_path = Path(__file__).parent / "fixtures" / "pdf_all_features.md"
        markdown = fixture_path.read_text(encoding="utf-8")

        with TemporaryDirectory() as directory:
            working_directory = Path(directory)
            markdown_path = working_directory / "all-features.md"
            markdown_path.write_text(markdown, encoding="utf-8")
            Image.new("RGB", (120, 60), "#60a5fa").save(working_directory / "sample.png")

            output_path = export_markdown_to_pdf(
                markdown,
                markdown_path,
                working_directory / "all-features.pdf",
            )

            self.assertTrue(output_path.read_bytes().startswith(b"%PDF-"))
            self.assertGreater(output_path.stat().st_size, 20_000)
            self.assertEqual(list(working_directory.glob("*.pdf.tmp")), [])

    def test_flexible_mixed_list_indentation_is_nested_for_pdf(self) -> None:
        rendered_html = _markdown_to_html(
            "1. 親\n1. 親2\n   - 子\n     1. 孫\n   - [x] 子2"
        )

        self.assertEqual(rendered_html.count("<ol>"), 2)
        self.assertEqual(rendered_html.count("<ul>"), 1)
        self.assertIn("☑ 子2", rendered_html)

    def test_supported_markdown_is_exported_to_pdf(self) -> None:
        markdown = """# PDF見出し $E=mc^2$

日本語と **bold**、*italic*、~~strike~~、`code`。

1. 最初
1. 次
   - 子要素
   1. 子番号

- [x] 完了
- [ ] 未完了

> 引用

```python
print("日本語")
```

| 名前 | 状態 |
| --- | :---: |
| PDF | 完了 |

![サンプル画像](sample.png)

$$f(x)=\\begin{cases}x^2 & x\\geq 0 \\\\ -x & x<0\\end{cases}$$
"""
        with TemporaryDirectory() as directory:
            working_directory = Path(directory)
            markdown_path = working_directory / "sample.md"
            markdown_path.write_text(markdown, encoding="utf-8")
            Image.new("RGB", (80, 40), "#60a5fa").save(working_directory / "sample.png")

            output_path = export_markdown_to_pdf(
                markdown,
                markdown_path,
                working_directory / "sample.pdf",
            )

            self.assertEqual(output_path, working_directory / "sample.pdf")
            self.assertTrue(output_path.is_file())
            self.assertTrue(output_path.read_bytes().startswith(b"%PDF-"))
            self.assertGreater(output_path.stat().st_size, 2_000)
            self.assertEqual(list(working_directory.glob("*.pdf.tmp")), [])

    def test_remote_image_is_not_downloaded(self) -> None:
        markdown = "![外部画像](https://example.com/image.png)"
        with TemporaryDirectory() as directory:
            working_directory = Path(directory)
            markdown_path = working_directory / "remote.md"
            output_path = export_markdown_to_pdf(
                markdown,
                markdown_path,
                working_directory / "remote.pdf",
            )

            self.assertTrue(output_path.is_file())
            self.assertTrue(output_path.read_bytes().startswith(b"%PDF-"))


if __name__ == "__main__":
    unittest.main()
