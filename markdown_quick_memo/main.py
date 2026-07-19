"""アプリケーションのエントリーポイント。"""

from __future__ import annotations

import argparse
from pathlib import Path
import tkinter as tk

from .app import MarkdownQuickMemoApp
from .font_support import register_bundled_fonts


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="素早く使えるMarkdownメモアプリ")
    parser.add_argument("file", nargs="?", type=Path, help="起動時に開くMarkdownファイル")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    register_bundled_fonts()
    root = tk.Tk()
    MarkdownQuickMemoApp(root, args.file)
    root.mainloop()


if __name__ == "__main__":
    main()
