// @vitest-environment jsdom

import { defaultKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, runScopeHandlers } from "@codemirror/view";
import { GFM } from "@lezer/markdown";
import { afterEach, describe, expect, it } from "vitest";
import { markdownDecorations } from "./decorations";
import { markdownInputAssistance } from "./input-assistance";

const views: EditorView[] = [];

function createView(document: string, cursor = document.length): EditorView {
  const parent = window.document.createElement("div");
  window.document.body.append(parent);
  const state = EditorState.create({
    doc: document,
    selection: { anchor: cursor },
    extensions: [
      keymap.of(defaultKeymap),
      markdown({
        base: markdownLanguage,
        extensions: [GFM],
      }),
      markdownInputAssistance(),
      markdownDecorations,
      EditorView.lineWrapping,
    ],
  });
  const view = new EditorView({ state, parent });
  views.push(view);
  return view;
}

function press(view: EditorView, key: string, shiftKey = false): boolean {
  return runScopeHandlers(
    view,
    new KeyboardEvent("keydown", { key, shiftKey }),
    "editor",
  );
}

afterEach(() => {
  for (const view of views.splice(0)) {
    view.destroy();
  }
  window.document.body.replaceChildren();
});

describe("markdownInputAssistanceの実キーバインド", () => {
  it("通常行のTabを本文と選択範囲を変えずに消費する", () => {
    const view = createView("本文", 1);

    expect(press(view, "Tab")).toBe(true);
    expect(view.state.doc.toString()).toBe("本文");
    expect(view.state.selection.main.head).toBe(1);

    expect(press(view, "Tab", true)).toBe(true);
    expect(view.state.doc.toString()).toBe("本文");
    expect(view.state.selection.main.head).toBe(1);
  });

  it("リスト行のTabとShift+Tabで既存の階層変更を維持する", () => {
    const view = createView("- 項目");

    expect(press(view, "Tab")).toBe(true);
    expect(view.state.doc.toString()).toBe("  - 項目");

    expect(press(view, "Tab", true)).toBe(true);
    expect(view.state.doc.toString()).toBe("- 項目");
  });

  it("Enterでリストを一度継続し、空項目の次のEnterで終了する", () => {
    const view = createView("- item");

    expect(press(view, "Enter")).toBe(true);
    expect(view.state.doc.toString()).toBe("- item\n- ");
    expect(view.state.selection.main.head).toBe(9);

    expect(press(view, "Enter")).toBe(true);
    expect(view.state.doc.toString()).toBe("- item\n");
    expect(view.state.selection.main.head).toBe(7);
  });

  it("左右キーは各種Decorationをまたいでも論理位置を一文字ずつ移動する", () => {
    const document = [
      "# Heading",
      "",
      "| A | B |",
      "| --- | --- |",
      "| 1 | 2 |",
      "",
      "$$x^2$$",
      "",
      "*italic* and `code`",
      "",
      "- list",
    ].join("\n");
    const view = createView(document);

    for (let expected = document.length - 1; expected >= 0; expected -= 1) {
      expect(press(view, "ArrowLeft")).toBe(true);
      expect(view.state.selection.main.head).toBe(expected);
    }
    for (let expected = 1; expected <= document.length; expected += 1) {
      expect(press(view, "ArrowRight")).toBe(true);
      expect(view.state.selection.main.head).toBe(expected);
    }
  });
});
