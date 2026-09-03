// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { GFM } from "@lezer/markdown";
import { afterEach, describe, expect, it } from "vitest";
import { markdownDecorations } from "./decorations";

const views: EditorView[] = [];
const TEST_SYNTAX_PARSE_TIMEOUT_MS = 500;

function loadApplicationStyles(): void {
  if (!document.head.querySelector("#application-styles")) {
    const style = document.createElement("style");
    style.id = "application-styles";
    style.textContent = readFileSync(
      resolve(process.cwd(), "src/styles.css"),
      "utf8",
    );
    document.head.append(style);
  }
}

function renderDocument(
  source: string,
  selection: number | { anchor: number; head: number } = source.length,
  readOnly = false,
): HTMLElement {
  const parent = document.createElement("div");
  document.body.append(parent);
  const state = EditorState.create({
    doc: source,
    selection:
      typeof selection === "number" ? { anchor: selection } : selection,
    extensions: [
      markdown({
        base: markdownLanguage,
        extensions: [GFM],
      }),
      markdownDecorations,
      EditorState.readOnly.of(readOnly),
      EditorView.lineWrapping,
    ],
  });
  const view = new EditorView({ state, parent });
  ensureSyntaxTree(view.state, view.state.doc.length, TEST_SYNTAX_PARSE_TIMEOUT_MS);
  view.dispatch({ selection: view.state.selection });
  views.push(view);
  return parent;
}

afterEach(() => {
  for (const view of views.splice(0)) {
    view.destroy();
  }
  document.body.replaceChildren();
  document.head.querySelector("#application-styles")?.remove();
});

