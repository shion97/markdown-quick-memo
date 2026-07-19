import unittest

from markdown_quick_memo.markdown_styler import analyze_markdown


class MarkdownStylerTests(unittest.TestCase):
    def test_heading_and_inline_styles(self) -> None:
        text = "## 見出し\nこれは **太字** と *斜体* です。"
        analysis = analyze_markdown(text)
        tags = {span.tag for span in analysis.spans}
        self.assertTrue({"heading2", "bold", "italic", "marker"} <= tags)

    def test_code_fence_protects_inline_markers(self) -> None:
        text = "```python\nprint('**not bold**')\n```"
        analysis = analyze_markdown(text)
        tags = [span.tag for span in analysis.spans]
        self.assertIn("code_block", tags)
        self.assertIn("code_language", tags)
        self.assertNotIn("bold", tags)
        language_span = next(span for span in analysis.spans if span.tag == "code_language")
        self.assertEqual(text[language_span.start : language_span.end], "python")

    def test_links_and_images_keep_targets(self) -> None:
        text = "[OpenAI](https://openai.com) ![画像](image.png)"
        analysis = analyze_markdown(text)
        self.assertEqual([link.target for link in analysis.links], ["image.png", "https://openai.com"])
        self.assertEqual([link.is_image for link in analysis.links], [True, False])

    def test_list_and_quote_markers_remain_visible(self) -> None:
        text = "- 箇条書き\n1. 番号付き\n> 引用"
        analysis = analyze_markdown(text)
        list_markers = [span for span in analysis.spans if span.tag == "list_marker"]
        quote_markers = [span for span in analysis.spans if span.tag == "quote_marker"]
        self.assertEqual([text[span.start : span.end] for span in list_markers], ["-", "1."])
        self.assertTrue(all(not span.concealable for span in list_markers + quote_markers))

    def test_ordered_and_mixed_nested_lists_get_preview_markers(self) -> None:
        text = (
            "1. 1番目\n"
            "1. 2番目\n"
            "   - 子要素\n"
            "   + 子要素\n"
            "1. 3番目\n"
            "   1. 子番号1\n"
            "   1. 子番号2\n"
            "      * 孫要素\n"
        )
        markers = analyze_markdown(text).list_markers
        self.assertEqual(
            [marker.label for marker in markers],
            ["1.", "2.", "○", "○", "3.", "1.", "2.", "○"],
        )
        self.assertEqual([marker.depth for marker in markers], [0, 0, 1, 1, 0, 1, 1, 2])

    def test_inline_and_display_math_are_detected(self) -> None:
        text = "インライン $E=mc^2$ です。\n\n$$\\frac{a}{b} = \\sqrt{x}$$"
        analysis = analyze_markdown(text)
        self.assertEqual(len(analysis.math_expressions), 2)
        self.assertFalse(analysis.math_expressions[0].display)
        self.assertTrue(analysis.math_expressions[1].display)
        self.assertEqual(analysis.math_expressions[0].expression, "E=mc^2")
        self.assertEqual(analysis.math_expressions[1].expression, r"\frac{a}{b} = \sqrt{x}")

    def test_heading_level_and_math_exclusions_are_detected(self) -> None:
        text = (
            "# 見出し $x^2$\n"
            "`$code$` [リンク](https://example.com/$url$) "
            "![画像](image-$path$.png) $body$"
        )
        expressions = analyze_markdown(text).math_expressions

        self.assertEqual([expression.expression for expression in expressions], ["x^2", "body"])
        self.assertEqual([expression.heading_level for expression in expressions], [1, None])

    def test_table_cells_keep_pipes_inside_math(self) -> None:
        text = "| 数式 | 値 |\n|---|---|\n| $|x|$ | $a \\cap c$ |\n"
        table = analyze_markdown(text).tables[0]

        self.assertEqual(table.rows[1], ("$|x|$", "$a \\cap c$"))

    def test_checkbox_table_and_horizontal_rule_are_detected(self) -> None:
        text = "- [x] 完了\n\n---\n\n| A | B |\n|:---|---:|\n| 左 | 右 |\n"
        analysis = analyze_markdown(text)
        tags = {span.tag for span in analysis.spans}
        self.assertIn("checkbox_checked", tags)
        self.assertIn("table", tags)
        self.assertEqual(len(analysis.horizontal_rules), 1)
        self.assertEqual(len(analysis.tables), 1)
        self.assertEqual(analysis.tables[0].rows, (("A", "B"), ("左", "右")))
        self.assertEqual(analysis.tables[0].alignments, ("left", "right"))


if __name__ == "__main__":
    unittest.main()
