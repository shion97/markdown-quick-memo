// @vitest-environment jsdom

import { languages } from "@codemirror/language-data";
import { searchPanelOpen } from "@codemirror/search";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { backend } from "./bridge/tauri";
import { MarkdownQuickMemoApplication } from "./app";

const dialogMocks = vi.hoisted(() => ({
  ask: vi.fn(),
  message: vi.fn(),
  open: vi.fn(),
  save: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => dialogMocks);

if (!window.Range.prototype.getClientRects) {
  Object.defineProperty(window.Range.prototype, "getClientRects", {
    configurable: true,
    value: () => [],
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  document.body.replaceChildren();
});

function setApplicationDocument(
  application: MarkdownQuickMemoApplication,
  content: string,
  path: string | null,
): void {
  (
    application as unknown as {
      setDocument(document: string, documentPath: string | null): void;
    }
  ).setDocument(content, path);
}

function saveApplicationDocument(
  application: MarkdownQuickMemoApplication,
): Promise<boolean> {
  return (
    application as unknown as {
      saveDocument(saveAs: boolean): Promise<boolean>;
    }
  ).saveDocument(false);
}

describe("MarkdownQuickMemoApplication", () => {
  it("Juliaコードブロックを言語別にハイライトする", async () => {
    const julia = languages.find((language) => language.name === "Julia");
    expect(julia).toBeDefined();
    await julia!.load();

    const root = document.createElement("div");
    document.body.append(root);
    const application = new MarkdownQuickMemoApplication(root);
    setApplicationDocument(
      application,
      [
        "```julia",
        "function square(value)",
        "  println(\"value\")",
        "  return value ^ 2",
        "end",
        "```",
      ].join("\n"),
      null,
    );

    expect(root.querySelector(".mqm-syntax-keyword")?.textContent).toBe(
      "function",
    );
    expect(root.querySelector(".mqm-syntax-string")?.textContent).toBe(
      '"value"',
    );
    expect(root.querySelector(".mqm-syntax-constant")?.textContent).toBe("2");
    expect(root.querySelector(".mqm-code-block-line")).not.toBeNull();
    expect(root.querySelector(".mqm-code-language")?.textContent).toBe("julia");
  });

  it("上部へ文書情報とコンパクトな主操作一覧を配置する", () => {
    const root = document.createElement("div");
    document.body.append(root);
    new MarkdownQuickMemoApplication(root);

    const toolbar = root.querySelector(".toolbar");
    expect(toolbar?.querySelector("#cursor-position")).not.toBeNull();
    expect(toolbar?.querySelector("#status")).not.toBeNull();
    expect(toolbar?.querySelector("button[data-action='preview']")).not.toBeNull();
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
      "preview",
      "opacity",
      "hide",
      "exit",
      "settings",
    ]);
    expect(root.querySelector("#more-menu")?.textContent).toContain(
      "Ctrl+P",
    );
    const shortcutText = root.querySelector("#more-menu")?.textContent ?? "";
    for (const shortcut of [
      "Ctrl+Alt+M",
      "Ctrl+Shift+S",
      "Ctrl+R",
      "Ctrl+E",
      "Ctrl+P",
      "Ctrl+Z / Ctrl+Y",
      "Ctrl+F",
      "Ctrl+T",
      "Ctrl+B / Ctrl+I",
      "Ctrl+X",
      "Tab / Shift+Tab",
      "Shift+Enter",
      "Ctrl+クリック",
      "Ctrl+L",
      "Ctrl+M",
      "Ctrl+O",
      "Ctrl+H",
    ]) {
      expect(shortcutText).toContain(shortcut);
    }
  });

  it("Ctrl+Mで閲覧モードを切り替える", () => {
    const root = document.createElement("div");
    document.body.append(root);
    new MarkdownQuickMemoApplication(root);
    const view = EditorView.findFromDOM(root.querySelector<HTMLElement>(".cm-editor")!)!;

    view.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "m",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(view.state.readOnly).toBe(true);
  });

  it("Ctrl+Oでファイルを開き、Ctrl+Hで半透明表示を切り替える", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    const application = new MarkdownQuickMemoApplication(root);
    const handleShortcut = (
      application as unknown as {
        handleShortcut(event: KeyboardEvent): Promise<void>;
      }
    ).handleShortcut.bind(application);
    dialogMocks.open.mockResolvedValue(null);
    const setWindowOpacity = vi
      .spyOn(backend, "setWindowOpacity")
      .mockResolvedValue();

    await handleShortcut(new KeyboardEvent("keydown", { key: "o", ctrlKey: true }));
    expect(dialogMocks.open).toHaveBeenCalledOnce();

    await handleShortcut(new KeyboardEvent("keydown", { key: "h", ctrlKey: true }));
    expect(setWindowOpacity).toHaveBeenCalledWith(0.6);
  });

  it("上部ボタンで閲覧モードを切り替え、本文変更だけを拒否する", () => {
    const root = document.createElement("div");
    document.body.append(root);
    const application = new MarkdownQuickMemoApplication(root);
    setApplicationDocument(application, "本文", null);
    const editorElement = root.querySelector<HTMLElement>(".cm-editor")!;
    const view = EditorView.findFromDOM(editorElement)!;
    const button = root.querySelector<HTMLButtonElement>(
      "button[data-action='preview']",
    )!;

    button.click();
    expect(view.state.readOnly).toBe(true);
    expect(button.textContent).toBe("編集モードへ戻る");
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(root.querySelector("#editor")?.getAttribute("aria-label")).toBe(
      "Markdown閲覧欄",
    );

    view.dispatch({ changes: { from: 2, insert: "変更" } });
    expect(view.state.doc.toString()).toBe("本文");
    view.dispatch({ selection: { anchor: 0, head: 2 } });
    expect(view.state.selection.main.to).toBe(2);

    setApplicationDocument(application, "別文書", null);
    expect(view.state.readOnly).toBe(true);
    button.click();
    expect(view.state.readOnly).toBe(false);
    view.dispatch({ changes: { from: 3, insert: "を編集" } });
    expect(view.state.doc.toString()).toBe("別文書を編集");
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

  it("Ctrl+Lで目次操作を切り替え、Ctrlと上下キーで編集位置を移動する", () => {
    vi.useFakeTimers();
    const root = document.createElement("div");
    document.body.append(root);
    new MarkdownQuickMemoApplication(root);
    const editorElement = root.querySelector<HTMLElement>(".cm-editor")!;
    const view = EditorView.findFromDOM(editorElement)!;
    const source = "# 見出し1\n本文\n# 見出し2";
    view.dispatch({ changes: { from: 0, insert: source } });
    vi.advanceTimersByTime(120);

    const startEvent = new KeyboardEvent("keydown", {
      key: "l",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    view.contentDOM.dispatchEvent(startEvent);

    const outline = root.querySelector<HTMLElement>("#outline")!;
    expect(startEvent.defaultPrevented).toBe(true);
    expect(outline.classList.contains("outline-navigation-active")).toBe(true);
    expect(
      root.querySelector<HTMLButtonElement>(".outline-item[aria-current='location']")
        ?.textContent,
    ).toBe("見出し1");
    expect(view.state.selection.main.head).toBe(0);

    view.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "l",
        ctrlKey: true,
        repeat: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(outline.classList.contains("outline-navigation-active")).toBe(true);

    const inputEvent = new KeyboardEvent("keydown", {
      key: "あ",
      bubbles: true,
      cancelable: true,
    });
    view.contentDOM.dispatchEvent(inputEvent);
    expect(inputEvent.defaultPrevented).toBe(false);

    view.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowDown",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(
      root.querySelector<HTMLButtonElement>(".outline-item[aria-current='location']")
        ?.textContent,
    ).toBe("見出し2");
    expect(view.state.selection.main.head).toBe(source.indexOf("# 見出し2"));

    view.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowUp",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(view.state.selection.main.head).toBe(0);

    view.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "l",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(outline.classList.contains("outline-navigation-active")).toBe(false);
    expect(root.querySelector(".outline-item[aria-current]")).toBeNull();
    expect(view.hasFocus).toBe(true);
  });

  it("目次操作では折りたたまれた項目を飛ばす", () => {
    vi.useFakeTimers();
    const root = document.createElement("div");
    document.body.append(root);
    new MarkdownQuickMemoApplication(root);
    const editorElement = root.querySelector<HTMLElement>(".cm-editor")!;
    const view = EditorView.findFromDOM(editorElement)!;
    const source = "# 親\n## 子\n# 次";
    view.dispatch({ changes: { from: 0, insert: source } });
    vi.advanceTimersByTime(120);
    root.querySelector<HTMLButtonElement>("button[data-outline-toggle-key]")?.click();

    view.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "l",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    view.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowDown",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(
      root.querySelector<HTMLButtonElement>(".outline-item[aria-current='location']")
        ?.textContent,
    ).toBe("次");
    expect(view.state.selection.main.head).toBe(source.indexOf("# 次"));
  });

  it("目次の上下キー長押しを600ミリ秒と1200ミリ秒で加速する", () => {
    vi.useFakeTimers();
    const root = document.createElement("div");
    document.body.append(root);
    new MarkdownQuickMemoApplication(root);
    const editorElement = root.querySelector<HTMLElement>(".cm-editor")!;
    const view = EditorView.findFromDOM(editorElement)!;
    const source = Array.from(
      { length: 10 },
      (_, index) => `# 見出し${index + 1}`,
    ).join("\n");
    view.dispatch({ changes: { from: 0, insert: source } });
    vi.advanceTimersByTime(120);
    view.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "l",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );

    const moveDown = (repeat: boolean): void => {
      view.contentDOM.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowDown",
          ctrlKey: true,
          repeat,
          bubbles: true,
          cancelable: true,
        }),
      );
    };
    const selectedLabel = (): string | null =>
      root.querySelector<HTMLButtonElement>(
        ".outline-item[aria-current='location']",
      )?.textContent ?? null;

    moveDown(false);
    expect(selectedLabel()).toBe("見出し2");
    vi.advanceTimersByTime(600);
    moveDown(true);
    expect(selectedLabel()).toBe("見出し4");
    vi.advanceTimersByTime(600);
    moveDown(true);
    expect(selectedLabel()).toBe("見出し8");
  });

  it("目次再描画後も選択を維持し、対象が消えたら先頭へ戻す", () => {
    vi.useFakeTimers();
    const root = document.createElement("div");
    document.body.append(root);
    new MarkdownQuickMemoApplication(root);
    const editorElement = root.querySelector<HTMLElement>(".cm-editor")!;
    const view = EditorView.findFromDOM(editorElement)!;
    const source = "# 見出し1\n# 見出し2";
    view.dispatch({ changes: { from: 0, insert: source } });
    vi.advanceTimersByTime(120);
    view.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "l",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    view.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowDown",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );

    view.dispatch({ changes: { from: source.length, insert: "\n本文" } });
    vi.advanceTimersByTime(120);
    expect(
      root.querySelector<HTMLButtonElement>(".outline-item[aria-current='location']")
        ?.textContent,
    ).toBe("見出し2");

    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "# 見出し1" } });
    vi.advanceTimersByTime(120);
    expect(
      root.querySelector<HTMLButtonElement>(".outline-item[aria-current='location']")
        ?.textContent,
    ).toBe("見出し1");
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

  it("日本語検索パネルへ件数と現在位置を表示し、検索・置換へ追従する", async () => {
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
    await new Promise<void>((resolve) => window.queueMicrotask(resolve));
    expect(root.querySelector(".mqm-search-match-status")?.textContent).toBe(
      "0 / 0 件",
    );

    searchInput.value = "日本語";
    searchInput.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise<void>((resolve) => window.queueMicrotask(resolve));
    expect(root.querySelector(".mqm-search-match-status")?.textContent).toBe(
      "1 / 2 件",
    );
    root.querySelector<HTMLButtonElement>(
      ".cm-search button[name='next']",
    )?.click();
    const selection = view.state.selection.main;
    expect(view.state.sliceDoc(selection.from, selection.to)).toBe("日本語");
    root.querySelector<HTMLButtonElement>(
      ".cm-search button[name='next']",
    )?.click();
    await new Promise<void>((resolve) => window.queueMicrotask(resolve));
    expect(root.querySelector(".mqm-search-match-status")?.textContent).toBe(
      "2 / 2 件",
    );

    const replaceInput = root.querySelector<HTMLInputElement>(
      ".cm-search input[name='replace']",
    )!;
    replaceInput.value = "置換済み";
    replaceInput.dispatchEvent(new Event("change", { bubbles: true }));
    root.querySelector<HTMLButtonElement>(
      ".cm-search button[name='replace']",
    )?.click();
    await new Promise<void>((resolve) => window.queueMicrotask(resolve));
    expect(root.querySelector(".mqm-search-match-status")?.textContent).toBe(
      "1 / 1 件",
    );

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

  it("検索件数は大文字小文字・単語単位・無効な正規表現を反映する", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    new MarkdownQuickMemoApplication(root);
    const editorElement = root.querySelector<HTMLElement>(".cm-editor")!;
    const view = EditorView.findFromDOM(editorElement)!;
    view.dispatch({ changes: { from: 0, insert: "Memo memo memo2" } });
    view.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "f",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    const searchInput = root.querySelector<HTMLInputElement>(
      ".cm-search input[name='search']",
    )!;
    const caseInput = root.querySelector<HTMLInputElement>(
      ".cm-search input[name='case']",
    )!;
    const wordInput = root.querySelector<HTMLInputElement>(
      ".cm-search input[name='word']",
    )!;
    const regexpInput = root.querySelector<HTMLInputElement>(
      ".cm-search input[name='re']",
    )!;
    const flushStatus = (): Promise<void> =>
      new Promise((resolve) => window.queueMicrotask(resolve));

    searchInput.value = "Memo";
    searchInput.dispatchEvent(new Event("change", { bubbles: true }));
    await flushStatus();
    expect(root.querySelector(".mqm-search-match-status")?.textContent).toBe(
      "1 / 3 件",
    );

    caseInput.checked = true;
    caseInput.dispatchEvent(new Event("change", { bubbles: true }));
    await flushStatus();
    expect(root.querySelector(".mqm-search-match-status")?.textContent).toBe(
      "1 / 1 件",
    );

    caseInput.checked = false;
    wordInput.checked = true;
    wordInput.dispatchEvent(new Event("change", { bubbles: true }));
    await flushStatus();
    expect(root.querySelector(".mqm-search-match-status")?.textContent).toBe(
      "1 / 2 件",
    );

    searchInput.value = "[";
    regexpInput.checked = true;
    regexpInput.dispatchEvent(new Event("change", { bubbles: true }));
    await flushStatus();
    expect(root.querySelector(".mqm-search-match-status")?.textContent).toBe(
      "0 / 0 件",
    );
  });

  it("保存済み文書は入力停止から1秒後に自動保存する", async () => {
    vi.useFakeTimers();
    const root = document.createElement("div");
    document.body.append(root);
    const application = new MarkdownQuickMemoApplication(root);
    const path = "C:\\memo.md";
    setApplicationDocument(application, "初期", path);
    const editorElement = root.querySelector<HTMLElement>(".cm-editor")!;
    const view = EditorView.findFromDOM(editorElement)!;
    const saveDocument = vi
      .spyOn(backend, "saveDocument")
      .mockResolvedValue({ path, revision: 1 });

    view.dispatch({ changes: { from: view.state.doc.length, insert: "更新" } });
    await vi.advanceTimersByTimeAsync(999);
    expect(saveDocument).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(saveDocument).toHaveBeenCalledOnce();
    expect(saveDocument).toHaveBeenCalledWith("初期更新", 1, undefined);
    expect(root.querySelector("#document-title")?.textContent).toBe("memo.md");
  });

  it("未保存の新規文書は自動保存しない", async () => {
    vi.useFakeTimers();
    const root = document.createElement("div");
    document.body.append(root);
    const application = new MarkdownQuickMemoApplication(root);
    setApplicationDocument(application, "", null);
    const editorElement = root.querySelector<HTMLElement>(".cm-editor")!;
    const view = EditorView.findFromDOM(editorElement)!;
    const saveDocument = vi.spyOn(backend, "saveDocument");

    view.dispatch({ changes: { from: 0, insert: "未保存" } });
    await vi.advanceTimersByTimeAsync(2_000);

    expect(saveDocument).not.toHaveBeenCalled();
    expect(dialogMocks.save).not.toHaveBeenCalled();
  });

  it("手動保存は即時実行し、待機中の自動保存を重複させない", async () => {
    vi.useFakeTimers();
    const root = document.createElement("div");
    document.body.append(root);
    const application = new MarkdownQuickMemoApplication(root);
    const path = "C:\\memo.md";
    setApplicationDocument(application, "初期", path);
    const editorElement = root.querySelector<HTMLElement>(".cm-editor")!;
    const view = EditorView.findFromDOM(editorElement)!;
    const saveDocument = vi
      .spyOn(backend, "saveDocument")
      .mockResolvedValue({ path, revision: 1 });

    view.dispatch({ changes: { from: view.state.doc.length, insert: "更新" } });
    await saveApplicationDocument(application);

    expect(saveDocument).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(saveDocument).toHaveBeenCalledOnce();
  });

  it("文書切替時は旧文書の自動保存タイマーを解除する", async () => {
    vi.useFakeTimers();
    const root = document.createElement("div");
    document.body.append(root);
    const application = new MarkdownQuickMemoApplication(root);
    setApplicationDocument(application, "旧文書", "C:\\old.md");
    const editorElement = root.querySelector<HTMLElement>(".cm-editor")!;
    const view = EditorView.findFromDOM(editorElement)!;
    const saveDocument = vi.spyOn(backend, "saveDocument");

    view.dispatch({ changes: { from: view.state.doc.length, insert: "更新" } });
    setApplicationDocument(application, "新文書", "C:\\new.md");
    await vi.advanceTimersByTimeAsync(1_000);

    expect(saveDocument).not.toHaveBeenCalled();
  });

  it("自動保存中の追加入力は最新リビジョンを再保存する", async () => {
    vi.useFakeTimers();
    const root = document.createElement("div");
    document.body.append(root);
    const application = new MarkdownQuickMemoApplication(root);
    const path = "C:\\memo.md";
    setApplicationDocument(application, "初期", path);
    const editorElement = root.querySelector<HTMLElement>(".cm-editor")!;
    const view = EditorView.findFromDOM(editorElement)!;
    let finishFirstSave: ((result: { path: string; revision: number }) => void) | undefined;
    const saveDocument = vi
      .spyOn(backend, "saveDocument")
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishFirstSave = resolve;
          }),
      )
      .mockResolvedValueOnce({ path, revision: 2 });

    view.dispatch({ changes: { from: view.state.doc.length, insert: "1" } });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(saveDocument).toHaveBeenCalledWith("初期1", 1, undefined);

    view.dispatch({ changes: { from: view.state.doc.length, insert: "2" } });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(saveDocument).toHaveBeenCalledOnce();

    finishFirstSave?.({ path, revision: 1 });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(saveDocument).toHaveBeenCalledTimes(2);
    expect(saveDocument).toHaveBeenLastCalledWith("初期12", 2, undefined);
  });

  it("自動保存失敗時は未保存状態を保ち、入力なしでは再試行しない", async () => {
    vi.useFakeTimers();
    const root = document.createElement("div");
    document.body.append(root);
    const application = new MarkdownQuickMemoApplication(root);
    const path = "C:\\memo.md";
    setApplicationDocument(application, "初期", path);
    const editorElement = root.querySelector<HTMLElement>(".cm-editor")!;
    const view = EditorView.findFromDOM(editorElement)!;
    const saveDocument = vi
      .spyOn(backend, "saveDocument")
      .mockRejectedValue(new Error("保存失敗"));

    view.dispatch({ changes: { from: view.state.doc.length, insert: "更新" } });
    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.resolve();

    expect(saveDocument).toHaveBeenCalledOnce();
    expect(dialogMocks.message).toHaveBeenCalledOnce();
    expect(root.querySelector("#document-title")?.textContent).toBe("● memo.md");

    await vi.advanceTimersByTimeAsync(5_000);
    expect(saveDocument).toHaveBeenCalledOnce();
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