describe("markdownDecorations", () => {
  it("報告されたMarkdown要素を編集用表示へ変換する", () => {
    const source = [
      "$$x^2 + y^2$$",
      "",
      "| 項目 | 値 |",
      "| --- | --- |",
      "| `code` | 1 |",
      "",
      "---",
      "",
      "- [ ] 未完了",
      "- [x] 完了",
      "",
      "`inline`",
      "",
      "*italic*",
      "",
      "```ts",
      "const value = 1;",
      "```",
      "",
      "カーソル位置",
    ].join("\n");

    const parent = renderDocument(source);

    expect(parent.querySelector(".mqm-math-display .katex")).not.toBeNull();
    expect(parent.querySelectorAll(".mqm-table-row")).toHaveLength(2);
    for (const row of parent.querySelectorAll(".mqm-table-row")) {
      expect(row.querySelectorAll(":scope > .mqm-table-cell")).toHaveLength(2);
    }
    expect(
      parent.querySelector(".mqm-table-row .mqm-inline-code")?.textContent,
    ).toBe("code");
    expect(parent.querySelector(".mqm-horizontal-rule")).not.toBeNull();
    expect(parent.querySelectorAll(".mqm-checkbox")).toHaveLength(2);
    expect(parent.querySelector(".mqm-checkbox-checked")).not.toBeNull();
    const inlineCodeValues = Array.from(
      parent.querySelectorAll(".mqm-inline-code"),
      (element) => element.textContent,
    );
    expect(inlineCodeValues).toEqual(["code", "inline"]);
    expect(parent.querySelector(".mqm-emphasis-content")?.textContent).toBe(
      "italic",
    );
    expect(parent.querySelectorAll(".mqm-code-block-line")).toHaveLength(3);
    expect(parent.querySelector(".mqm-code-language")?.textContent).toBe("ts");
  });

  it("リストのマーカーと折り返し用の行装飾を適用する", () => {
    const parent = renderDocument("- 項目\n  - 子項目\n\nカーソル位置");

    expect(parent.querySelectorAll(".mqm-list-line")).toHaveLength(2);
    expect(parent.querySelectorAll(".mqm-list-marker-bullet")).toHaveLength(2);
  });

  it("見出しへ下線を付けないクラスを適用する", () => {
    const parent = renderDocument("# 見出し\n\nカーソル位置");

    expect(parent.querySelector(".mqm-heading-1")?.textContent).toBe("見出し");
  });

  it("非選択のMarkdownリンクは名前だけをリンクとして装飾する", () => {
    const source = "前 [名前](https://example.com) 後\n\nカーソル位置";
    const parent = renderDocument(source);
    const link = parent.querySelector<HTMLElement>(".mqm-link-text");
    const editorElement = parent.querySelector<HTMLElement>(".cm-editor");
    const view = EditorView.findFromDOM(editorElement!);

    expect(link?.textContent).toBe("名前");
    expect(parent.textContent).not.toContain("https://example.com");
    expect(view?.state.doc.toString()).toBe(source);
  });

  it("選択中のMarkdownリンクは装飾を維持して原文を表示する", () => {
    const source = "[名前](https://example.com)";
    const parent = renderDocument(source, {
      anchor: source.indexOf("名前"),
      head: source.indexOf("名前") + 2,
    });

    expect(parent.querySelector(".mqm-link-text")?.textContent).toBe("名前");
    expect(parent.textContent).toContain(source);
  });

  it("編集中も見出しとリストの行装飾を維持して記号だけ原文へ戻す", () => {
    const heading = renderDocument("# 見出し", 2);
    expect(heading.querySelector(".mqm-heading-1")?.textContent).toBe(
      "# 見出し",
    );

    const list = renderDocument("- 項目", 3);
    expect(list.querySelector(".mqm-list-line")?.textContent).toBe("- 項目");
    expect(list.querySelector(".mqm-list-marker")).toBeNull();
  });

  it("編集中もインラインコードとコードブロックの装飾を維持する", () => {
    const inlineSource = "`code`";
    const inline = renderDocument(inlineSource, 2);
    expect(inline.querySelector(".mqm-inline-code")?.textContent).toBe("code");
    expect(inline.textContent).toContain(inlineSource);

    const blockSource = "```ts\nconst value = 1;\n```";
    const block = renderDocument(blockSource, blockSource.indexOf("value"));
    expect(block.querySelectorAll(".mqm-code-block-line")).toHaveLength(3);
    expect(block.textContent).toContain("```ts");
    expect(block.textContent).toContain("```");
  });

  it("数式原文とコードは通常本文の字体を継承する", () => {
    loadApplicationStyles();
    const source = [
      "通常本文",
      "",
      "$x^2$",
      "",
      "`inline`",
      "",
      "```ts",
      "const value = 1;",
      "```",
    ].join("\n");
    const mathPosition = source.indexOf("x^2");
    const parent = renderDocument(source, mathPosition);
    const normalText = parent.querySelector<HTMLElement>(".cm-content")!;
    const mathSource = parent.querySelector<HTMLElement>(
      ".mqm-decoration-source",
    )!;
    const inlineCode = parent.querySelector<HTMLElement>(".mqm-inline-code")!;
    const codeBlock = Array.from(
      parent.querySelectorAll<HTMLElement>(".mqm-code-block-line"),
    ).find((line) => line.textContent?.includes("const"))!;
    const normalStyle = window.getComputedStyle(normalText);
    const mathStyle = window.getComputedStyle(mathSource);

    expect(mathStyle.fontFamily).toBe(normalStyle.fontFamily);
    expect(mathStyle.fontSize).toBe(normalStyle.fontSize);
    expect(mathStyle.color).toBe(normalStyle.color);
    expect(window.getComputedStyle(inlineCode).fontFamily).toBe(
      normalStyle.fontFamily,
    );
    expect(window.getComputedStyle(codeBlock).fontFamily).toBe(
      normalStyle.fontFamily,
    );
  });

  it("表の枠とセルを維持したままセル本文を直接編集する", () => {
    loadApplicationStyles();
    const source = "| 項目 | 値 |\n| --- | --- |\n| 名前 \\| 別名 | |";
    const parent = renderDocument(source, source.indexOf("名前") + 1);
    const editorElement = parent.querySelector<HTMLElement>(".cm-editor")!;
    const view = EditorView.findFromDOM(editorElement)!;

    expect(parent.querySelectorAll(".mqm-table-row")).toHaveLength(2);
    expect(parent.querySelectorAll(".mqm-table-cell")).toHaveLength(4);
    expect(parent.querySelectorAll(".mqm-table-empty-cell")).toHaveLength(1);
    expect(
      window.getComputedStyle(parent.querySelector(".mqm-table-row")!).display,
    ).toBe("flex");

    const position = view.state.doc.toString().indexOf("名前");
    view.dispatch({ changes: { from: position, to: position + 2, insert: "氏名" } });
    expect(view.state.doc.toString()).toContain("| 氏名 \\| 別名 | |");
    expect(parent.querySelectorAll(".mqm-table-row")).toHaveLength(2);
  });

  it("2列から4列の表を行ごとに均等配置する", () => {
    loadApplicationStyles();

    for (const tableSize of [2, 3, 4]) {
      const heading = Array.from(
        { length: tableSize },
        (_, columnIndex) => `見出し${columnIndex + 1}`,
      );
      const separator = Array.from({ length: tableSize }, () => "---");
      const bodyRows = Array.from({ length: tableSize - 1 }, (_, rowIndex) =>
        Array.from(
          { length: tableSize },
          (_, columnIndex) => `${rowIndex + 1}-${columnIndex + 1}`,
        ),
      );
      const source = [heading, separator, ...bodyRows]
        .map((row) => `| ${row.join(" | ")} |`)
        .join("\n");
      const parent = renderDocument(source);
      const tableRows = parent.querySelectorAll<HTMLElement>(".mqm-table-row");

      expect(tableRows).toHaveLength(tableSize);
      for (const tableRow of tableRows) {
        const cells = tableRow.querySelectorAll<HTMLElement>(
          ":scope > .mqm-table-cell",
        );
        expect(cells).toHaveLength(tableSize);
        expect(window.getComputedStyle(tableRow).display).toBe("flex");
        for (const cell of cells) {
          expect(window.getComputedStyle(cell).flexGrow).toBe("1");
        }
      }
    }
  });

  it("編集中の数式と水平線は装飾と原文を併記する", () => {
    loadApplicationStyles();
    const mathSource = "$$\n\\frac{a}{b}\n$$";
    const math = renderDocument(mathSource, mathSource.indexOf("frac"));
    const mathEditor = math.querySelector<HTMLElement>(".cm-editor")!;
    const mathView = EditorView.findFromDOM(mathEditor)!;
    expect(math.querySelector(".mqm-math-display .katex")).not.toBeNull();
    expect(mathView.state.doc.toString()).toBe(mathSource);
    expect(
      math.querySelectorAll(".mqm-math-display-source-line"),
    ).toHaveLength(3);
    expect(
      math.querySelector(".mqm-math-display-source-start"),
    ).not.toBeNull();
    expect(
      math.querySelector(".mqm-math-display-source-end"),
    ).not.toBeNull();
    const displaySourceRule = Array.from(document.styleSheets)
      .flatMap((styleSheet) => Array.from(styleSheet.cssRules))
      .find(
        (rule) =>
          rule instanceof window.CSSStyleRule &&
          rule.selectorText === ".mqm-math-display-source-line",
      );
    expect(
      displaySourceRule instanceof window.CSSStyleRule
        ? displaySourceRule.style.background
        : undefined,
    ).toBe("var(--surface-muted)");

    const inlineSource = "$x^2$";
    const inline = renderDocument(inlineSource, 2);
    expect(inline.querySelector(".mqm-decoration-source")).not.toBeNull();
    expect(inline.querySelector(".mqm-math-display-source-line")).toBeNull();

    const oneLineDisplay = renderDocument("$$x^2$$", 3);
    const oneLineSource = oneLineDisplay.querySelector(
      ".mqm-math-display-source-line",
    );
    expect(oneLineSource?.classList).toContain(
      "mqm-math-display-source-start",
    );
    expect(oneLineSource?.classList).toContain("mqm-math-display-source-end");

    const ruleSource = "---";
    const rule = renderDocument(ruleSource, 1);
    expect(rule.querySelector(".mqm-horizontal-rule")).not.toBeNull();
    expect(rule.textContent).toContain(ruleSource);
  });

  it("独立数式に隣接する空行を上下1行ずつ表示上だけ折りたたむ", () => {
    const source = "前\n\n\n$$x^2$$\n\n\n後";
    const parent = renderDocument(source);
    const editorElement = parent.querySelector<HTMLElement>(".cm-editor")!;
    const view = EditorView.findFromDOM(editorElement)!;

    expect(parent.querySelectorAll(".mqm-math-gap-collapsed")).toHaveLength(2);
    expect(view.state.doc.toString()).toBe(source);
  });

  it("独立数式の隣接空行へカーソルを移すとその行を表示する", () => {
    const source = "前\n\n$$x^2$$\n\n後";
    const upperGapPosition = source.indexOf("$$") - 1;
    const parent = renderDocument(source, upperGapPosition);

    expect(parent.querySelectorAll(".mqm-math-gap-collapsed")).toHaveLength(1);
  });

  it("行内の数式では周囲の空行を折りたたまない", () => {
    const source = "前\n\n本文 $$x^2$$\n\n後";
    const parent = renderDocument(source);

    expect(parent.querySelector(".mqm-math-gap-collapsed")).toBeNull();
  });

  it("閲覧モードでは選択してもMarkdown原文へ戻さない", () => {
    const source = "[名前](https://example.com)\n\n$$x^2$$";
    const parent = renderDocument(source, source.indexOf("名前") + 1, true);

    expect(parent.querySelector(".mqm-link-text")?.textContent).toBe("名前");
    expect(parent.textContent).not.toContain("https://example.com");
    expect(parent.querySelector(".mqm-math-display .katex")).not.toBeNull();
  });

  it("引用階層ごとに一文字幅で縦線を追加する", () => {
    const parent = renderDocument(
      "> 一階層\n> > 二階層\n> > > 三階層\n\nカーソル位置",
    );

    expect(parent.querySelectorAll(".mqm-quote-line")).toHaveLength(3);
    expect(parent.querySelectorAll(".mqm-quote-markers")).toHaveLength(3);
    expect(parent.querySelectorAll(".mqm-quote-marker")).toHaveLength(6);
  });

  it("編集中の引用でも縦線とMarkdown原文を同時表示する", () => {
    const source = "> 編集中\n\n通常行";
    const parent = renderDocument(source, 2);
    const activeQuote = parent.querySelector<HTMLElement>(
      ".mqm-quote-line-active",
    );

    expect(activeQuote?.querySelector(".mqm-quote-markers")).not.toBeNull();
    expect(activeQuote?.textContent).toContain("> 編集中");
  });

  it("長い半角・全角引用へ折り返し用の行装飾を適用する", () => {
    loadApplicationStyles();
    const continuousAscii = "a".repeat(160);
    const spacedAscii = Array.from({ length: 80 }, () => "word").join(" ");
    const fullWidth = "あ".repeat(160);
    const source = [
      `> ${continuousAscii}`,
      `> ${spacedAscii}`,
      `> ${fullWidth}`,
      "",
      "カーソル位置",
    ].join("\n");
    const parent = renderDocument(source);
    const quoteLines = Array.from(
      parent.querySelectorAll<HTMLElement>(".mqm-quote-line"),
    );

    expect(quoteLines).toHaveLength(3);
    for (const line of quoteLines) {
      expect(line.getAttribute("style")).toContain(
        "--mqm-quote-marker-width: 1em",
      );
      expect(window.getComputedStyle(line).position).toBe("relative");
      expect(window.getComputedStyle(line).overflowWrap).toBe("anywhere");
      expect(window.getComputedStyle(line).textIndent).toBe("0px");
      expect(window.getComputedStyle(line).wordBreak).toBe("break-all");

      const markers = line.querySelector<HTMLElement>(".mqm-quote-markers");
      expect(markers).not.toBeNull();
      expect(window.getComputedStyle(markers!).position).toBe("absolute");
      expect(window.getComputedStyle(markers!).top).toBe("0px");
      expect(window.getComputedStyle(markers!).bottom).toBe("0px");
    }
    expect(quoteLines[0]?.textContent).toBe(continuousAscii);
    expect(quoteLines[1]?.textContent).toBe(spacedAscii);
    expect(quoteLines[2]?.textContent).toBe(fullWidth);
  });

  it("編集中の長い引用は原文だけを先頭へ戻し、折り返し位置を維持する", () => {
    loadApplicationStyles();
    const source = `> ${"a".repeat(160)}`;
    const parent = renderDocument(source, 2);
    const quoteLine = parent.querySelector<HTMLElement>(
      ".mqm-quote-line-active",
    );

    expect(quoteLine?.textContent).toBe(source);
    expect(
      window
        .getComputedStyle(quoteLine!)
        .getPropertyValue("--mqm-quote-prefix-width"),
    ).toContain("--mqm-quote-source-width");
    expect(window.getComputedStyle(quoteLine!).textIndent).toContain(
      "--mqm-quote-source-width",
    );
    expect(window.getComputedStyle(quoteLine!).overflowWrap).toBe("anywhere");
    expect(window.getComputedStyle(quoteLine!).wordBreak).toBe("break-all");
  });

  it("標準チェックリストは別行へ移動するとチェック枠へ変換する", () => {
    const source = "- [ ] 本文\n\nカーソル位置";
    const parent = renderDocument(source, source.length);

    expect(parent.querySelectorAll(".mqm-checkbox")).toHaveLength(1);
    expect(parent.textContent).not.toContain("[ ] 本文");
  });

  it("連続する引用行だけを階層ごとに接続する", () => {
    const parent = renderDocument(
      "> 一階層\n> > 二階層\n> 一階層\n\n> 別の引用\n\nカーソル位置",
    );
    const markerGroups = Array.from(
      parent.querySelectorAll<HTMLElement>(".mqm-quote-markers"),
    );

    expect(markerGroups).toHaveLength(4);
    expect(
      markerGroups[0]?.querySelectorAll(".mqm-quote-marker-connect-after"),
    ).toHaveLength(1);
    expect(
      markerGroups[1]?.querySelectorAll(".mqm-quote-marker-connect-before"),
    ).toHaveLength(1);
    expect(
      markerGroups[1]?.querySelectorAll(".mqm-quote-marker-connect-after"),
    ).toHaveLength(1);
    expect(
      markerGroups[2]?.querySelectorAll(".mqm-quote-marker-connect-before"),
    ).toHaveLength(1);
    expect(
      markerGroups[2]?.querySelectorAll(".mqm-quote-marker-connect-after"),
    ).toHaveLength(0);
    expect(
      markerGroups[3]?.querySelectorAll(
        ".mqm-quote-marker-connect-before, .mqm-quote-marker-connect-after",
      ),
    ).toHaveLength(0);
  });

  it("カーソルが斜体内にあっても内容の斜体表示を維持する", () => {
    loadApplicationStyles();
    const parent = renderDocument("*A* と *日本語*", 1);
    const emphasis = parent.querySelector<HTMLElement>(
      ".mqm-emphasis-content",
    );

    expect(emphasis?.textContent).toBe("A");
    expect(window.getComputedStyle(emphasis!).fontStyle).toBe("italic");
    expect(window.getComputedStyle(emphasis!).fontSynthesis).toBe("style");
    expect(parent.querySelectorAll(".mqm-emphasis-content")).toHaveLength(2);
  });
});
