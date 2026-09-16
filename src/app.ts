import type { EditorView } from "@codemirror/view";
import { ask, message, open, save } from "@tauri-apps/plugin-dialog";
import {
  backend,
  configureBackendEvents,
  invokeWithBackendPayload,
  onBackendEvent,
  onBackendPayload,
  type DocumentPayload,
  type HotkeyStatus,
  type PdfExportCompleted,
  type TabTransfer,
} from "./bridge/tauri";
import {
  createEditor,
  documentCounts,
  replaceDocument,
  setPreviewOnly,
  serializeEditor,
  restoreEditor,
} from "./editor/editor";
import {
  buildOutlineTree,
  navigateToHeading,
  requestCompleteOutline,
  renderOutlineLabel,
  type OutlineHeading,
  type OutlineNode,
} from "./editor/outline";
import { RevisionTracker } from "./editor/revision";

const DEFAULT_TITLE = "Markdown Quick Memo";
const OUTLINE_MIN_WIDTH = 240;
const OUTLINE_MAX_WIDTH = 480;
const OUTLINE_WIDTH_STEP = 40;
const AUTO_SAVE_DELAY_MS = 1_000;
const MIN_EDITOR_WIDTH = 560;

function fileName(path: string | null): string {
  if (!path) {
    return "無題.md";
  }
  return path.split(/[\\/]/).pop() || path;
}

function markdownTargetAt(content: string, position: number): {
  image: boolean;
  target: string;
} | null {
  const pattern = /(!)?\[[^\]]*]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
  for (const match of content.matchAll(pattern)) {
    const start = match.index;
    const end = start + match[0].length;
    if (position >= start && position <= end) {
      return {
        image: match[1] === "!",
        target: match[2] ?? "",
      };
    }
  }
  return null;
}

interface DocumentTab {
  id: string;
  host: HTMLElement;
  editor: EditorView;
  path: string | null;
  revision: RevisionTracker;
  timer: number | undefined;
  saving: Promise<boolean> | null;
  collapsed: Set<string>;
  scrollTop: number;
  scrollLeft: number;
}
interface TabSnapshot {
  editor: unknown;
  path: string | null;
  revision: [number, number];
  collapsed: string[];
  preview: boolean;
  scrollTop: number;
  scrollLeft: number;
  dropY?: number;
}

export class MarkdownQuickMemoApplication {
  private tabs: DocumentTab[] = [];
  private activeTab!: DocumentTab;
  private initialized = false;
  private windowLabel = "main";
  private tabsNavigationActive = false;
  private operationPending = false;
  private exitLocked = false;
  private transferring: DocumentTab | null = null;
  private receiving = new Set<string>();
  private transferSubmitted = false;
  private transferPoll: number | undefined;
  private get revision(): RevisionTracker { return this.activeTab.revision; }
  private get editor(): EditorView { return this.activeTab.editor; }
  private get currentPath(): string | null { return this.activeTab.path; }
  private set currentPath(path: string | null) { this.activeTab.path = path; }
  private get collapsedOutlineKeys(): Set<string> { return this.activeTab.collapsed; }
  private readonly editorHost: HTMLElement;
  private readonly workspace: HTMLElement;
  private readonly title: HTMLElement;
  private readonly status: HTMLElement;
  private readonly cursorPosition: HTMLElement;
  private readonly outline: HTMLElement;
  private readonly outlineList: HTMLElement;
  private readonly imageDialog: HTMLDialogElement;
  private readonly imageElement: HTMLImageElement;
  private readonly settingsDialog: HTMLDialogElement;
  private readonly hotkeyInput: HTMLInputElement;
  private readonly hotkeyStatus: HTMLElement;
  private suppressChanges = false;
  private translucent = false;
  private outlineWidth = OUTLINE_MIN_WIDTH;
  private outlineNavigationActive = false;
  private selectedOutlineKey: string | null = null;
  private outlineNavigationHold: { key: string; startedAt: number } | null = null;

  constructor(private readonly root: HTMLElement) {
    this.root.innerHTML = this.layout();
    this.editorHost = this.required("#editor");
    this.workspace = this.required("#workspace");
    this.title = this.required("#document-title");
    this.status = this.required("#status");
    this.cursorPosition = this.required("#cursor-position");
    this.outline = this.required("#outline");
    this.outlineList = this.required("#outline-list");
    this.imageDialog = this.requiredDialog("#image-dialog");
    this.imageElement = this.requiredImage("#preview-image");
    this.settingsDialog = this.requiredDialog("#settings-dialog");
    this.hotkeyInput = this.requiredInput("#hotkey-input");
    this.hotkeyStatus = this.required("#hotkey-status");
    this.createTab();
    this.bindActions();
    this.updateOutlineWidth(0);
  }

  private createTab(id: string = window.crypto.randomUUID()): DocumentTab {
    const host = document.createElement("div");
    host.className = "tab-editor";
    this.editorHost.append(host);
    const tab: DocumentTab = {
      id, host, editor: undefined as unknown as EditorView, path: null,
      revision: new RevisionTracker(), timer: undefined, saving: null, collapsed: new Set(), scrollTop: 0, scrollLeft: 0,
    };
    tab.editor = createEditor(host, {
      onDocumentChanged: () => {
        if (!this.suppressChanges && this.tabs.includes(tab)) {
          tab.revision.changed();
          this.updateTitle();
          this.scheduleAutoSave(tab);
        }
      },
      onCountsChanged: (characters, words) => {
        if (tab === this.activeTab) this.status.textContent = `${characters.toLocaleString()} 文字 / ${words.toLocaleString()} 語`;
      },
      onOutlineChanged: (headings) => { if (tab === this.activeTab) this.renderOutline(headings); },
      onCursorChanged: (line, column) => {
        if (tab === this.activeTab) this.cursorPosition.textContent = `${line}行 ${column}列`;
      },
      onControlClick: (position) => { if (tab === this.activeTab) void this.handleControlClick(position); },
      onCopyText: (text) => { void this.copyText(text); },
    });
    this.tabs.push(tab);
    this.selectTab(tab);
    return tab;
  }

  private selectTab(tab: DocumentTab, focusEditor = true): void {
    const previous = this.activeTab;
    if (previous && previous !== tab) {
      previous.scrollTop = previous.editor.scrollDOM.scrollTop;
      previous.scrollLeft = previous.editor.scrollDOM.scrollLeft;
    }
    this.activeTab = tab;
    for (const candidate of this.tabs) candidate.host.hidden = candidate !== tab;
    this.selectedOutlineKey = null;
    this.updateTitle();
    this.updateDocumentSummary(tab.editor.state.doc.toString());
    this.updatePreviewButton();
    if (previous !== tab) tab.editor.requestMeasure({ read: () => null, write: () => {
      if (this.activeTab !== tab) return;
      tab.editor.scrollDOM.scrollTop = tab.scrollTop;
      tab.editor.scrollDOM.scrollLeft = tab.scrollLeft;
    } });
    else tab.editor.requestMeasure();
    if (focusEditor) {
      this.stopTabNavigation();
      tab.editor.focus();
    } else this.focusTabButton();
  }

