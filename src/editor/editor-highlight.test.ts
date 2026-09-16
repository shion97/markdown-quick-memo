// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ensureSyntaxTree } from "@codemirror/language";
import { type EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEditor, setPreviewOnly } from "./editor";

const views: EditorView[] = [];
const TEST_SYNTAX_PARSE_TIMEOUT_MS = 500;

function renderDocument(source: string): EditorView {
  const parent = document.createElement("div");
  document.body.append(parent);
  const style = document.createElement("style");
  style.textContent = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");
  parent.append(style);
  const view = createEditor(parent, {
    onDocumentChanged: vi.fn(),
    onCountsChanged: vi.fn(),
    onOutlineChanged: vi.fn(),
    onCursorChanged: vi.fn(),
    onControlClick: vi.fn(),
    onCopyText: vi.fn(),
  });
  views.push(view);
  view.dispatch({ changes: { from: 0, insert: source } });
  ensureSyntaxTree(view.state, view.state.doc.length, TEST_SYNTAX_PARSE_TIMEOUT_MS);
  view.dispatch({ selection: { anchor: 0 } });
  return view;
}

function isBoldAt(view: EditorView, position: number): boolean {
  const { node } = view.domAtPos(position);
  let element = node instanceof HTMLElement ? node : node.parentElement;
  while (element) {
    const weight = window.getComputedStyle(element).fontWeight;
    if (weight && weight !== "inherit") {
      return weight === "bold" || Number(weight) >= 600;
    }
    element = element.parentElement;
  }
  return false;
}

afterEach(() => {
  for (const view of views.splice(0)) {
    view.destroy();
  }
  document.body.replaceChildren();
});

describe("見出しの構文ハイライト", () => {
  it.each([false, true])("報告されたフェルミ粒子の文書で本文を太字にしない（閲覧モード: %s）", (previewOnly) => {
    const source = readFileSync(
      resolve(process.cwd(), "tests/fixtures/fermion-operators.md"),
      "utf8",
    ).replace(/\r\n/g, "\n");
    const view = renderDocument(source);
    setPreviewOnly(view, previewOnly);

    expect(isBoldAt(view, source.indexOf("フェルミ粒子を取り除く操作"))).toBe(true);
    for (const text of ["先ほどの式のエルミート共役は、", "である。ここで、"]) {
      const position = source.indexOf(text);
      view.dispatch({ selection: { anchor: position } });
      expect(isBoldAt(view, position)).toBe(false);
    }
    expect(view.dom.querySelector(".mqm-math-display .katex")).not.toBeNull();
    expect(view.state.doc.toString()).toBe(source);
  });

  it.each(["=", "---"])("数式内の %s で太字にならず、数式の編集後も本文を保持する", (operator) => {
    const source = `## フェルミ粒子を取り除く操作\n\n先ほどの式のエルミート共役は、\n$$\nA\n${operator}\nB\n$$\n後続の本文\n\n通常の段落`;
    const view = renderDocument(source);
    const formulaPosition = source.indexOf("A");
    view.dispatch({ selection: { anchor: formulaPosition } });
    expect(view.dom.querySelector(".mqm-math-source")).not.toBeNull();
    expect(isBoldAt(view, source.indexOf("先ほど"))).toBe(false);
    view.dispatch({ changes: { from: formulaPosition, to: formulaPosition + 1, insert: "C" } });
    view.dispatch({ selection: { anchor: source.indexOf("後続の本文") } });
    expect(isBoldAt(view, source.indexOf("先ほど"))).toBe(false);
    expect(isBoldAt(view, source.indexOf("後続の本文"))).toBe(false);
    expect(view.state.doc.toString()).toBe(source.replace("A", "C"));
  });

  it.each(["# 見出し", "  ## 見出し", "見出し\n===", "見出し\n---", "見出し $x$\n===", "**見出し**"])("通常の見出しと明示的な太字を維持する: %s", (heading) => {
    const source = `${heading}\n\n通常の本文`;
    const view = renderDocument(source);
    expect(isBoldAt(view, source.indexOf("見出し"))).toBe(true);
    expect(isBoldAt(view, source.indexOf("通常の本文"))).toBe(false);
  });
});
