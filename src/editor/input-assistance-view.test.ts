// @vitest-environment jsdom

import { defaultKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView, keymap, runScopeHandlers } from "@codemirror/view";
import { GFM } from "@lezer/markdown";
import { afterEach, describe, expect, it } from "vitest";
import { markdownDecorations } from "./decorations";
import {
  createPairInputHandler,
  markdownInputAssistance,
} from "./input-assistance";

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

function typeText(
  view: EditorView,
  handler: ReturnType<typeof createPairInputHandler>,
  text: string,
): boolean {
  const selection = view.state.selection.main;
  const handled = handler(view, selection.from, selection.to, text);
  if (!handled) {
    view.dispatch({
      changes: { from: selection.from, to: selection.to, insert: text },
      selection: { anchor: selection.from + text.length },
      userEvent: "input",
    });
  }
  return handled;
}

afterEach(() => {
  for (const view of views.splice(0)) {
    view.destroy();
  }
  window.document.body.replaceChildren();
});

describe("markdownInputAssistanceの実キーバインド", () => {
  it.each([
    ["(", ")"],
    ["[", "]"],
    ["{", "}"],
    ['"', '"'],
    ["'", "'"],
  ])("%sの補完直後に%sを入力すると一度だけ外側へ移動する", (open, close) => {
    const view = createView("");
    const handler = createPairInputHandler();

    expect(typeText(view, handler, open)).toBe(true);
    expect(view.state.doc.toString()).toBe(`${open}${close}`);
    expect(view.state.selection.main.head).toBe(1);

    expect(typeText(view, handler, close)).toBe(true);
    expect(view.state.doc.toString()).toBe(`${open}${close}`);
    expect(view.state.selection.main.head).toBe(2);

    expect(typeText(view, handler, close)).toBe(false);
    expect(view.state.doc.toString()).toBe(`${open}${close}${close}`);
  });

  it("補完後に別文字を入力すると閉じ記号を通常どおり挿入する", () => {
    const view = createView("");
    const handler = createPairInputHandler();

    typeText(view, handler, "(");
    expect(typeText(view, handler, "a")).toBe(false);
    expect(typeText(view, handler, ")")).toBe(false);
    expect(view.state.doc.toString()).toBe("(a))");
  });

  it("既存の閉じ記号は自動補完として扱わない", () => {
    const view = createView(")", 0);
    const handler = createPairInputHandler();

    expect(typeText(view, handler, ")")).toBe(false);
    expect(view.state.doc.toString()).toBe("))");
    expect(view.state.selection.main.head).toBe(1);
  });

  it("バッククォートを3回入力するとコードブロックを作成する", () => {
    const view = createView("");
    const handler = createPairInputHandler();

    expect(typeText(view, handler, "`")).toBe(true);
    expect(view.state.doc.toString()).toBe("``");
    expect(view.state.selection.main.head).toBe(1);

    expect(typeText(view, handler, "`")).toBe(true);
    expect(view.state.doc.toString()).toBe("``");
    expect(view.state.selection.main.head).toBe(2);

    expect(typeText(view, handler, "`")).toBe(true);

    expect(view.state.doc.toString()).toBe("```\n\n```");
    expect(view.state.selection.main.head).toBe(4);
  });

  it("通常行のTabで半角スペース4個を挿入しBackspaceでまとめて削除する", () => {
    const view = createView("本文", 0);

    expect(press(view, "Tab")).toBe(true);
    expect(view.state.doc.toString()).toBe("    本文");
    expect(view.state.selection.main.head).toBe(4);

    expect(press(view, "Backspace")).toBe(true);
    expect(view.state.doc.toString()).toBe("本文");
    expect(view.state.selection.main.head).toBe(0);
  });

  it("行頭の半角スペースは最大4個削除し行中では1文字だけ削除する", () => {
    const indentation = createView("      本文", 6);

    expect(press(indentation, "Backspace")).toBe(true);
    expect(indentation.state.doc.toString()).toBe("  本文");

    const inline = createView("a    b", 5);

    expect(press(inline, "Backspace")).toBe(true);
    expect(inline.state.doc.toString()).toBe("a   b");
  });

  it("リスト行のTabとShift+Tabで既存の階層変更を維持する", () => {
    const view = createView("- 項目");

    expect(press(view, "Tab")).toBe(true);
    expect(view.state.doc.toString()).toBe("  - 項目");

    expect(press(view, "Tab", true)).toBe(true);
    expect(view.state.doc.toString()).toBe("- 項目");
  });

  it("複数行選択は通常行を4個、リスト行を2個ずつ字下げする", () => {
    const document = "本文\n- 項目\n末尾";
    const view = createView(document);
    view.dispatch({
      selection: EditorSelection.range(0, document.length),
    });

    expect(press(view, "Tab")).toBe(true);
    expect(view.state.doc.toString()).toBe("    本文\n  - 項目\n    末尾");

    expect(press(view, "Tab", true)).toBe(true);
    expect(view.state.doc.toString()).toBe(document);
  });

  it("コードフェンス内のリスト風文字列では半角スペース4個を挿入する", () => {
    const document = "```\n- item\n```";
    const view = createView(document, 10);

    expect(press(view, "Tab")).toBe(true);
    expect(view.state.doc.toString()).toBe("```\n- item    \n```");
  });

  it("空引用のBackspaceは末尾の半角スペースだけを削除する", () => {
    const view = createView(">>>> ");

    expect(press(view, "Backspace")).toBe(true);
    expect(view.state.doc.toString()).toBe(">>>>");
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

  it("左右キーは表以外のDecorationをまたいでも論理位置を一文字ずつ移動する", () => {
    const document = [
      "# Heading",
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

  it("左右キー1回で隣の表セルへ移動する", () => {
    const document = "| 左 |  | 右 |\n| --- | --- | --- |";
    const leftCellEnd = document.indexOf("左") + 1;
    const emptyCell = document.indexOf("|  |") + 3;
    const rightCellStart = document.indexOf("右");
    const view = createView(document, leftCellEnd);

    expect(press(view, "ArrowRight")).toBe(true);
    expect(view.state.selection.main.head).toBe(emptyCell);
    expect(press(view, "ArrowRight")).toBe(true);
    expect(view.state.selection.main.head).toBe(rightCellStart);

    expect(press(view, "ArrowLeft")).toBe(true);
    expect(view.state.selection.main.head).toBe(emptyCell);
    expect(press(view, "ArrowLeft")).toBe(true);
    expect(view.state.selection.main.head).toBe(leftCellEnd);
  });

  it("左右キー1回で表端から最初と最後のセルへ移動する", () => {
    const document = "| 左 | 中 | 右 |\n| --- | --- | --- |";
    const firstCellStart = document.indexOf("左");
    const lastCellEnd = document.indexOf("右") + 1;
    const rightEdge = document.indexOf("\n");
    const view = createView(document, 0);

    expect(press(view, "ArrowRight")).toBe(true);
    expect(view.state.selection.main.head).toBe(firstCellStart);

    view.dispatch({ selection: { anchor: rightEdge } });
    expect(press(view, "ArrowLeft")).toBe(true);
    expect(view.state.selection.main.head).toBe(lastCellEnd);
  });
});
