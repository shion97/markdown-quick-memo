// @vitest-environment jsdom
import { undo } from "@codemirror/commands";
import type { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownQuickMemoApplication } from "./app";
import { backend } from "./bridge/tauri";

const dialogs = vi.hoisted(() => ({ ask: vi.fn(), message: vi.fn(), save: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => dialogs);
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({}) }));
interface TestTab { id: string; editor: EditorView; timer: number | undefined }
interface Harness {
  activeTab: TestTab; tabs: TestTab[];
  setDocument(content: string, path: string | null): void;
  saveDocument(saveAs: boolean, tab?: TestTab): Promise<boolean>;
  createTab(): TestTab; selectTab(tab: TestTab): void;
}
const applications: Harness[] = [];
function setup(content = "", path: string | null = null) {
  const root = document.createElement("div");
  document.body.append(root);
  const app = new MarkdownQuickMemoApplication(root) as unknown as Harness;
  applications.push(app);
  app.setDocument(content, path);
  const button = (action: string) => root.querySelector<HTMLButtonElement>(`button[data-action='${action}']`)!;
  return { app, root, button, view: app.activeTab.editor };
}
function key(target: HTMLElement, value: string, ctrlKey = false) {
  target.dispatchEvent(new KeyboardEvent("keydown", { key: value, ctrlKey, bubbles: true, cancelable: true }));
}
if (!window.Range.prototype.getClientRects) Object.defineProperty(window.Range.prototype, "getClientRects", { value: () => [] });
afterEach(() => {
  for (const app of applications.splice(0)) for (const tab of app.tabs) {
    window.clearTimeout(tab.timer);
    tab.editor.destroy();
  }
  document.body.replaceChildren();
  vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks();
});

