// @vitest-environment jsdom

import { searchPanelOpen } from "@codemirror/search";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownQuickMemoApplication } from "./app";

if (!window.Range.prototype.getClientRects) {
  Object.defineProperty(window.Range.prototype, "getClientRects", {
    configurable: true,
    value: () => [],
  });
}

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
    const shortcutText = root.querySelector("#more-menu")?.textContent ?? "";
    for (const shortcut of [
      "Ctrl+Alt+M",
      "Ctrl+Z / Ctrl+Y",
      "Ctrl+F",
      "Ctrl+T",
      "Ctrl+B / Ctrl+I",
      "Ctrl+Shift+X",
      "Tab / Shift+Tab",
      "Shift+Enter",
      "Ctrl+クリック",
    ]) {
      expect(shortcutText).toContain(shortcut);
    }
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

  it("目次のレベル1から3だけを開閉でき、再描画後も状態を維持する", () => {
    vi.useFakeTimers();
    const root = document.createElement("div");
    document.body.append(root);
    new MarkdownQuickMemoApplication(root);
    const editorElement = root.querySelector<HTMLElement>(".cm-editor");
    const view = EditorView.findFromDOM(editorElement!);
    const source = [
      "# 親",
      "## 子",
      "### 孫",
      "#### 詳細",
      "# 次の親",
    ].join("\n");

    view!.dispatch({ changes: { from: 0, insert: source } });
    vi.advanceTimersByTime(120);

    const toggles = root.querySelectorAll<HTMLButtonElement>(
      "button[data-outline-toggle-key]",
    );
    expect(toggles).toHaveLength(3);
    expect(
      root.querySelector<HTMLButtonElement>(
        "button[data-heading-position][title='詳細']",
      )
        ?.closest(".outline-row")
        ?.querySelector("button[data-outline-toggle-key]"),
    ).toBeNull();

    toggles[0]?.click();
    expect(toggles[0]?.getAttribute("aria-expanded")).toBe("false");
    expect(
      toggles[0]
        ?.closest(".outline-node")
        ?.querySelector<HTMLElement>(":scope > .outline-children")?.hidden,
    ).toBe(true);

    view!.dispatch({ changes: { from: source.length, insert: "\n本文" } });
    vi.advanceTimersByTime(120);

    const rerenderedToggle = root.querySelector<HTMLButtonElement>(
      "button[data-outline-toggle-key]",
    );
    expect(rerenderedToggle?.getAttribute("aria-expanded")).toBe("false");
    expect(
      rerenderedToggle
        ?.closest(".outline-node")
        ?.querySelector<HTMLElement>(":scope > .outline-children")?.hidden,
    ).toBe(true);
  });

  it("目次幅を240pxから480pxまで40px刻みで変更する", () => {
    const root = document.createElement("div");
    document.body.append(root);
    new MarkdownQuickMemoApplication(root);
    const workspace = root.querySelector<HTMLElement>("#workspace");
    const expand = root.querySelector<HTMLButtonElement>(
      "button[data-action='outline-expand']",
    );
    const shrink = root.querySelector<HTMLButtonElement>(
      "button[data-action='outline-shrink']",
    );

    expect(workspace?.style.getPropertyValue("--outline-width")).toBe("240px");
    expect(shrink?.disabled).toBe(true);

    expand?.click();
    expect(workspace?.style.getPropertyValue("--outline-width")).toBe("280px");
    expect(shrink?.disabled).toBe(false);

    for (let count = 0; count < 5; count += 1) {
      expand?.click();
    }
    expect(workspace?.style.getPropertyValue("--outline-width")).toBe("480px");
    expect(expand?.disabled).toBe(true);

    shrink?.click();
    expect(workspace?.style.getPropertyValue("--outline-width")).toBe("440px");
  });

  it("Ctrlと左右キーで目次幅を変更し、入力欄では横移動を維持する", () => {
    const root = document.createElement("div");
    document.body.append(root);
    new MarkdownQuickMemoApplication(root);
    const workspace = root.querySelector<HTMLElement>("#workspace")!;
    const editorContent = root.querySelector<HTMLElement>(".cm-content")!;
    const hotkeyInput = root.querySelector<HTMLInputElement>("#hotkey-input")!;

    const expandEvent = new KeyboardEvent("keydown", {
      key: "ArrowLeft",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    editorContent.dispatchEvent(expandEvent);
    expect(expandEvent.defaultPrevented).toBe(true);
    expect(workspace.style.getPropertyValue("--outline-width")).toBe("280px");

    editorContent.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowRight",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(workspace.style.getPropertyValue("--outline-width")).toBe("240px");

    hotkeyInput.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowLeft",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(workspace.style.getPropertyValue("--outline-width")).toBe("240px");
  });

  it("日本語検索パネルをCtrl+Fで開閉し、現行の検索・置換機能を維持する", () => {
    const root = document.createElement("div");
    document.body.append(root);
    new MarkdownQuickMemoApplication(root);
    const editorElement = root.querySelector<HTMLElement>(".cm-editor")!;
    const view = EditorView.findFromDOM(editorElement)!;
    view.dispatch({ changes: { from: 0, insert: "先頭 日本語 末尾 日本語" } });

    view.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "f",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(searchPanelOpen(view.state)).toBe(true);
    const searchInput = root.querySelector<HTMLInputElement>(
      ".cm-search input[name='search']",
    )!;
    expect(searchInput.placeholder).toBe("検索");
    expect(root.querySelector(".cm-search")?.textContent).toContain("次へ");
    expect(root.querySelector(".cm-search")?.textContent).toContain("前へ");
    expect(root.querySelector(".cm-search")?.textContent).toContain("すべて置換");
    expect(root.querySelector(".cm-search input[name='replace']")).not.toBeNull();
    expect(root.querySelector(".cm-search input[name='case']")).not.toBeNull();
    expect(root.querySelector(".cm-search input[name='re']")).not.toBeNull();
    expect(root.querySelector(".cm-search input[name='word']")).not.toBeNull();

    searchInput.value = "日本語";
    searchInput.dispatchEvent(new Event("change", { bubbles: true }));
    root.querySelector<HTMLButtonElement>(
      ".cm-search button[name='next']",
    )?.click();
    const selection = view.state.selection.main;
    expect(view.state.sliceDoc(selection.from, selection.to)).toBe("日本語");

    searchInput.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "f",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(searchPanelOpen(view.state)).toBe(false);
  });

  it("三点メニューを外側クリックで閉じる", () => {
    const root = document.createElement("div");
    document.body.append(root);
    new MarkdownQuickMemoApplication(root);
    const trigger = root.querySelector<HTMLButtonElement>(
      "button[data-action='more']",
    );
    const menu = root.querySelector<HTMLElement>("#more-menu");

    trigger?.click();
    expect(menu?.hidden).toBe(false);
    expect(trigger?.getAttribute("aria-expanded")).toBe("true");

    document.body.click();
    expect(menu?.hidden).toBe(true);
    expect(trigger?.getAttribute("aria-expanded")).toBe("false");
  });
});