  private renderTabs(): void {
    const list = this.required("#tab-list");
    const focused = list.contains(document.activeElement);
    list.replaceChildren(...this.tabs.map((tab) => {
      const row = document.createElement("div");
      row.className = "tab-row";
      row.dataset.tabId = tab.id;
      const button = document.createElement("button");
      button.className = "tab-select";
      button.type = "button";
      button.setAttribute("role", "tab");
      button.setAttribute("aria-selected", String(tab === this.activeTab));
      button.tabIndex = tab === this.activeTab ? 0 : -1;
      button.title = tab.path ?? "無題.md";
      button.textContent = `${tab.revision.dirty ? "● " : ""}${fileName(tab.path)}`;
      const close = document.createElement("button");
      close.type = "button";
      close.className = "tab-close";
      close.textContent = "×";
      close.setAttribute("aria-label", `${fileName(tab.path)}のタブを閉じる`);
      row.append(button, close);
      return row;
    }));
    if (focused && this.tabsNavigationActive) this.focusTabButton();
  }

  private focusTabButton(): void {
    const button = this.required<HTMLButtonElement>(".tab-select[aria-selected='true']");
    button.focus();
    button.scrollIntoView?.({ block: "nearest" });
  }

  private stopTabNavigation(): void {
    this.tabsNavigationActive = false;
    this.required("#tabs").classList.remove("tabs-navigation-active");
  }

  private handleTabShortcut(event: KeyboardEvent): boolean {
    if (event.isComposing || event.altKey || event.metaKey || this.operationPending || this.exitLocked ||
        (event.target instanceof HTMLElement && event.target.closest("dialog, input, textarea, select"))) return false;
    const key = event.key.toLowerCase();
    let action: (() => void) | undefined;
    if (event.ctrlKey && !event.shiftKey && key === "k") {
      action = () => {
        if (event.repeat) return;
        if (this.tabsNavigationActive) { this.stopTabNavigation(); this.editor.focus(); }
        else {
          if (this.outlineNavigationActive) this.stopOutlineNavigation();
          this.tabsNavigationActive = true;
          this.required("#tabs").classList.add("tabs-navigation-active");
          this.focusTabButton();
        }
      };
    } else if (event.ctrlKey && !event.shiftKey && key === "d") {
      action = () => { if (!event.repeat) void this.performOperation(() => this.closeTab(this.activeTab)); };
    } else if (event.ctrlKey && event.shiftKey && (key === "n" || key === "o")) {
      action = () => { if (!event.repeat) void this.performOperation(() => key === "n" ? this.newTab() : this.openDocument(true)); };
    } else if (this.tabsNavigationActive && event.ctrlKey && !event.shiftKey && (key === "arrowup" || key === "arrowdown")) {
      action = () => {
        const index = this.tabs.indexOf(this.activeTab);
        const next = Math.max(0, Math.min(this.tabs.length - 1, index + (key === "arrowdown" ? 1 : -1)));
        this.selectTab(this.tabs[next]!, false);
      };
    } else if (this.tabsNavigationActive && !event.ctrlKey && (key === "enter" || key === "escape")) {
      action = () => { this.stopTabNavigation(); this.editor.focus(); };
    }
    if (!action) return false;
    event.preventDefault();
    event.stopPropagation();
    action();
    return true;
  }

  private async performOperation(action: () => Promise<void>): Promise<void> {
    if (this.operationPending || this.exitLocked) return;
    this.operationPending = true;
    this.root.inert = true;
    try { await action(); }
    catch (error) { await this.showError("操作を完了できませんでした", error); }
    finally {
      this.operationPending = false;
      this.root.inert = this.exitLocked;
      for (const tab of this.tabs) this.scheduleAutoSave(tab);
      if (!this.exitLocked && this.tabs.length) this.editor.focus();
    }
  }

  private async newTab(): Promise<void> {
    const tab = this.createTab();
    try { if (this.initialized) await backend.registerDocument(tab.id); }
    catch (error) { this.removeTab(tab); throw error; }
    this.editor.focus();
  }

  private async closeTab(tab: DocumentTab): Promise<void> {
    const previous = this.activeTab;
    this.selectTab(tab);
    if (!(await this.confirmDiscardOrSave())) { this.selectTab(previous); return; }
    if (this.tabs.length === 1) {
      if (this.initialized) await backend.clearDocument(tab.id);
      this.setDocument("", null);
      setPreviewOnly(this.editor, false);
      this.updatePreviewButton();
    } else {
      if (this.initialized) await backend.releaseDocument(tab.id);
      this.removeTab(tab);
      if (previous !== tab && this.tabs.includes(previous)) this.selectTab(previous);
    }
  }

  private removeTab(tab: DocumentTab): void {
    this.cancelAutoSave(tab);
    const index = this.tabs.indexOf(tab);
    if (index < 0) return;
    this.tabs.splice(index, 1);
    tab.editor.destroy();
    tab.host.remove();
    const next = this.tabs[Math.min(index, this.tabs.length - 1)];
    if (next) this.selectTab(this.activeTab === tab ? next : this.activeTab);
  }

  private tabIndexAt(clientY: number): number {
    const rows = Array.from(this.required("#tab-list").children);
    const index = rows.findIndex((row) => {
      const rect = row.getBoundingClientRect();
      return clientY < rect.top + rect.height / 2;
    });
    return index < 0 ? rows.length : index;
  }

  private async dragTab(tab: DocumentTab): Promise<void> {
    this.selectTab(tab);
    this.operationPending = true;
    this.root.inert = true;
    this.transferring = tab;
    this.cancelAutoSave(tab);
    let submitted = false;
    try {
      // Start tracking before waiting for a pending save, so a release is never missed.
      const drag = backend.dragTab();
      const result = await drag;
      if (tab.saving) await tab.saving;
      if (result.cancelled) return;
      if (result.target === this.windowLabel) {
        const panel = this.required("#tabs").getBoundingClientRect();
        if (result.clientY < panel.top || result.clientY > panel.bottom) return;
        const from = this.tabs.indexOf(tab);
        let to = this.tabIndexAt(result.clientY);
        this.tabs.splice(from, 1);
        if (to > from) to -= 1;
        this.tabs.splice(to, 0, tab);
        this.renderTabs();
        return;
      }
      if (!result.target && (!result.outside || this.tabs.length === 1)) return;
      const snapshot: TabSnapshot = {
        editor: serializeEditor(tab.editor), path: tab.path, revision: tab.revision.snapshot(),
        collapsed: [...tab.collapsed], preview: tab.editor.state.readOnly,
        scrollTop: tab.editor.scrollDOM.scrollTop, scrollLeft: tab.editor.scrollDOM.scrollLeft,
        dropY: result.target ? result.clientY : undefined,
      };
      await backend.transferTab(tab.id, snapshot, result.target, result.x, result.y, 0);
      submitted = true;
      this.transferSubmitted = true;
      if (this.transferring === tab) {
        this.status.textContent = "タブを移動しています（Escで取り消し）";
        this.pollTransfer(tab);
      }

    } catch (error) { await this.showError("タブを移動できませんでした", error); }
    finally {
      if (!submitted) {
        this.transferring = null;
        this.operationPending = false;
        this.root.inert = this.exitLocked;
        this.scheduleAutoSave(tab);
      }
    }
  }

