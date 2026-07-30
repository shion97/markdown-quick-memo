// @vitest-environment jsdom

import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { GFM } from "@lezer/markdown";
import { afterEach, describe, expect, it } from "vitest";
import { markdownDecorations } from "./decorations";

const views: EditorView[] = [];

function renderDocument(source: string): HTMLElement {
  const parent = document.createElement("div");
  document.body.append(parent);
  const state = EditorState.create({
    doc: source,
    selection: { anchor: source.length },
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
});

describe("markdownDecorations", () => {
  it("報告されたMarkdown要素を編集用表示へ変換する", () => {
    const source = [
      "$$x^2 + y^2$$",
      "",
      "| 項目 | 値 |",
      "| --- | --- |",
      "| A | 1 |",
      "",
      "---",
      "",
      "- [ ] 未完了",
      "- [x] 完了",
      "",
      "`inline`",
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
    expect(parent.querySelector(".mqm-horizontal-rule")).not.toBeNull();
    expect(parent.querySelectorAll(".mqm-checkbox")).toHaveLength(2);
    expect(parent.querySelector(".mqm-checkbox-checked")).not.toBeNull();
    expect(parent.querySelector(".mqm-inline-code")?.textContent).toBe("inline");
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
});
