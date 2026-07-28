"""アプリケーションのエントリーポイント。"""

from __future__ import annotations

import argparse
from pathlib import Path
import tkinter as tk

from .app import MarkdownQuickMemoApp


def parse_args(arguments: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="素早く使えるMarkdownメモアプリ")
    parser.add_argument("file", nargs="?", type=Path, help="起動時に開くMarkdownファイル")
    parser.add_argument(
        "--background",
        action="store_true",
        help="ホットキーから即座に表示できるようバックグラウンドで待機する",
    )
    return parser.parse_args(arguments)


def main() -> None:
    args = parse_args()
    root = tk.Tk()
    if args.background:
        root.withdraw()
    MarkdownQuickMemoApp(root, args.file, resident=args.background)
    root.mainloop()


if __name__ == "__main__":
    main()
