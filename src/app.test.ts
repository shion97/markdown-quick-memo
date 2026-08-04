// @vitest-environment jsdom

import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownQuickMemoApplication } from "./app";

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("MarkdownQuickMemoApplication", () => {
  it("上部へ文書情報とコンパクトな主操作一覧を配置する", () => {
    const root = document.createElement("div");
    document.body.append(root);
    new MarkdownQuickMemoApplication(root);

    const toolbar = root.querySelector(".toolbar");
    expect(toolbar?.querySelector("#cursor-position")).not.toBeNull();
    expect(toolbar?.querySelector("#status")).not.toBeNull();
    expect(
      toolbar?.querySelector(":scope > button[data-action='new']"),
    ).toBeNull();
    expect(root.querySelector("footer")).toBeNull();
    expect(root.textContent).not.toContain("Markdown原文を保存");

    const menuActions = Array.from(
      root.querySelectorAll<HTMLButtonElement>("#more-menu button"),
      (button) => button.dataset.action,
    );
    expect(menuActions).toEqual([
      "new",
      "open",
      "save",
      "save-as",
      "rename",
      "reveal",
      "export-pdf",
      "opacity",
      "hide",
      "exit",
      "settings",
    ]);
    expect(root.querySelector("#more-menu")?.textContent).toContain(
      "Ctrl+Shift+P",
    );
  });

  it("編集内容から目次を更新し、クリックした見出しへ移動する", () => {
    vi.useFakeTimers();
    const root = document.createElement("div");
    document.body.append(root);
    new MarkdownQuickMemoApplication(root);
    const editorElement = root.querySelector<HTMLElement>(".cm-editor");
    const view = EditorView.findFromDOM(editorElement!);
    const source = "本文\n\n# 見出し1\n\n### 見出し3";

    view!.dispatch({ changes: { from: 0, insert: source } });
    vi.advanceTimersByTime(120);

    const outline = root.querySelector<HTMLElement>("#outline");
    const headings = root.querySelectorAll<HTMLButtonElement>(".outline-item");
    expect(outline?.hidden).toBe(false);
    expect(Array.from(headings, (heading) => heading.textContent)).toEqual([
      "見出し1",
      "見出し3",
    ]);
    headings[1]?.click();
    expect(view?.state.selection.main.head).toBe(source.indexOf("###"));
    expect(view?.hasFocus).toBe(true);
  });
});
