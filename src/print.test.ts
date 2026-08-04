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
    expect(target.classList.contains("print-root-preparing")).toBe(false);
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

  it("主要なMarkdown要素へエディタ表示と対応するクラスを付ける", async () => {
    const target = document.createElement("article");
    await preparePrintDocument(
      [
        "# 見出し",
        "",
        "> 引用",
        "",
        "- [x] 完了",
        "- [ ] 未完了",
        "",
        "`inline`",
        "",
        "```ts",
        "const value = 1;",
        "```",
        "",
        "---",
        "",
        "| 項目 | 値 |",
        "| --- | --- |",
        "| A | B |",
      ].join("\n"),
      target,
      vi.fn(),
    );

    expect(target.querySelector("h1.mqm-heading-1")).not.toBeNull();
    expect(target.querySelector("blockquote.mqm-print-quote")).not.toBeNull();
    expect(target.querySelectorAll(".mqm-checkbox")).toHaveLength(2);
    expect(target.querySelector(".mqm-checkbox-checked")).not.toBeNull();
    expect(target.querySelector("code.mqm-inline-code")?.textContent).toBe(
      "inline",
    );
    expect(target.querySelector("pre.mqm-print-code-block")).not.toBeNull();
    expect(target.querySelector("hr.mqm-horizontal-rule")).not.toBeNull();
    expect(target.querySelector("table.mqm-table")).not.toBeNull();
  });

  it("表示できないブロック数式をコードブロックとは別の代替表示にする", async () => {
    const target = document.createElement("article");
    await preparePrintDocument("$$u&=v\\\\w&=z$$", target, vi.fn());

    expect(target.querySelector(".print-math-fallback")?.textContent).toBe(
      "$$u&=v\\\\w&=z$$",
    );
    expect(target.querySelector(".mqm-print-code-block")).toBeNull();
  });
});
