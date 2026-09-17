// @vitest-environment jsdom
import { undo } from "@codemirror/commands";
import type { EditorView } from "@codemirror/view";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownQuickMemoApplication } from "./app";
import { backend, type TabTransfer } from "./bridge/tauri";
import { serializeEditor, setPreviewOnly } from "./editor/editor";
import type { RevisionTracker } from "./editor/revision";

const styles = readFileSync("src/styles.css", "utf8");

const dialogs = vi.hoisted(() => ({ ask: vi.fn(), message: vi.fn(), open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => dialogs);

interface Tab {
  id: string; path: string | null; editor: EditorView; revision: RevisionTracker;
  timer: number | undefined; collapsed: Set<string>;
}
interface Harness {
  tabs: Tab[]; activeTab: Tab; initialized: boolean; transferring: Tab | null;
  createTab(): Tab;
  selectTab(tab: Tab, focus?: boolean): void;
  setDocument(content: string, path: string | null): void;
  saveDocument(saveAs: boolean, tab?: Tab): Promise<boolean>;
  closeTab(tab: Tab): Promise<void>;
  openRequestedPath(path: string, newTab: boolean): Promise<void>;
  receiveTab(transfer: TabTransfer): Promise<void>;
  finishTransfer(id: string, accepted: boolean): Promise<void>;
  checkExit(): Promise<void>;
  dragTab(tab: Tab): Promise<void>;
}
const applications: Harness[] = [];
function application() {
  const root = document.createElement("div");
  document.body.append(root);
  const app = new MarkdownQuickMemoApplication(root) as unknown as Harness;
  applications.push(app);
  return { app, root };
}
function key(target: HTMLElement, key: string, shiftKey = false, ctrlKey = true) {
  const event = new KeyboardEvent("keydown", { key, ctrlKey, shiftKey, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}
function edit(tab: Tab, text: string) {
  tab.editor.dispatch({ changes: { from: tab.editor.state.doc.length, insert: text }, userEvent: "input" });
}
if (!window.Range.prototype.getClientRects) Object.defineProperty(window.Range.prototype, "getClientRects", { configurable: true, value: () => [] });

afterEach(() => {
  for (const app of applications.splice(0)) for (const tab of app.tabs) {
    window.clearTimeout(tab.timer);
    tab.editor.destroy();
  }
  document.body.replaceChildren();
  window.localStorage.removeItem("markdown-quick-memo:tabs-pinned");
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("複数文書のタブ", () => {
  it("ピン付きの独立幅サイドバーを使い、格納時は改行せず右端を開いてフェードする", () => {
    const { app, root } = application();
    const first = app.activeTab;
    app.createTab();

    const firstRow = root.querySelector<HTMLElement>(
      `[data-tab-id="${first.id}"]`,
    )!;
    expect(firstRow.querySelector(":scope > .tab-select")).not.toBeNull();
    expect(firstRow.querySelector(":scope > .tab-close")).not.toBeNull();
    expect(styles).toContain(
      "padding-left: var(--tabs-width, 240px);",
    );
    expect(styles).toContain(
      "width: var(--tabs-width, 240px);",
    );
    expect(styles).toContain("background: var(--tabs-background);");
    expect(styles).toContain(
      "border-color: transparent; background: transparent; opacity: 0; pointer-events: none;",
    );
    expect(styles).toContain(
      ".tab-row:hover .tab-close,\n.tab-row:focus-within .tab-close { opacity: 1; pointer-events: auto; }",
    );
    expect(styles).toContain(
      ".tab-row:hover .tab-select,\n.tab-row:focus-within .tab-select { background: var(--surface-raised); }",
    );
    expect(root.querySelector("button[data-action='toggle-tabs-pin'] svg")).not.toBeNull();
    expect(styles).toContain("--tabs-compact-width: 60px;");
    expect(styles).toContain("margin: 0 0 12px; white-space: nowrap;");
    expect(styles).toContain("margin-bottom: 4px; white-space: nowrap;");
    expect(styles).toContain("-webkit-mask-image: linear-gradient(to right, #000 calc(100% - 12px), transparent);");
    expect(styles).toContain(
      ".tab-select[aria-selected=\"true\"] {\n  border-right-color: transparent; border-top-right-radius: 0; border-bottom-right-radius: 0;",
    );
    expect(styles).toContain(":is(.tab-close, .tabs-pin)");
  });

  it("ピン状態を切り替えて保存し、次の起動時にピンOFFを復元する", () => {
    const { root } = application();
    const workspace = root.querySelector<HTMLElement>("#workspace")!;
    const pin = root.querySelector<HTMLButtonElement>("button[data-action='toggle-tabs-pin']")!;

    expect(pin.getAttribute("aria-pressed")).toBe("true");
    expect(workspace.classList.contains("tabs-unpinned")).toBe(false);
    pin.click();
    expect(pin.getAttribute("aria-pressed")).toBe("false");
    expect(pin.getAttribute("aria-label")).toBe("タブ帯をピン止めする");
    expect(workspace.classList.contains("tabs-unpinned")).toBe(true);
    expect(window.localStorage.getItem("markdown-quick-memo:tabs-pinned")).toBe("false");

    const restored = application();
    expect(restored.root.querySelector("#workspace")?.classList.contains("tabs-unpinned")).toBe(true);
    expect(restored.root.querySelector("button[data-action='toggle-tabs-pin']")?.getAttribute("aria-pressed")).toBe("false");
  });

  it("狭幅では自動退避を優先し、幅を戻すと保存済みのピン状態へ戻る", () => {
    window.localStorage.setItem("markdown-quick-memo:tabs-pinned", "false");
    const { root } = application();
    const workspace = root.querySelector<HTMLElement>("#workspace")!;
    let workspaceWidth = 780;
    Object.defineProperty(workspace, "clientWidth", { configurable: true, get: () => workspaceWidth });

    window.dispatchEvent(new Event("resize"));
    expect(workspace.classList.contains("tabs-unpinned")).toBe(true);
    expect(workspace.classList.contains("tabs-auto-collapsed")).toBe(true);
    workspaceWidth = 900;
    window.dispatchEvent(new Event("resize"));
    expect(workspace.classList.contains("tabs-auto-collapsed")).toBe(false);
    expect(workspace.classList.contains("tabs-unpinned")).toBe(true);
  });

  it("Ctrl+Shift+Nで下に追加し、Ctrl+Kと上下キーで本文を切り替え、Enterで編集へ戻る", async () => {
    const { app, root } = application();
    edit(app.activeTab, "一つ目");
    const first = app.activeTab;
    key(first.editor.contentDOM, "N", true);
    await vi.waitFor(() => expect(app.tabs).toHaveLength(2));
    const second = app.activeTab;
    edit(second, "二つ目");
    key(second.editor.contentDOM, "k");
    expect(root.querySelector("#tabs")?.classList.contains("tabs-navigation-active")).toBe(true);
    key(document.activeElement as HTMLElement, "ArrowUp");
    expect(app.activeTab).toBe(first);
    expect(app.activeTab.editor.state.doc.toString()).toBe("一つ目");
    expect(document.activeElement?.getAttribute("role")).toBe("tab");
    key(document.activeElement as HTMLElement, "ArrowUp");
    expect(app.activeTab).toBe(first);
    key(document.activeElement as HTMLElement, "ArrowDown");
    expect(app.activeTab).toBe(second);
    key(document.activeElement as HTMLElement, "Enter", false, false);
    expect(app.activeTab.editor.hasFocus).toBe(true);
  });

  it("Ctrl+K中は右でタブ幅を拡大し左で縮小して目次幅を変更しない", () => {
    const { app, root } = application();
    const workspace = root.querySelector<HTMLElement>("#workspace")!;

    expect(workspace.style.getPropertyValue("--tabs-width")).toBe("240px");
    expect(workspace.style.getPropertyValue("--outline-width")).toBe("240px");
    key(app.activeTab.editor.contentDOM, "k");

    const expand = key(document.activeElement as HTMLElement, "ArrowRight");
    expect(expand.defaultPrevented).toBe(true);
    expect(workspace.style.getPropertyValue("--tabs-width")).toBe("280px");
    expect(workspace.style.getPropertyValue("--outline-width")).toBe("240px");

    key(document.activeElement as HTMLElement, "ArrowLeft");
    expect(workspace.style.getPropertyValue("--tabs-width")).toBe("240px");
    for (let count = 0; count < 10; count += 1) {
      key(document.activeElement as HTMLElement, "ArrowRight");
    }
    expect(workspace.style.getPropertyValue("--tabs-width")).toBe("480px");
    for (let count = 0; count < 10; count += 1) {
      key(document.activeElement as HTMLElement, "ArrowLeft");
    }
    expect(workspace.style.getPropertyValue("--tabs-width")).toBe("240px");
  });

  it("ピンOFFでもCtrl+Kの間だけタブ操作状態を開く", () => {
    window.localStorage.setItem("markdown-quick-memo:tabs-pinned", "false");
    const { app, root } = application();
    const tabs = root.querySelector("#tabs")!;
    key(app.activeTab.editor.contentDOM, "k");
    expect(tabs.classList.contains("tabs-navigation-active")).toBe(true);
    key(document.activeElement as HTMLElement, "Escape", false, false);
    expect(tabs.classList.contains("tabs-navigation-active")).toBe(false);
    expect(app.activeTab.editor.hasFocus).toBe(true);
  });

  it("長いファイル名を省略せずタブ本文とツールチップに保持する", () => {
    const { app, root } = application();
    const longName = "右端が徐々に薄くなるとても長いファイル名.md";
    app.setDocument("内容", `C:\\memo\\${longName}`);
    const button = root.querySelector<HTMLButtonElement>(".tab-select")!;
    expect(button.textContent).toBe(longName);
    expect(button.title).toBe(`C:\\memo\\${longName}`);
  });

  it("各タブの選択・取り消し履歴・閲覧モード・目次の折りたたみを保持する", () => {
    const { app, root } = application();
    const first = app.activeTab;
    edit(first, "# 最初\n## 子");
    app.selectTab(first);
    first.editor.dispatch({ selection: { anchor: 1, head: 2 } });
    const toggle = root.querySelector<HTMLButtonElement>("[data-outline-toggle-key]")!;
    const headingKey = toggle.dataset.outlineToggleKey!;
    toggle.click();
    setPreviewOnly(first.editor, true);
    const second = app.createTab();
    edit(second, "別文書");
    app.selectTab(first);
    expect(first.editor.state.selection.main.from).toBe(1);
    expect(first.editor.state.selection.main.to).toBe(2);
    expect(first.editor.state.readOnly).toBe(true);
    expect(first.collapsed.has(headingKey)).toBe(true);
    setPreviewOnly(first.editor, false);
    undo(first.editor);
    expect(first.editor.state.doc.toString()).toBe("");
    expect(second.editor.state.doc.toString()).toBe("別文書");
  });

  it("保存中に別タブへ移っても元の文書のパスと未保存状態だけを更新する", async () => {
    const { app } = application();
    app.setDocument("元", "C:\\first.md");
    const first = app.activeTab;
    edit(first, "更新");
    let finish!: (value: { path: string; revision: number }) => void;
    const save = vi.spyOn(backend, "saveDocument").mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const saving = app.saveDocument(false);
    const second = app.createTab();
    edit(second, "保存しない");
    finish({ path: "C:\\first.md", revision: 1 });
    expect(await saving).toBe(true);
    expect(save).toHaveBeenCalledWith("元更新", 1, "C:\\first.md", first.id);
    expect(first.revision.dirty).toBe(false);
    expect(second.path).toBeNull();
    expect(second.revision.dirty).toBe(true);
    expect(app.activeTab).toBe(second);
  });

  it("非表示タブも元の保存先へ自動保存する", async () => {
    vi.useFakeTimers();
    const { app } = application();
    app.setDocument("元", "C:\\first.md");
    const first = app.activeTab;
    edit(first, "更新");
    const second = app.createTab();
    const save = vi.spyOn(backend, "saveDocument").mockResolvedValue({ path: first.path!, revision: 1 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(save).toHaveBeenCalledWith("元更新", 1, first.path, first.id);
    expect(app.activeTab).toBe(second);
  });

  it("Ctrl+Dはタブを閉じ、最後のタブを閉じた後は空の新規文書になる", async () => {
    const { app } = application();
    app.createTab();
    const event = key(app.activeTab.editor.contentDOM, "d");
    expect(event.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(app.tabs).toHaveLength(1));
    app.setDocument("保存済み", "C:\\memo.md");
    key(app.activeTab.editor.contentDOM, "d");
    await vi.waitFor(() => expect(app.activeTab.path).toBeNull());
    expect(app.tabs).toHaveLength(1);
    expect(app.activeTab.editor.state.doc.toString()).toBe("");
  });

  it("未保存タブの閉じる確認をキャンセルすると本文を保持する", async () => {
    const { app } = application();
    edit(app.activeTab, "残す");
    dialogs.ask.mockResolvedValueOnce(false).mockResolvedValueOnce(false);
    await app.closeTab(app.activeTab);
    expect(app.activeTab.editor.state.doc.toString()).toBe("残す");
    expect(app.activeTab.revision.dirty).toBe(true);
  });

  it("既に開いているファイルは既存タブへ移動し、新しい文書を読み込まない", async () => {
    const { app } = application();
    app.initialized = true;
    edit(app.activeTab, "残す");
    vi.spyOn(backend, "focusExisting").mockResolvedValue(true);
    const open = vi.spyOn(backend, "openDocument");
    await app.openRequestedPath("C:\\existing.md", true);
    expect(open).not.toHaveBeenCalled();
    expect(dialogs.ask).not.toHaveBeenCalled();
    expect(app.tabs).toHaveLength(1);
  });

  it("全体終了で途中のタブをキャンセルすると終了を拒否し、全ての本文を残す", async () => {
    const { app } = application();
    edit(app.activeTab, "最初");
    edit(app.createTab(), "次");
    dialogs.ask.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false).mockResolvedValueOnce(false);
    const response = vi.spyOn(backend, "exitResponse").mockResolvedValue();
    await app.checkExit();
    expect(response).toHaveBeenCalledWith(false);
    expect(app.tabs.map((tab) => tab.editor.state.doc.toString())).toEqual(["最初", "次"]);
  });

  it("他ウィンドウで履歴を復元し、受領確認までは元タブを残す", async () => {
    const { app: source } = application();
    const original = source.activeTab;
    edit(original, "移動内容");
    original.editor.dispatch({ selection: { anchor: 2 } });
    source.createTab();
    source.transferring = original;
    const { app: target } = application();
    let acknowledge!: () => void;
    vi.spyOn(backend, "acceptTransfer").mockImplementation(() => new Promise((resolve) => { acknowledge = resolve; }));
    const transfer: TabTransfer = {
      id: "test-transfer", documentId: original.id, source: "main", target: "memo-1", index: 0,
      snapshot: { editor: serializeEditor(original.editor), path: null, revision: original.revision.snapshot(), collapsed: [], preview: false, scrollTop: 0, scrollLeft: 0 },
    };
    const receiving = target.receiveTab(transfer);
    expect(source.tabs).toContain(original);
    acknowledge();
    await receiving;
    await source.finishTransfer(original.id, true);
    expect(source.tabs).not.toContain(original);
    const restored = target.activeTab;
    expect(restored.editor.state.doc.toString()).toBe("移動内容");
    expect(restored.editor.state.selection.main.head).toBe(2);
    expect(restored.revision.dirty).toBe(true);
    undo(restored.editor);
    expect(restored.editor.state.doc.toString()).toBe("");
    await target.receiveTab(transfer);
    expect(target.tabs).toHaveLength(2);
  });

  it("移動先の復元失敗では元の文書を削除しない", async () => {
    const { app: source } = application();
    const original = source.activeTab;
    edit(original, "保持");
    source.transferring = original;
    const { app: target } = application();
    const accept = vi.spyOn(backend, "acceptTransfer").mockResolvedValue();
    await target.receiveTab({ id: "bad", documentId: original.id, source: "main", target: "memo-1", index: 0, snapshot: { editor: null } });
    expect(accept).toHaveBeenCalledWith("bad", false);
    await source.finishTransfer(original.id, false);
    expect(original.editor.state.doc.toString()).toBe("保持");
    expect(source.tabs).toContain(original);
  });

  it("最後のタブを枠外へドラッグしても新規ウィンドウを作らない", async () => {
    const { app } = application();
    vi.spyOn(backend, "dragTab").mockResolvedValue({ target: null, x: 10, y: 10, clientY: 0, outside: true, cancelled: false });
    const transfer = vi.spyOn(backend, "transferTab");
    await app.dragTab(app.activeTab);
    expect(transfer).not.toHaveBeenCalled();
    expect(app.tabs).toHaveLength(1);
  });

  it("Ctrl+Shift+Oで新しいタブへ開き、Ctrl+Eは保存先を開く", async () => {
    const { app } = application();
    edit(app.activeTab, "残す本文");
    const first = app.activeTab;
    dialogs.open.mockResolvedValue("C:\\opened.md");
    const open = vi.spyOn(backend, "openDocument").mockResolvedValue({ path: "C:\\opened.md", content: "読み込み" });
    key(first.editor.contentDOM, "O", true);
    await vi.waitFor(() => expect(app.activeTab.path).toBe("C:\\opened.md"));
    expect(app.tabs).toHaveLength(2);
    expect(first.editor.state.doc.toString()).toBe("残す本文");
    expect(open).toHaveBeenCalledWith("C:\\opened.md", app.activeTab.id);
    expect(dialogs.ask).not.toHaveBeenCalled();
    const reveal = vi.spyOn(backend, "revealDocument").mockResolvedValue();
    key(app.activeTab.editor.contentDOM, "e");
    expect(reveal).toHaveBeenCalledWith(app.activeTab.id);
    expect(app.tabs).toHaveLength(2);
  });

  it("タブ一覧内のドロップ位置へ並べ替え、内容を保持する", async () => {
    const { app, root } = application();
    const first = app.activeTab;
    edit(first, "先頭");
    const second = app.createTab();
    const third = app.createTab();
    root.querySelector("#tabs")!.getBoundingClientRect = () => ({ top: 50, bottom: 600 }) as ReturnType<HTMLElement["getBoundingClientRect"]>;
    vi.spyOn(backend, "dragTab").mockResolvedValue({ target: "main", x: 50, y: 500, clientY: 500, outside: false, cancelled: false });
    await app.dragTab(first);
    expect(app.tabs).toEqual([second, third, first]);
    expect(first.editor.state.doc.toString()).toBe("先頭");
  });

  it("最後のタブを他ウィンドウへ移した後は空の元ウィンドウだけを閉じる", async () => {
    const { app } = application();
    const tab = app.activeTab;
    app.transferring = tab;
    const close = vi.spyOn(backend, "closeEmptyWindow").mockResolvedValue();
    const exit = vi.spyOn(backend, "confirmExit");
    await app.finishTransfer(tab.id, true);
    expect(close).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled();
    expect(app.tabs).toHaveLength(0);
  });
});
