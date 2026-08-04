// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { preparePrintDocument } from "./print";

describe("preparePrintDocument", () => {
  it("MarkdownとKaTeXを印刷用HTMLへ変換する", async () => {
    const target = document.createElement("article");
    await preparePrintDocument(
      "# 見出し\n\n本文 $x^2$\n\n$$\\frac{a}{b}$$",
      target,
      vi.fn(),
    );

    expect(target.querySelector("h1")?.textContent).toBe("見出し");
    expect(target.querySelector(".print-math-inline .katex")).not.toBeNull();
    expect(target.querySelector(".print-math-display .katex")).not.toBeNull();
  });

  it("外部画像を取得せず代替表示へ置き換える", async () => {
    const target = document.createElement("article");
    const resolver = vi.fn<(path: string) => Promise<string>>();
    await preparePrintDocument(
      "![外部](https://example.com/image.png)",
      target,
      resolver,
    );

    expect(resolver).not.toHaveBeenCalled();
    expect(target.querySelector("img")).toBeNull();
    expect(target.querySelector(".print-image-blocked")?.textContent).toContain(
      "外部",
    );
  });
});