  private async receiveTab(transfer: TabTransfer, initial = false): Promise<void> {
    if (this.receiving.has(transfer.id)) return;
    this.receiving.add(transfer.id);
    if (this.operationPending || this.exitLocked) {
      await backend.acceptTransfer(transfer.id, false);
      return;
    }
    this.operationPending = true;
    this.root.inert = true;
    let restored: DocumentTab | undefined;
    try {
      const snapshot = transfer.snapshot as TabSnapshot;
      if (snapshot.dropY !== undefined) {
        const panel = this.required("#tabs").getBoundingClientRect();
        if (snapshot.dropY < panel.top || snapshot.dropY > panel.bottom) throw new Error("タブ一覧の上にドロップしてください。");
      }
      const insertion = snapshot.dropY === undefined ? this.tabs.length : this.tabIndexAt(snapshot.dropY);
      const placeholder = initial ? this.activeTab : undefined;
      restored = this.createTab(transfer.documentId);
      restoreEditor(restored.editor, snapshot.editor, snapshot.preview);
      restored.path = snapshot.path;
      restored.revision.restore(snapshot.revision);
      restored.collapsed = new Set(snapshot.collapsed);
      restored.scrollTop = snapshot.scrollTop;
      restored.scrollLeft = snapshot.scrollLeft;
      this.tabs.splice(this.tabs.indexOf(restored), 1);
      this.tabs.splice(insertion, 0, restored);
      this.selectTab(restored);
      await backend.acceptTransfer(transfer.id, true);
      if (placeholder) this.removeTab(placeholder);
      const editor = restored.editor;
      editor.requestMeasure({ read: () => null, write: () => {
        editor.scrollDOM.scrollTop = snapshot.scrollTop;
        editor.scrollDOM.scrollLeft = snapshot.scrollLeft;
      } });
      this.scheduleAutoSave(restored);
    } catch (error) {
      if (restored) this.removeTab(restored);
      await backend.acceptTransfer(transfer.id, false);
      await this.showError("タブを受け取れませんでした", error);
    } finally {
      this.operationPending = false;
      this.root.inert = this.exitLocked;
      if (this.tabs.length) this.editor.focus();
    }
  }

  private pollTransfer(tab: DocumentTab): void {
    // IPC events are the normal completion path; polling also recovers a missed event.
    this.transferPoll = window.setTimeout(() => {
      void backend.transferStatus(tab.id).then((status) => {
        if (this.transferring !== tab) return;
        if (status === "pending") this.pollTransfer(tab);
        else void this.finishTransfer(tab.id, status === "accepted");
      }).catch((error: unknown) => { void this.showError("タブの移動状態を確認できませんでした。Escで取り消せます", error); });
    }, AUTO_SAVE_DELAY_MS);
  }

  private async finishTransfer(documentId: string, accepted: boolean): Promise<void> {
    const tab = this.tabs.find((candidate) => candidate.id === documentId);
    if (!tab || tab !== this.transferring) return;
    this.transferring = null;
    this.transferSubmitted = false;
    window.clearTimeout(this.transferPoll);
    this.operationPending = false;
    this.root.inert = this.exitLocked;
    if (accepted) {
      this.removeTab(tab);
      if (this.tabs.length === 0) await backend.closeEmptyWindow();
    } else { this.updateDocumentSummary(this.editor.state.doc.toString()); this.scheduleAutoSave(tab); }
  }

  async initialize(): Promise<void> {
    const bootstrap = await backend.bootstrap();
    this.windowLabel = bootstrap.windowLabel;
    configureBackendEvents(this.windowLabel);
    const incoming = await backend.pendingTransfer();
    if (!incoming) {
      await backend.registerDocument(this.activeTab.id);
      if (bootstrap.document) {
        this.loadPayload(await backend.openDocument(bootstrap.document.path, this.activeTab.id));
      } else {
        this.setDocument("", null);
      }
    }
    this.renderHotkeyStatus(bootstrap.hotkey);
    await Promise.all([
      onBackendPayload<string>("select-document", (id) => {
        const tab = this.tabs.find((candidate) => candidate.id === id);
        if (tab && !this.operationPending && !this.exitLocked) this.selectTab(tab);
      }),
      onBackendPayload<boolean>("exit-lock", (locked) => {
        this.exitLocked = locked;
        this.root.inert = locked;
        for (const tab of this.tabs) {
          if (locked) this.cancelAutoSave(tab); else this.scheduleAutoSave(tab);
        }
        if (!locked && this.tabs.length) this.editor.focus();
      }),
      onBackendEvent("check-exit", () => this.checkExit()),
      onBackendPayload<TabTransfer>("receive-tab", (transfer) => { void this.receiveTab(transfer); }),
      onBackendPayload<{documentId: string; accepted: boolean}>("transfer-completed", (result) => {
        void this.finishTransfer(result.documentId, result.accepted);
      }),
      onBackendPayload<number | null>("tab-drag-hover", (position) => {
        this.required("#tabs").classList.toggle("tabs-drag-over", position !== null);
      }),
      onBackendEvent("focus-editor", () => this.editor.focus()),
      onBackendEvent("close-requested", () => this.exitWithConfirmation()),
      onBackendEvent("hotkey-triggered", async () => {
        if (this.settingsDialog.open) {
          this.renderHotkeyStatus(await backend.hotkeyStatus());
          this.hotkeyStatus.textContent += " / 押下確認済み";
        }
      }),
      onBackendPayload<string>("open-file-requested", (path) => {
        void this.performOperation(() => this.openRequestedPath(path, true));
      }),
    ]);
    this.initialized = true;
    await backend.frontendReady();
    if (incoming) await this.receiveTab(incoming, true);
    this.editor.focus();
  }

