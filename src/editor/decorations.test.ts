// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { GFM } from "@lezer/markdown";
import { afterEach, describe, expect, it } from "vitest";
import { markdownDecorations } from "./decorations";

const views: EditorView[] = [];

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

function renderDocument(source: string, cursor = source.length): HTMLElement {
  const parent = document.createElement("div");
  document.body.append(parent);
  const state = EditorState.create({
    doc: source,
    selection: { anchor: cursor },
    extensions: [
      markdown({
        base: markdownLanguage,
        extensions: [GFM],
      }),
      markdownDecorations,
      EditorView.lineWrapping,
    ],
  });
  const view = new EditorView({ state, parent });
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
    expect(parent.querySelector("table.mqm-table")).not.toBeNull();
    expect(
      parent.querySelector("table.mqm-table .mqm-inline-code")?.textContent,
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

  it("引用階層ごとに一文字幅で縦線を追加する", () => {
    const parent = renderDocument(
      "> 一階層\n> > 二階層\n> > > 三階層\n\nカーソル位置",
    );

    expect(parent.querySelectorAll(".mqm-quote-line")).toHaveLength(3);
    expect(parent.querySelectorAll(".mqm-quote-markers")).toHaveLength(3);
    expect(parent.querySelectorAll(".mqm-quote-marker")).toHaveLength(6);
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
