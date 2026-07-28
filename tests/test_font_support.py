import unittest

from markdown_quick_memo.font_support import build_font_runs, is_japanese_character
from markdown_quick_memo.markdown_styler import StyleSpan


class FontSupportTests(unittest.TestCase):
    def test_japanese_character_detection(self) -> None:
        for character in "日本語かなカナ。Ａ":
            self.assertTrue(is_japanese_character(character), character)
        for character in "Roboto 123":
            self.assertFalse(is_japanese_character(character), character)

    def test_font_runs_combine_script_and_markdown_style(self) -> None:
        text = "# English 日本語"
        spans = [StyleSpan(0, len(text), "heading1"), StyleSpan(2, len(text), "italic")]

        runs = build_font_runs(text, spans)

        self.assertEqual(
            [(run.start, run.end, run.script, run.style) for run in runs],
            [
                (0, 2, "latin", "heading1"),
                (2, 10, "latin", "heading1_italic"),
                (10, 13, "japanese", "heading1_italic"),
            ],
        )

    def test_code_uses_monospace_style_for_both_scripts(self) -> None:
        text = "code日本語"
        runs = build_font_runs(text, [StyleSpan(0, len(text), "inline_code")])

        self.assertEqual([run.style for run in runs], ["mono", "mono"])
        self.assertEqual([run.script for run in runs], ["latin", "japanese"])

    def test_inline_math_in_heading_uses_heading_math_size(self) -> None:
        text = "# 数式 $x^2$"
        expression_start = text.index("x")
        expression_end = expression_start + len("x^2")
        spans = [
            StyleSpan(0, len(text), "heading1"),
            StyleSpan(expression_start, expression_end, "math_inline"),
        ]

        runs = build_font_runs(text, spans)

        math_runs = [
            run
            for run in runs
            if run.start < expression_end and run.end > expression_start
        ]
        self.assertTrue(math_runs)
        self.assertTrue(all(run.style == "math_heading1" for run in math_runs))


if __name__ == "__main__":
    unittest.main()