  private layout(): string {
    return `
      <main class="application-shell">
        <header class="toolbar">
          <div class="brand">
            <span class="brand-mark" aria-hidden="true">M</span>
            <strong id="document-title">無題.md</strong>
          </div>
          <div class="toolbar-actions">
            <div class="document-status" aria-label="文書情報">
              <span id="cursor-position">1行 1列</span>
              <span aria-hidden="true">/</span>
              <span id="status">0 文字 / 0 語</span>
            </div>
            <button data-action="preview" class="mode-toggle" aria-pressed="false">閲覧モード</button>
            <button data-action="more" class="icon-button" aria-label="ショートカット一覧" aria-expanded="false">•••</button>
          </div>
          <div id="more-menu" class="popover" hidden>
            <section class="popover-group" aria-labelledby="shortcut-file-heading">
              <h2 id="shortcut-file-heading">ファイル</h2>
              <button data-action="new"><span>新規</span><kbd>Ctrl+N</kbd></button>
              <button data-action="open"><span>開く</span><kbd>Ctrl+O</kbd></button>
              <button data-action="new-tab"><span>新しいタブで新規</span><kbd>Ctrl+Shift+N</kbd></button>
              <button data-action="open-tab"><span>新しいタブで開く</span><kbd>Ctrl+Shift+O</kbd></button>
              <button data-action="close-tab"><span>タブを閉じる</span><kbd>Ctrl+D</kbd></button>
              <button data-action="save"><span>保存</span><kbd>Ctrl+S</kbd></button>
              <button data-action="save-as"><span>名前を付けて保存</span><kbd>Ctrl+Shift+S</kbd></button>
              <button data-action="rename"><span>ファイル名を変更</span><kbd>Ctrl+R</kbd></button>
              <button data-action="reveal"><span>保存先を開く</span><kbd>Ctrl+E</kbd></button>
              <button data-action="export-pdf"><span>PDFへ書き出す</span><kbd>Ctrl+P</kbd></button>
            </section>
            <section class="popover-group" aria-labelledby="shortcut-edit-heading">
              <h2 id="shortcut-edit-heading">編集</h2>
              <div class="shortcut-row"><span>元に戻す / やり直す</span><kbd>Ctrl+Z / Ctrl+Y</kbd></div>
              <div class="shortcut-row"><span>検索</span><kbd>Ctrl+F</kbd></div>
              <div class="shortcut-row"><span>表を挿入</span><kbd>Ctrl+T</kbd></div>
              <div class="shortcut-row"><span>太字 / 斜体</span><kbd>Ctrl+B / Ctrl+I</kbd></div>
              <div class="shortcut-row"><span>取り消し線</span><kbd>Ctrl+X</kbd></div>
              <div class="shortcut-row"><span>字下げ / 字上げ</span><kbd>Tab / Shift+Tab</kbd></div>
              <div class="shortcut-row"><span>単純改行</span><kbd>Shift+Enter</kbd></div>
              <div class="shortcut-row"><span>リンク・画像を開く</span><kbd>Ctrl+クリック</kbd></div>
            </section>
            <section class="popover-group" aria-labelledby="shortcut-window-heading">
              <h2 id="shortcut-window-heading">表示・終了</h2>
              <div class="shortcut-row"><span>アプリを表示</span><kbd id="app-hotkey-shortcut">Ctrl+Alt+M</kbd></div>
              <button data-action="preview"><span>閲覧 / 編集モード</span><kbd>Ctrl+M</kbd></button>
              <div class="shortcut-row"><span>タブを操作 / 編集へ戻る</span><kbd>Ctrl+K</kbd></div>
              <div class="shortcut-row"><span>タブを移動</span><kbd>Ctrl+↑ / Ctrl+↓</kbd></div>
              <div class="shortcut-row"><span>目次を操作 / 編集へ戻る</span><kbd>Ctrl+L</kbd></div>
              <button data-action="opacity"><span>半透明表示</span><kbd>Ctrl+H</kbd></button>
              <button data-action="hide"><span>待機状態へ戻す</span><kbd>Ctrl+Q</kbd></button>
              <button data-action="exit"><span>完全に終了</span><kbd>Alt+F4</kbd></button>
            </section>
            <button data-action="settings" class="popover-settings"><span>ホットキー設定</span></button>
          </div>
        </header>
        <section id="workspace" class="workspace">
          <aside id="tabs" class="tabs-panel" aria-label="タブ">
            <h2>タブ</h2>
            <div id="tab-list" role="tablist" aria-orientation="vertical"></div>
            <button data-action="new-tab" class="new-tab" aria-label="新しいタブで新規">+</button>
          </aside>
          <section id="editor" class="editor-host" aria-label="Markdown編集欄"></section>
          <aside id="outline" class="outline-panel" aria-label="目次" hidden>
            <header class="outline-header">
              <h2>目次</h2>
              <div class="outline-width-actions">
                <button type="button" data-action="outline-expand" aria-label="目次を広げる">&lt;</button>
                <button type="button" data-action="outline-shrink" aria-label="目次を狭める">&gt;</button>
              </div>
            </header>
            <nav id="outline-list" class="outline-list" aria-label="文書の見出し"></nav>
          </aside>
        </section>
      </main>
      <article id="print-root" class="print-root" aria-hidden="true"></article>
      <dialog id="image-dialog" class="image-dialog">
        <button class="dialog-close" data-action="close-image" aria-label="閉じる">×</button>
        <img id="preview-image" alt="Markdown画像プレビュー" />
      </dialog>
      <dialog id="settings-dialog" class="settings-dialog">
        <form method="dialog">
          <h2>グローバルホットキー</h2>
          <p>例: <code>Ctrl+Alt+M</code>。設定後、実際にキーを押して動作を確認してください。</p>
          <label>
            ホットキー
            <input id="hotkey-input" autocomplete="off" />
          </label>
          <p id="hotkey-status" class="diagnostic"></p>
          <div class="dialog-actions">
            <button value="cancel">キャンセル</button>
            <button type="button" class="primary" data-action="apply-hotkey">設定</button>
          </div>
        </form>
      </dialog>
    `;
  }

