from pathlib import Path
import tempfile
import unittest

from markdown_quick_memo.document import ensure_markdown_suffix, read_markdown, write_markdown


class DocumentTests(unittest.TestCase):
    def test_suffix_is_added_only_when_missing(self) -> None:
        self.assertEqual(ensure_markdown_suffix("memo"), Path("memo.md"))
        self.assertEqual(ensure_markdown_suffix("memo.md"), Path("memo.md"))
        self.assertEqual(ensure_markdown_suffix("memo.txt"), Path("memo.txt"))

    def test_write_and_read_round_trip(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "メモ"
            saved_path = write_markdown(destination, "# 見出し\n本文\n")
            self.assertEqual(saved_path.suffix, ".md")
            self.assertEqual(read_markdown(saved_path), "# 見出し\n本文\n")

    def test_read_accepts_utf8_bom(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "bom.md"
            source.write_text("本文", encoding="utf-8-sig")
            self.assertEqual(read_markdown(source), "本文")


if __name__ == "__main__":
    unittest.main()