describe("UI/UX改善", () => {
  it("無題の初回保存と空文書の案内は原文・Undoへ混入しない", () => {
    const { root, view } = setup();
    expect(root.querySelector("#save-status")?.textContent).toContain("初回保存");
    expect(root.querySelector<HTMLElement>("#empty-hint")?.hidden).toBe(false);
    view.dispatch({ changes: { from: 0, insert: "メモ" }, userEvent: "input" });
    expect(root.querySelector<HTMLElement>("#empty-hint")?.hidden).toBe(true);
    expect(view.state.doc.toString()).toBe("メモ");
    undo(view);
    expect(view.state.doc.toString()).toBe("");
    expect(root.querySelector<HTMLElement>("#empty-hint")?.hidden).toBe(false);
  });

  it("古い保存完了で保存済みへ戻さず、最新の保存成功を表示する", async () => {
    const { app, root, view } = setup("初期", "C:\\memo.md");
    let complete!: (result: { path: string; revision: number }) => void;
    vi.spyOn(backend, "saveDocument").mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }))
      .mockResolvedValueOnce({ path: "C:\\memo.md", revision: 2 });
    view.dispatch({ changes: { from: 2, insert: "1" } });
    expect(root.querySelector("#save-status")?.textContent).toBe("未保存");
    const pending = app.saveDocument(false);
    expect(root.querySelector("#save-status")?.textContent).toBe("保存中");
    view.dispatch({ changes: { from: 3, insert: "2" } });
    complete({ path: "C:\\memo.md", revision: 1 });
    expect(await pending).toBe(false);
    expect(root.querySelector("#save-status")?.textContent).toBe("未保存");
    expect(await app.saveDocument(false)).toBe(true);
    expect(root.querySelector("#save-status")?.textContent).toBe("保存済み");
  });

  it("失敗原因と再試行は入力・文字数更新・タブ切替で失われない", async () => {
    const { app, root, view, button } = setup("初期", "C:\\memo.md");
    const save = vi.spyOn(backend, "saveDocument").mockRejectedValueOnce(new Error("ディスクがいっぱいです"))
      .mockResolvedValueOnce({ path: "C:\\memo.md", revision: 2 });
    view.dispatch({ changes: { from: 2, insert: "1" } });
    await app.saveDocument(false);
    expect(root.querySelector("#save-status")?.textContent).toBe("保存失敗");
    const notifiedError = root.querySelector("#save-error-message")!.firstChild;
    view.dispatch({ changes: { from: 3, insert: "2" } });
    view.dispatch({ selection: { anchor: 0 } });
    expect(root.querySelector("#save-error")?.textContent).toContain("ディスクがいっぱいです");
    expect(root.querySelector("#save-error-message")!.firstChild).toBe(notifiedError);
    const failed = app.activeTab;
    app.createTab();
    expect(root.querySelector<HTMLElement>("#save-error")?.hidden).toBe(true);
    app.selectTab(failed);
    expect(root.querySelector("#save-status")?.textContent).toBe("保存失敗");
    button("retry-save").click();
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(root.querySelector("#save-status")?.textContent).toBe("保存済み"));
    expect(root.querySelector<HTMLElement>("#save-error")?.hidden).toBe(true);
  });

  it("別タブの保存完了が現在の文書の保存表示を変えない", async () => {
    const { app, root } = setup("本文", "C:\\memo.md");
    let complete!: (result: { path: string; revision: number }) => void;
    vi.spyOn(backend, "saveDocument").mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const saving = app.saveDocument(false);
    app.createTab();
    complete({ path: "C:\\memo.md", revision: 0 });
    await saving;
    expect(root.querySelector("#save-status")?.textContent).toContain("初回保存");
  });

  it.each(["tabs", "outline"])("%sをクリックで開閉でき、閉じると本文へ戻る", (panel) => {
    const { root, button, view } = setup("# 見出し\n本文");
    const toggle = button(`toggle-${panel}`);
    expect(toggle).not.toBeNull();
    if (toggle.getAttribute("aria-expanded") === "true") toggle.click();
    toggle.click();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(root.querySelector(`#${panel}`)?.hasAttribute("inert")).toBe(false);
    root.querySelector<HTMLButtonElement>(`#${panel} button`)!.focus();
    toggle.click();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(root.querySelector(`#${panel}`)?.hasAttribute("inert")).toBe(true);
    expect(view.hasFocus).toBe(true);
    key(view.contentDOM, panel === "tabs" ? "k" : "l", true);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });

  it("メニューは実行と説明を分け、矢印操作とEscapeのフォーカス復帰に対応する", () => {
    const { root, button } = setup("本文");
    button("more").click();
    const first = root.querySelector<HTMLButtonElement>("#command-menu button")!;
    expect(document.activeElement).toBe(first);
    key(first, "ArrowDown");
    expect(document.activeElement).not.toBe(first);
    button("shortcuts").click();
    expect(root.querySelector<HTMLElement>("#command-menu")?.hidden).toBe(true);
    expect(root.querySelector<HTMLElement>("#shortcut-list")?.hidden).toBe(false);
    expect(root.querySelector("#shortcut-list .shortcut-row button")).toBeNull();
    key(document.activeElement as HTMLElement, "Escape");
    expect(root.querySelector<HTMLElement>("#more-menu")?.hidden).toBe(true);
    expect(document.activeElement).toBe(button("more"));
  });

  it("メニューの編集操作もUndoでき、閲覧モードを文字で伝える", async () => {
    const { root, view, button } = setup("本文");
    view.dispatch({ selection: { anchor: 0, head: 2 } });
    button("more").click(); button("bold").click();
    expect(view.state.doc.toString()).toBe("**本文**");
    button("more").click(); button("undo").click();
    expect(view.state.doc.toString()).toBe("本文");
    button("preview").click();
    expect(button("preview").textContent).toContain("閲覧");
    button("more").click();
    expect(button("bold").disabled).toBe(true);
    expect(root.querySelector("#navigation-status")?.textContent).toBe("");
    await Promise.resolve();
  });
});