  private bindActions(): void {
    this.root.addEventListener(
      "keydown",
      (event) => {
        if (this.handleTabShortcut(event)) return;
        this.handleOutlineNavigationShortcut(event);
        this.handleOutlineWidthShortcut(event);
        if (!event.defaultPrevented && !this.operationPending && !this.exitLocked) {
          void this.handleShortcut(event);
          if (event.defaultPrevented) event.stopPropagation();
        }
      },
      { capture: true },
    );
    this.required("#tab-list").addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || (event.target as HTMLElement).closest(".tab-close")) return;
      const row = (event.target as HTMLElement).closest<HTMLElement>("[data-tab-id]");
      const tab = this.tabs.find((candidate) => candidate.id === row?.dataset.tabId);
      if (tab && this.initialized && !this.operationPending && !this.exitLocked) void this.dragTab(tab);
    });
    this.root.addEventListener("keyup", (event) => {
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        this.resetOutlineNavigationHold();
      }
    });
    window.addEventListener("blur", () => this.resetOutlineNavigationHold());
    window.addEventListener("resize", () => { if (this.root.isConnected) this.updateTabPanel(); });
    this.root.addEventListener("click", (event) => {
      const target = event.target as HTMLElement;
      const tabRow = target.closest<HTMLElement>("[data-tab-id]");
      if (tabRow) {
        const tab = this.tabs.find((candidate) => candidate.id === tabRow.dataset.tabId);
        if (tab && !this.operationPending && !this.exitLocked) {
          if (target.closest(".tab-close")) void this.performOperation(() => this.closeTab(tab));
          else this.selectTab(tab);
        }
        return;
      }
      const outlineToggle = (
        event.target as HTMLElement
      ).closest<HTMLButtonElement>("button[data-outline-toggle-key]");
      if (outlineToggle) {
        this.toggleOutlineBranch(outlineToggle);
        return;
      }
      const heading = (event.target as HTMLElement).closest<HTMLButtonElement>(
        "button[data-heading-position]",
      );
      if (heading) {
        if (this.outlineNavigationActive) {
          this.selectOutlineButton(heading, false);
        }
        navigateToHeading(
          this.editor,
          Number(heading.dataset.headingPosition),
        );
        return;
      }
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>(
        "button[data-action]",
      );
      if (!button) {
        return;
      }
      void this.runAction(button.dataset.action ?? "");
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && this.transferring && this.transferSubmitted) {
        event.preventDefault();
        void backend.cancelTransfer(this.transferring.id);
        return;
      }
      if (this.root.isConnected && !event.defaultPrevented && !this.operationPending && !this.exitLocked) void this.handleShortcut(event);
    });
    document.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      const menu = this.required("#more-menu");
      const trigger = this.required<HTMLButtonElement>(
        "button[data-action='more']",
      );
      if (
        menu.hidden ||
        menu.contains(target) ||
        trigger.contains(target)
      ) {
        return;
      }
      this.hideMoreMenu();
    });
  }

  private async runAction(action: string): Promise<void> {
    if (this.operationPending || this.exitLocked) return;
    const actions: Record<string, () => void | Promise<void>> = {
      new: () => this.performOperation(() => this.newDocument()),
      open: () => this.performOperation(() => this.openDocument()),
      "new-tab": () => this.performOperation(() => this.newTab()),
      "open-tab": () => this.performOperation(() => this.openDocument(true)),
      "close-tab": () => this.performOperation(() => this.closeTab(this.activeTab)),
      save: async () => {
        await this.saveDocument(false);
      },
      "save-as": async () => {
        await this.saveDocument(true);
      },
      rename: () => this.performOperation(() => this.renameDocument()),
      reveal: () => this.revealDocument(),
      "export-pdf": () => this.performOperation(() => this.exportPdf()),
      preview: () => this.togglePreviewOnly(),
      opacity: () => this.toggleOpacity(),
      settings: () => this.showSettings(),
      "apply-hotkey": () => this.applyHotkey(),
      hide: () => backend.hideWindow(),
      exit: () => this.exitWithConfirmation(),
      more: () => this.toggleMoreMenu(),
      "outline-expand": () => this.updateOutlineWidth(OUTLINE_WIDTH_STEP),
      "outline-shrink": () => this.updateOutlineWidth(-OUTLINE_WIDTH_STEP),
      "close-image": () => this.imageDialog.close(),
    };
    await actions[action]?.();
    if (action !== "more") {
      this.hideMoreMenu();
    }
  }

  private async handleShortcut(event: KeyboardEvent): Promise<void> {
    if (!event.ctrlKey || event.altKey || event.metaKey || event.isComposing || (event.target instanceof HTMLElement && event.target.closest("dialog, input, textarea, select"))) {
      return;
    }
    const key = event.key.toLowerCase();
    if (key === "l" && !event.shiftKey) {
      event.preventDefault();
      if (!event.repeat) {
        this.toggleOutlineNavigation();
      }
    } else if (key === "m" && !event.shiftKey) {
      event.preventDefault();
      this.togglePreviewOnly();
    } else if (key === "q") {
      event.preventDefault();
      await backend.hideWindow();
    } else if (key === "s" && event.shiftKey) {
      event.preventDefault();
      await this.saveDocument(true);
    } else if (key === "s") {
      event.preventDefault();
      await this.saveDocument(false);
    } else if (key === "o" && !event.shiftKey) {
      event.preventDefault();
      await this.performOperation(() => this.openDocument());
    } else if (key === "h" && !event.shiftKey) {
      event.preventDefault();
      await this.toggleOpacity();
    } else if (key === "n") {
      event.preventDefault();
      await this.performOperation(() => this.newDocument());
    } else if (key === "r" && !event.shiftKey) {
      event.preventDefault();
      await this.performOperation(() => this.renameDocument());
    } else if (key === "e" && !event.shiftKey) {
      event.preventDefault();
      await this.revealDocument();
    } else if (key === "p" && !event.shiftKey) {
      event.preventDefault();
      await this.performOperation(() => this.exportPdf());
    } else if (key === "x" && !event.shiftKey) {
      event.preventDefault();
      this.wrapSelection("~~");
    } else if (key === "b") {
      event.preventDefault();
      this.wrapSelection("**");
    } else if (key === "i") {
      event.preventDefault();
      this.wrapSelection("*");
    } else if (key === "t") {
      event.preventDefault();
      this.insertTable();
    }
  }

  private handleOutlineWidthShortcut(event: KeyboardEvent): void {
    if (
      !event.ctrlKey ||
      event.altKey ||
      event.shiftKey ||
      event.metaKey ||
      (event.key !== "ArrowLeft" && event.key !== "ArrowRight")
    ) {
      return;
    }
    if (
      event.target instanceof HTMLElement &&
      event.target.matches("input, textarea, select")
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.updateOutlineWidth(
      event.key === "ArrowLeft" ? OUTLINE_WIDTH_STEP : -OUTLINE_WIDTH_STEP,
    );
  }

  private handleOutlineNavigationShortcut(event: KeyboardEvent): void {
    if (
      !this.outlineNavigationActive ||
      !event.ctrlKey ||
      event.altKey ||
      event.shiftKey ||
      event.metaKey ||
      (event.key !== "ArrowUp" && event.key !== "ArrowDown")
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();

    const now = Date.now();
    if (
      !event.repeat ||
      !this.outlineNavigationHold ||
      this.outlineNavigationHold.key !== event.key
    ) {
      this.outlineNavigationHold = { key: event.key, startedAt: now };
    }
    const elapsed = now - this.outlineNavigationHold.startedAt;
    const distance = elapsed >= 1_200 ? 4 : elapsed >= 600 ? 2 : 1;
    this.moveOutlineSelection(event.key === "ArrowDown" ? distance : -distance);
  }

  private async newDocument(): Promise<void> {
    if (!(await this.confirmDiscardOrSave())) {
      return;
    }
    if (this.initialized) await backend.clearDocument(this.activeTab.id);
    this.setDocument("", null);
  }

  private async openDocument(newTab = false): Promise<void> {
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "Markdown", extensions: ["md", "markdown", "txt"] }],
    });
    if (typeof selected !== "string") {
      return;
    }
    await this.openRequestedPath(selected, newTab);
  }

  private async openRequestedPath(path: string, newTab = false): Promise<void> {
    try {
      if (this.initialized && await backend.focusExisting(path)) return;
      if (!newTab && !(await this.confirmDiscardOrSave())) return;
      const tab = newTab ? this.createTab() : this.activeTab;
      try {
        if (newTab && this.initialized) await backend.registerDocument(tab.id);
        const payload = await backend.openDocument(path, tab.id);
        this.selectTab(tab);
        this.loadPayload(payload);
      } catch (error) {
        if (newTab) {
          if (this.initialized) await backend.releaseDocument(tab.id);
          this.removeTab(tab);
        }
        throw error;
      }
    } catch (error) {
      await this.showError("ファイルを開けませんでした", error);
    }
  }

  private saveDocument(saveAs: boolean, tab = this.activeTab): Promise<boolean> {
    if (tab.saving) return tab.saving;
    const pending = this.saveTab(tab, saveAs);
    tab.saving = pending;
    void pending.finally(() => { tab.saving = null; });
    return pending;
  }

  private async saveTab(tab: DocumentTab, saveAs: boolean): Promise<boolean> {
    this.cancelAutoSave(tab);
    let requestedPath = tab.path ?? undefined;
    try {
      if (saveAs || !tab.path) {
        const selected = await save({
          defaultPath: tab.path ?? "無題.md",
          filters: [{ name: "Markdown", extensions: ["md"] }],
        });
        if (typeof selected !== "string") {
          this.scheduleAutoSave(tab);
          return false;
        }
        requestedPath = selected;
      }
      const result = await backend.saveDocument(tab.editor.state.doc.toString(), tab.revision.current, requestedPath, tab.id);
      tab.path = result.path;
      const accepted = tab.revision.acceptSavedRevision(result.revision);
      this.updateTitle();
      if (!accepted) this.scheduleAutoSave(tab);
      return accepted;
    } catch (error) {
      await this.showError("保存できませんでした", error);
      return false;
    }
  }

  private scheduleAutoSave(tab = this.activeTab): void {
    this.cancelAutoSave(tab);
    if (!tab.path || !tab.revision.dirty || this.exitLocked || this.transferring === tab) return;
    tab.timer = window.setTimeout(() => {
      tab.timer = undefined;
      if (tab.saving) this.scheduleAutoSave(tab);
      else void this.saveDocument(false, tab);
    }, AUTO_SAVE_DELAY_MS);
  }

  private cancelAutoSave(tab = this.activeTab): void {
    if (tab.timer !== undefined) window.clearTimeout(tab.timer);
    tab.timer = undefined;
  }

  private async renameDocument(): Promise<void> {
    const tab = this.activeTab;
    this.cancelAutoSave(tab);
    if (tab.saving) await tab.saving;
    if (!tab.path && !(await this.saveDocument(true, tab))) {
      return;
    }
    const name = window.prompt(
      "新しいファイル名を入力してください。",
      fileName(this.currentPath),
    );
    if (!name) {
      return;
    }
    try {
      const payload = await backend.renameDocument(name, tab.id);
      tab.path = payload.path;
      this.updateTitle();
    } catch (error) {
      await this.showError("名前を変更できませんでした", error);
    }
  }

  private async revealDocument(): Promise<void> {
    if (!this.currentPath) {
      await message("先にMarkdownファイルを保存してください。", {
        title: DEFAULT_TITLE,
        kind: "info",
      });
      return;
    }
    try {
      await backend.revealDocument(this.activeTab.id);
    } catch (error) {
      await this.showError("保存先を開けませんでした", error);
    }
  }

  private async exportPdf(): Promise<void> {
    const tab = this.activeTab;
    if (this.revision.dirty || !this.currentPath) {
      if (!(await this.saveDocument(false))) {
        return;
      }
    }
    try {
      const target = await backend.pdfTarget(tab.id);
      if (
        target.exists &&
        !(await ask("同名のPDFを上書きしますか？", {
          title: DEFAULT_TITLE,
          kind: "warning",
          okLabel: "上書き",
          cancelLabel: "キャンセル",
        }))
      ) {
        return;
      }
      const printRoot = this.required<HTMLElement>("#print-root");
      const { preparePrintDocument } = await import("./print");
      await preparePrintDocument(
        tab.editor.state.doc.toString(),
        printRoot,
        (path) => backend.localImageData(path, tab.id),
      );
      const result = await invokeWithBackendPayload<PdfExportCompleted>(
        "pdf-export-completed",
        60_000,
        () => backend.exportPdf(target.path, tab.id),
      );
      if (!result.success) {
        throw new Error(result.error ?? "PDF出力に失敗しました。");
      }
      await backend.openPdf(result.outputPath, tab.id);
    } catch (error) {
      await this.showError("PDFへ書き出せませんでした", error);
    }
  }

  private async confirmDiscardOrSave(): Promise<boolean> {
    if (this.activeTab.saving) await this.activeTab.saving;
    this.cancelAutoSave();
    if (!this.revision.dirty) {
      return true;
    }
    const shouldSave = await ask("変更内容を保存しますか？", {
      title: DEFAULT_TITLE,
      kind: "warning",
      okLabel: "保存",
      cancelLabel: "保存しない",
    });
    if (!shouldSave) {
      return ask("変更内容を保存せずに続けますか？", {
        title: DEFAULT_TITLE,
        kind: "warning",
        okLabel: "保存せずに続行",
        cancelLabel: "キャンセル",
      });
    }
    return this.saveDocument(false);
  }

  private async exitWithConfirmation(): Promise<void> {
    try { await backend.confirmExit(); }
    catch (error) { await this.showError("終了できませんでした", error); }
  }

  private async checkExit(): Promise<void> {
    let accepted = false;
    try {
      if (this.operationPending || this.transferring) return;
      for (const tab of this.tabs) {
        this.selectTab(tab);
        if (!(await this.confirmDiscardOrSave())) return;
      }
      accepted = true;
    } finally {
      await backend.exitResponse(accepted);
    }
  }

  private setDocument(content: string, path: string | null): void {
    this.cancelAutoSave();
    this.suppressChanges = true;
    replaceDocument(this.editor, content);
    this.suppressChanges = false;
    this.currentPath = path;
    this.revision.reset();
    this.collapsedOutlineKeys.clear();
    this.updateTitle();
    this.updateDocumentSummary(content);
  }

  private loadPayload(payload: DocumentPayload): void {
    this.setDocument(payload.content, payload.path);
  }

  private updateTitle(): void {
    const dirtyMarker = this.revision.dirty ? "● " : "";
    const name = fileName(this.currentPath);
    this.title.textContent = `${dirtyMarker}${name}`;
    document.title = `${dirtyMarker}${name} — ${DEFAULT_TITLE}`;
    this.renderTabs();
  }

  private updateDocumentSummary(content: string): void {
    const counts = documentCounts(content);
    this.status.textContent = `${counts.characters.toLocaleString()} 文字 / ${counts.words.toLocaleString()} 語`;
    const head = this.editor.state.selection.main.head;
    const line = this.editor.state.doc.lineAt(head);
    this.cursorPosition.textContent = `${line.number}行 ${head - line.from + 1}列`;
    const tab = this.activeTab;
    requestCompleteOutline(this.editor, (headings) => {
      if (this.activeTab === tab) this.renderOutline(headings);
    });
  }

  private renderOutline(headings: OutlineHeading[]): void {
    const tree = buildOutlineTree(headings);
    const validKeys = new Set<string>();
    const collectKeys = (nodes: readonly OutlineNode[]): void => {
      for (const node of nodes) {
        validKeys.add(node.key);
        collectKeys(node.children);
      }
    };
    collectKeys(tree);
    for (const key of this.collapsedOutlineKeys) {
      if (!validKeys.has(key)) {
        this.collapsedOutlineKeys.delete(key);
      }
    }
    this.outlineList.replaceChildren(...this.renderOutlineNodes(tree));
    const hasOutline = headings.length > 0;
    this.outline.hidden = !hasOutline;
    this.workspace.classList.toggle("has-outline", hasOutline);
    this.updateTabPanel();
    if (!hasOutline && this.outlineNavigationActive) {
      this.stopOutlineNavigation();
    } else if (hasOutline && this.outlineNavigationActive) {
      this.refreshOutlineNavigationSelection();
    }
  }

  private renderOutlineNodes(nodes: readonly OutlineNode[]): HTMLElement[] {
    return nodes.map((node) => {
      const container = document.createElement("div");
      container.className = "outline-node";

      const row = document.createElement("div");
      row.className = "outline-row";

      const canCollapse = node.level <= 3 && node.children.length > 0;
      if (canCollapse) {
        const toggle = document.createElement("button");
        const collapsed = this.collapsedOutlineKeys.has(node.key);
        toggle.type = "button";
        toggle.className = "outline-toggle";
        toggle.dataset.outlineToggleKey = node.key;
        toggle.dataset.outlineLabel = node.label;
        toggle.setAttribute("aria-expanded", String(!collapsed));
        toggle.setAttribute(
          "aria-label",
          `${node.label}の配下を${collapsed ? "開く" : "閉じる"}`,
        );
        toggle.textContent = collapsed ? ">" : "⌄";
        row.append(toggle);
      } else {
        const spacer = document.createElement("span");
        spacer.className = "outline-toggle-spacer";
        spacer.setAttribute("aria-hidden", "true");
        row.append(spacer);
      }

      const button = document.createElement("button");
      button.type = "button";
      button.className = "outline-item";
      button.append(renderOutlineLabel(node.label));
      button.dataset.headingPosition = String(node.position);
      button.dataset.outlineKey = node.key;
      button.title = node.label;
      row.append(button);
      container.append(row);

      if (node.children.length > 0) {
        const children = document.createElement("div");
        children.className = "outline-children";
        children.hidden = this.collapsedOutlineKeys.has(node.key);
        children.append(...this.renderOutlineNodes(node.children));
        container.append(children);
      }
      return container;
    });
  }

  private toggleOutlineBranch(toggle: HTMLButtonElement): void {
    const key = toggle.dataset.outlineToggleKey;
    const children = toggle
      .closest<HTMLElement>(".outline-node")
      ?.querySelector<HTMLElement>(":scope > .outline-children");
    if (!key || !children) {
      return;
    }
    const collapsed = !children.hidden;
    children.hidden = collapsed;
    toggle.textContent = collapsed ? ">" : "⌄";
    toggle.setAttribute("aria-expanded", String(!collapsed));
    const label = toggle.dataset.outlineLabel ?? "目次項目";
    toggle.setAttribute(
      "aria-label",
      `${label}の配下を${collapsed ? "開く" : "閉じる"}`,
    );
    if (collapsed) {
      this.collapsedOutlineKeys.add(key);
    } else {
      this.collapsedOutlineKeys.delete(key);
    }
    if (this.outlineNavigationActive) {
      this.refreshOutlineNavigationSelection();
    }
  }

  private toggleOutlineNavigation(): void {
    this.stopTabNavigation();
    if (this.outlineNavigationActive) {
      this.stopOutlineNavigation();
      return;
    }
    const [first] = this.visibleOutlineButtons();
    if (!first) {
      return;
    }
    this.outlineNavigationActive = true;
    this.outline.classList.add("outline-navigation-active");
    this.selectOutlineButton(first, true);
  }

  private stopOutlineNavigation(): void {
    this.outlineNavigationActive = false;
    this.selectedOutlineKey = null;
    this.outline.classList.remove("outline-navigation-active");
    this.resetOutlineNavigationHold();
    this.applyOutlineSelectionState();
    this.editor.focus();
  }

  private moveOutlineSelection(offset: number): void {
    const buttons = this.visibleOutlineButtons();
    if (buttons.length === 0) {
      this.stopOutlineNavigation();
      return;
    }
    const selectedIndex = buttons.findIndex(
      (button) => button.dataset.outlineKey === this.selectedOutlineKey,
    );
    const currentIndex = selectedIndex >= 0 ? selectedIndex : 0;
    const nextIndex = Math.min(
      buttons.length - 1,
      Math.max(0, currentIndex + offset),
    );
    this.selectOutlineButton(buttons[nextIndex]!, true);
  }

  private refreshOutlineNavigationSelection(): void {
    const buttons = this.visibleOutlineButtons();
    const selected = buttons.find(
      (button) => button.dataset.outlineKey === this.selectedOutlineKey,
    );
    this.selectedOutlineKey = (selected ?? buttons[0])?.dataset.outlineKey ?? null;
    this.applyOutlineSelectionState();
  }

  private selectOutlineButton(
    button: HTMLButtonElement,
    navigate: boolean,
  ): void {
    this.selectedOutlineKey = button.dataset.outlineKey ?? null;
    this.applyOutlineSelectionState();
    if (typeof button.scrollIntoView === "function") {
      button.scrollIntoView({ block: "nearest" });
    }
    if (navigate) {
      navigateToHeading(
        this.editor,
        Number(button.dataset.headingPosition),
      );
    }
  }

  private applyOutlineSelectionState(): void {
    for (const button of this.outlineList.querySelectorAll<HTMLButtonElement>(
      ".outline-item",
    )) {
      const selected =
        this.outlineNavigationActive &&
        button.dataset.outlineKey === this.selectedOutlineKey;
      button.classList.toggle("outline-item-selected", selected);
      if (selected) {
        button.setAttribute("aria-current", "location");
      } else {
        button.removeAttribute("aria-current");
      }
    }
  }

  private visibleOutlineButtons(): HTMLButtonElement[] {
    return Array.from(
      this.outlineList.querySelectorAll<HTMLButtonElement>(".outline-item"),
    ).filter((button) => {
      let ancestor = button.parentElement;
      while (ancestor && ancestor !== this.outlineList) {
        if (ancestor.hidden) {
          return false;
        }
        ancestor = ancestor.parentElement;
      }
      return true;
    });
  }

  private resetOutlineNavigationHold(): void {
    this.outlineNavigationHold = null;
  }

  private updateTabPanel(): void {
    const fixedOutline = !this.outline.hidden && window.getComputedStyle(this.outline).position === "static"
      ? this.outlineWidth : 0;
    this.workspace.classList.toggle("tabs-collapsed", this.workspace.clientWidth - fixedOutline - this.outlineWidth < MIN_EDITOR_WIDTH);
  }

  private updateOutlineWidth(delta: number): void {
    this.outlineWidth = Math.min(
      OUTLINE_MAX_WIDTH,
      Math.max(OUTLINE_MIN_WIDTH, this.outlineWidth + delta),
    );
    this.workspace.style.setProperty(
      "--outline-width",
      `${this.outlineWidth}px`,
    );
    this.required<HTMLButtonElement>(
      "button[data-action='outline-expand']",
    ).disabled = this.outlineWidth >= OUTLINE_MAX_WIDTH;
    this.required<HTMLButtonElement>(
      "button[data-action='outline-shrink']",
    ).disabled = this.outlineWidth <= OUTLINE_MIN_WIDTH;
    this.updateTabPanel();
  }

  private async handleControlClick(position: number): Promise<void> {
    const target = markdownTargetAt(this.editor.state.doc.toString(), position);
    if (!target) {
      return;
    }
    if (!target.image) {
      try {
        await backend.openExternalUrl(target.target);
      } catch (error) {
        await this.showError("リンクを開けませんでした", error);
      }
      return;
    }
    if (/^https?:\/\//i.test(target.target)) {
      await message("外部画像URLは取得しません。", {
        title: DEFAULT_TITLE,
        kind: "warning",
      });
      return;
    }
    try {
      this.imageElement.src = await backend.localImageData(target.target, this.activeTab.id);
      this.imageDialog.showModal();
    } catch (error) {
      await this.showError("画像を表示できませんでした", error);
    }
  }

  private wrapSelection(marker: string): void {
    const selection = this.editor.state.selection.main;
    const selected = this.editor.state.doc.sliceString(
      selection.from,
      selection.to,
    );
    this.editor.dispatch({
      changes: {
        from: selection.from,
        to: selection.to,
        insert: `${marker}${selected}${marker}`,
      },
      selection: selection.empty
        ? { anchor: selection.from + marker.length }
        : {
            anchor: selection.from + marker.length,
            head: selection.to + marker.length,
          },
      userEvent: "input",
    });
    this.editor.focus();
  }

  private insertTable(): void {
    const rowInput = window.prompt("表の行数を入力してください。", "3");
    if (rowInput === null) {
      return;
    }
    const columnInput = window.prompt("表の列数を入力してください。", "3");
    if (columnInput === null) {
      return;
    }
    const rows = Number.parseInt(rowInput, 10);
    const columns = Number.parseInt(columnInput, 10);
    if (
      !Number.isInteger(rows) ||
      !Number.isInteger(columns) ||
      rows < 1 ||
      columns < 1 ||
      rows > 30 ||
      columns > 20
    ) {
      void message("行数は1～30、列数は1～20で指定してください。", {
        title: DEFAULT_TITLE,
        kind: "warning",
      });
      return;
    }
    const tableRows = [
      `| ${Array.from({ length: columns }, () => "q").join(" | ")} |`,
      `| ${Array.from({ length: columns }, () => "---").join(" | ")} |`,
      ...Array.from(
        { length: Math.max(0, rows - 1) },
        () => `| ${Array.from({ length: columns }, () => "q").join(" | ")} |`,
      ),
    ];
    const table = tableRows.join("\n");
    const selection = this.editor.state.selection.main;
    this.editor.dispatch({
      changes: {
        from: selection.from,
        to: selection.to,
        insert: table,
      },
      selection: { anchor: selection.from + 2 },
      userEvent: "input",
    });
    this.editor.focus();
  }

  private async toggleOpacity(): Promise<void> {
    const next = !this.translucent;
    try {
      await backend.setWindowOpacity(next ? 0.6 : 1);
      this.translucent = next;
    } catch (error) {
      await this.showError("半透明表示を切り替えられませんでした", error);
    }
  }

  private togglePreviewOnly(): void {
    const enabled = !this.editor.state.readOnly;
    setPreviewOnly(this.editor, enabled);
    this.updatePreviewButton();
    this.editor.focus();
  }

  private updatePreviewButton(): void {
    const enabled = this.editor.state.readOnly;
    const button = this.required<HTMLButtonElement>(
      "button[data-action='preview']",
    );
    button.textContent = enabled ? "編集モードへ戻る" : "閲覧モード";
    button.setAttribute("aria-pressed", String(enabled));
    button.classList.toggle("mode-toggle-active", enabled);
    this.editorHost.setAttribute(
      "aria-label",
      enabled ? "Markdown閲覧欄" : "Markdown編集欄",
    );
    this.editor.focus();
  }

  private async showSettings(): Promise<void> {
    const status = await backend.hotkeyStatus();
    this.hotkeyInput.value = status.shortcut;
    this.renderHotkeyStatus(status);
    this.settingsDialog.showModal();
  }

  private async applyHotkey(): Promise<void> {
    try {
      const status = await backend.updateHotkey(this.hotkeyInput.value);
      this.renderHotkeyStatus(status);
      this.hotkeyStatus.textContent +=
        " 設定したキーを押し、ウィンドウが復帰することを確認してください。";
    } catch (error) {
      await this.showError("ホットキーを設定できませんでした", error);
      this.renderHotkeyStatus(await backend.hotkeyStatus());
    }
  }

  private renderHotkeyStatus(status: HotkeyStatus): void {
    this.required("#app-hotkey-shortcut").textContent = status.shortcut;
    const registration = status.registered ? "登録済み" : "未登録";
    const lastTriggered = status.lastTriggeredAtMs
      ? new Date(status.lastTriggeredAtMs).toLocaleString()
      : "まだ発火していません";
    this.hotkeyStatus.textContent =
      `${status.shortcut}: ${registration} / 最終発火: ${lastTriggered}` +
      (status.error ? ` / ${status.error}` : "");
  }

  private toggleMoreMenu(): void {
    const menu = this.required("#more-menu");
    menu.hidden = !menu.hidden;
    this.required<HTMLButtonElement>("button[data-action='more']").setAttribute(
      "aria-expanded",
      String(!menu.hidden),
    );
  }

  private hideMoreMenu(): void {
    this.required("#more-menu").hidden = true;
    this.required<HTMLButtonElement>("button[data-action='more']").setAttribute(
      "aria-expanded",
      "false",
    );
  }

  private async showError(title: string, error: unknown): Promise<void> {
    await message(error instanceof Error ? error.message : String(error), {
      title,
      kind: "error",
    });
  }

  private async copyText(text: string): Promise<void> {
    try {
      await backend.copyText(text);
    } catch (error) {
      await this.showError("コピーできませんでした", error);
    }
  }

  private required<T extends HTMLElement>(selector: string): T {
    const element = this.root.querySelector<T>(selector);
    if (!element) {
      throw new Error(`UI要素が見つかりません: ${selector}`);
    }
    return element;
  }

  private requiredDialog(selector: string): HTMLDialogElement {
    return this.required<HTMLDialogElement>(selector);
  }

  private requiredImage(selector: string): HTMLImageElement {
    return this.required<HTMLImageElement>(selector);
  }

  private requiredInput(selector: string): HTMLInputElement {
    return this.required<HTMLInputElement>(selector);
  }
}
