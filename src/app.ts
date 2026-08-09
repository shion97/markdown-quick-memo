import { ask, message, open, save } from "@tauri-apps/plugin-dialog";
import {
  backend,
  invokeWithBackendPayload,
  onBackendEvent,
  onBackendPayload,
  type DocumentPayload,
  type HotkeyStatus,
  type PdfExportCompleted,
} from "./bridge/tauri";
import {
  createEditor,
  documentCounts,
  replaceDocument,
  setPreviewOnly,
} from "./editor/editor";
import {
  buildOutlineTree,
  navigateToHeading,
  requestCompleteOutline,
  type OutlineHeading,
  type OutlineNode,
} from "./editor/outline";
import { RevisionTracker } from "./editor/revision";

const DEFAULT_TITLE = "Markdown Quick Memo";
const OUTLINE_MIN_WIDTH = 240;
const OUTLINE_MAX_WIDTH = 480;
const OUTLINE_WIDTH_STEP = 40;
const AUTO_SAVE_DELAY_MS = 1_000;

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

export class MarkdownQuickMemoApplication {
  private readonly revision = new RevisionTracker();
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
  private editor;
  private currentPath: string | null = null;
  private suppressChanges = false;
  private saving = false;
  private autoSaveTimer: number | undefined;
  private translucent = false;
  private outlineWidth = OUTLINE_MIN_WIDTH;
  private readonly collapsedOutlineKeys = new Set<string>();
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
    this.editor = createEditor(this.editorHost, {
      onDocumentChanged: () => {
        if (!this.suppressChanges) {
          this.revision.changed();
          this.updateTitle();
          this.scheduleAutoSave();
        }
      },
      onCountsChanged: (characters, words) => {
        this.status.textContent = `${characters.toLocaleString()} 文字 / ${words.toLocaleString()} 語`;
      },
      onOutlineChanged: (headings) => {
        this.renderOutline(headings);
      },
      onCursorChanged: (line, column) => {
        this.cursorPosition.textContent = `${line}行 ${column}列`;
      },
      onControlClick: (position) => {
        void this.handleControlClick(position);
      },
    });
    this.bindActions();
    this.updateOutlineWidth(0);
  }

  async initialize(): Promise<void> {
    const bootstrap = await backend.bootstrap();
    if (bootstrap.document) {
      this.loadPayload(bootstrap.document);
    } else {
      this.setDocument("", null);
    }
    this.renderHotkeyStatus(bootstrap.hotkey);
    await Promise.all([
      onBackendEvent("focus-editor", () => this.editor.focus()),
      onBackendEvent("close-requested", () => this.exitWithConfirmation()),
      onBackendEvent("hotkey-triggered", async () => {
        if (this.settingsDialog.open) {
          this.renderHotkeyStatus(await backend.hotkeyStatus());
          this.hotkeyStatus.textContent += " / 押下確認済み";
        }
      }),
      onBackendPayload<string>("open-file-requested", (path) => {
        void this.openRequestedPath(path);
      }),
    ]);
    await backend.frontendReady();
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
              <button data-action="open"><span>開く</span></button>
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
              <div class="shortcut-row"><span>リストを深く / 浅く</span><kbd>Tab / Shift+Tab</kbd></div>
              <div class="shortcut-row"><span>単純改行</span><kbd>Shift+Enter</kbd></div>
              <div class="shortcut-row"><span>リンク・画像を開く</span><kbd>Ctrl+クリック</kbd></div>
            </section>
            <section class="popover-group" aria-labelledby="shortcut-window-heading">
              <h2 id="shortcut-window-heading">表示・終了</h2>
              <div class="shortcut-row"><span>アプリを表示</span><kbd id="app-hotkey-shortcut">Ctrl+Alt+M</kbd></div>
              <button data-action="preview"><span>閲覧 / 編集モード</span><kbd>Ctrl+M</kbd></button>
              <div class="shortcut-row"><span>目次を操作 / 編集へ戻る</span><kbd>Ctrl+L</kbd></div>
              <button data-action="opacity"><span>半透明表示</span><kbd>Ctrl+O</kbd></button>
              <button data-action="hide"><span>待機状態へ戻す</span><kbd>Ctrl+Q</kbd></button>
              <button data-action="exit"><span>完全に終了</span><kbd>Alt+F4</kbd></button>
            </section>
            <button data-action="settings" class="popover-settings"><span>ホットキー設定</span></button>
          </div>
        </header>
        <section id="workspace" class="workspace">
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
        this.handleOutlineNavigationShortcut(event);
        this.handleOutlineWidthShortcut(event);
      },
      { capture: true },
    );
    this.root.addEventListener("keyup", (event) => {
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        this.resetOutlineNavigationHold();
      }
    });
    window.addEventListener("blur", () => this.resetOutlineNavigationHold());
    this.root.addEventListener("click", (event) => {
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
      void this.handleShortcut(event);
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
    const actions: Record<string, () => void | Promise<void>> = {
      new: () => this.newDocument(),
      open: () => this.openDocument(),
      save: async () => {
        await this.saveDocument(false);
      },
      "save-as": async () => {
        await this.saveDocument(true);
      },
      rename: () => this.renameDocument(),
      reveal: () => this.revealDocument(),
      "export-pdf": () => this.exportPdf(),
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
    if (!event.ctrlKey) {
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
      await this.toggleOpacity();
    } else if (key === "n") {
      event.preventDefault();
      await this.newDocument();
    } else if (key === "r" && !event.shiftKey) {
      event.preventDefault();
      await this.renameDocument();
    } else if (key === "e" && !event.shiftKey) {
      event.preventDefault();
      await this.revealDocument();
    } else if (key === "p" && !event.shiftKey) {
      event.preventDefault();
      await this.exportPdf();
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
    this.setDocument("", null);
  }

  private async openDocument(): Promise<void> {
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "Markdown", extensions: ["md", "markdown", "txt"] }],
    });
    if (typeof selected !== "string") {
      return;
    }
    await this.openRequestedPath(selected);
  }

  private async openRequestedPath(
    path: string,
    requireConfirmation = true,
  ): Promise<void> {
    if (requireConfirmation && !(await this.confirmDiscardOrSave())) {
      return;
    }
    try {
      this.loadPayload(await backend.openDocument(path));
    } catch (error) {
      await this.showError("ファイルを開けませんでした", error);
    }
  }

  private async saveDocument(saveAs: boolean): Promise<boolean> {
    if (this.saving) {
      return false;
    }
    this.cancelAutoSave();
    let requestedPath: string | undefined;
    if (saveAs || !this.currentPath) {
      const selected = await save({
        defaultPath: this.currentPath ?? "無題.md",
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (typeof selected !== "string") {
        this.scheduleAutoSave();
        return false;
      }
      requestedPath = selected;
    }

    this.saving = true;
    const revision = this.revision.current;
    try {
      const result = await backend.saveDocument(
        this.editor.state.doc.toString(),
        revision,
        requestedPath,
      );
      this.currentPath = result.path;
      const accepted = this.revision.acceptSavedRevision(result.revision);
      this.updateTitle();
      if (!accepted && this.autoSaveTimer === undefined) {
        this.scheduleAutoSave();
      }
      return true;
    } catch (error) {
      await this.showError("保存できませんでした", error);
      return false;
    } finally {
      this.saving = false;
    }
  }

  private scheduleAutoSave(): void {
    this.cancelAutoSave();
    if (!this.currentPath || !this.revision.dirty) {
      return;
    }
    this.autoSaveTimer = window.setTimeout(() => {
      this.autoSaveTimer = undefined;
      void this.autoSaveCurrentDocument();
    }, AUTO_SAVE_DELAY_MS);
  }

  private cancelAutoSave(): void {
    if (this.autoSaveTimer === undefined) {
      return;
    }
    window.clearTimeout(this.autoSaveTimer);
    this.autoSaveTimer = undefined;
  }

  private async autoSaveCurrentDocument(): Promise<void> {
    if (!this.currentPath || !this.revision.dirty) {
      return;
    }
    if (this.saving) {
      this.scheduleAutoSave();
      return;
    }
    await this.saveDocument(false);
  }

  private async renameDocument(): Promise<void> {
    if (!this.currentPath && !(await this.saveDocument(true))) {
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
      const payload = await backend.renameDocument(name);
      this.currentPath = payload.path;
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
      await backend.revealDocument();
    } catch (error) {
      await this.showError("保存先を開けませんでした", error);
    }
  }

  private async exportPdf(): Promise<void> {
    if (this.revision.dirty || !this.currentPath) {
      if (!(await this.saveDocument(false))) {
        return;
      }
    }
    try {
      const target = await backend.pdfTarget();
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
        this.editor.state.doc.toString(),
        printRoot,
        backend.localImageData,
      );
      const result = await invokeWithBackendPayload<PdfExportCompleted>(
        "pdf-export-completed",
        60_000,
        () => backend.exportPdf(target.path),
      );
      if (!result.success) {
        throw new Error(result.error ?? "PDF出力に失敗しました。");
      }
      await backend.openPdf(result.outputPath);
    } catch (error) {
      await this.showError("PDFへ書き出せませんでした", error);
    }
  }

  private async confirmDiscardOrSave(): Promise<boolean> {
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
    if (this.revision.dirty) {
      const shouldSave = await ask("終了前に変更内容を保存しますか？", {
        title: DEFAULT_TITLE,
        kind: "warning",
        okLabel: "保存して終了",
        cancelLabel: "保存せず終了",
      });
      if (shouldSave && !(await this.saveDocument(false))) {
        return;
      }
      if (
        !shouldSave &&
        !(await ask("変更内容を保存せずに終了しますか？", {
          title: DEFAULT_TITLE,
          kind: "warning",
          okLabel: "保存せず終了",
          cancelLabel: "キャンセル",
        }))
      ) {
        return;
      }
    }
    await backend.confirmExit();
  }

  private setDocument(content: string, path: string | null): void {
    this.cancelAutoSave();
    this.suppressChanges = true;
    replaceDocument(this.editor, content);
    this.suppressChanges = false;
    this.currentPath = path;
    this.revision.reset();
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
  }

  private updateDocumentSummary(content: string): void {
    const counts = documentCounts(content);
    this.status.textContent = `${counts.characters.toLocaleString()} 文字 / ${counts.words.toLocaleString()} 語`;
    const head = this.editor.state.selection.main.head;
    const line = this.editor.state.doc.lineAt(head);
    this.cursorPosition.textContent = `${line.number}行 ${head - line.from + 1}列`;
    requestCompleteOutline(this.editor, (headings) => {
      this.renderOutline(headings);
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
      button.textContent = node.label;
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
      this.imageElement.src = await backend.localImageData(target.target);
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
