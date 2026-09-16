import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface DocumentPayload {
  path: string;
  content: string;
}

export interface HotkeyStatus {
  shortcut: string;
  registered: boolean;
  lastTriggeredAtMs: number | null;
  error: string | null;
}

export interface BootstrapPayload {
  windowLabel: string;
  background: boolean;
  document: DocumentPayload | null;
  hotkey: HotkeyStatus;
}

export interface SaveResult {
  path: string;
  revision: number;
}

export interface PdfTarget {
  path: string;
  exists: boolean;
}

export interface PdfExportCompleted {
  outputPath: string;
  success: boolean;
  error: string | null;
}

export interface TabTransfer {
  id: string;
  documentId: string;
  source: string;
  target: string;
  snapshot: unknown;
  index: number;
}
export interface TabDragResult {
  target: string | null;
  x: number;
  y: number;
  clientY: number;
  outside: boolean;
  cancelled: boolean;
}

export const backend = {
  registerDocument: (documentId: string): Promise<void> => invoke("register_document", { documentId }),
  clearDocument: (documentId: string): Promise<void> => invoke("clear_document", { documentId }),
  releaseDocument: (documentId: string): Promise<void> => invoke("release_document", { documentId }),
  focusExisting: (path: string): Promise<boolean> => invoke("focus_existing", { path }),
  exitResponse: (accepted: boolean): Promise<void> => invoke("exit_response", { accepted }),
  dragTab: (): Promise<TabDragResult> => invoke("drag_tab"),
  transferTab: (documentId: string, snapshot: unknown, target: string | null, x: number, y: number, index: number): Promise<TabTransfer> =>
    invoke("transfer_tab", { documentId, snapshot, target, x, y, index }),
  transferStatus: (documentId: string): Promise<"pending" | "accepted" | "cancelled"> => invoke("transfer_status", { documentId }),
  cancelTransfer: (documentId: string): Promise<void> => invoke("cancel_transfer", { documentId }),
  pendingTransfer: (): Promise<TabTransfer | null> => invoke("pending_transfer"),
  acceptTransfer: (transferId: string, accepted: boolean): Promise<void> => invoke("accept_transfer", { transferId, accepted }),
  closeEmptyWindow: (): Promise<void> => invoke("close_empty_window"),
  bootstrap: (): Promise<BootstrapPayload> => invoke("bootstrap"),
  frontendReady: (): Promise<void> => invoke("frontend_ready"),
  openDocument: (path: string, documentId: string): Promise<DocumentPayload> =>
    invoke("open_document", { path, documentId }),
  saveDocument: (
    content: string,
    revision: number,
    path: string | undefined,
    documentId: string,
  ): Promise<SaveResult> =>
    invoke("save_document", {
      documentId,
      content,
      revision,
      path: path ?? null,
    }),
  renameDocument: (newName: string, documentId: string): Promise<DocumentPayload> =>
    invoke("rename_document", { newName, documentId }),
  revealDocument: (documentId: string): Promise<void> => invoke("reveal_document", { documentId }),
  localImageData: (relativePath: string, documentId: string): Promise<string> =>
    invoke("local_image_data", { relativePath, documentId }),
  hideWindow: (): Promise<void> => invoke("hide_window"),
  confirmExit: (): Promise<void> => invoke("confirm_exit"),
  hotkeyStatus: (): Promise<HotkeyStatus> => invoke("hotkey_status"),
  updateHotkey: (shortcut: string): Promise<HotkeyStatus> =>
    invoke("update_hotkey", { shortcut }),
  pdfTarget: (documentId: string): Promise<PdfTarget> => invoke("pdf_target", { documentId }),
  exportPdf: (outputPath: string, documentId: string): Promise<string> =>
    invoke("export_pdf", { outputPath, documentId }),
  openPdf: (outputPath: string, documentId: string): Promise<void> =>
    invoke("open_pdf", { outputPath, documentId }),
  openExternalUrl: (url: string): Promise<void> =>
    invoke("open_external_url", { url }),
  setWindowOpacity: (opacity: number): Promise<void> =>
    invoke("set_window_opacity", { opacity }),
  copyText: (text: string): Promise<void> => invoke("copy_text", { text }),
};

let eventTarget: string | undefined;

export function configureBackendEvents(windowLabel: string | undefined): void {
  eventTarget = windowLabel;
}

export function onBackendEvent(
  eventName: string,
  handler: () => void | Promise<void>,
): Promise<UnlistenFn> {
  return listen(eventName, () => {
    void handler();
  }, { target: eventTarget });
}

export function onBackendPayload<T>(
  eventName: string,
  handler: (payload: T) => void,
): Promise<UnlistenFn> {
  return listen<T>(eventName, (event) => {
    handler(event.payload);
  }, { target: eventTarget });
}

export async function invokeWithBackendPayload<T>(
  eventName: string,
  timeoutMs: number,
  invokeAction: () => Promise<unknown>,
): Promise<T> {
  let resolvePayload: ((payload: T) => void) | undefined;
  let rejectPayload: ((reason: Error) => void) | undefined;
  const payload = new Promise<T>((resolve, reject) => {
    resolvePayload = resolve;
    rejectPayload = reject;
  });
  const unlisten = await listen<T>(eventName, (event) => {
    resolvePayload?.(event.payload);
  }, { target: eventTarget });
  const timeout = window.setTimeout(() => {
    rejectPayload?.(
      new Error(`${eventName}が${timeoutMs / 1_000}秒以内に完了しませんでした。`),
    );
  }, timeoutMs);

  try {
    await invokeAction();
    return await payload;
  } finally {
    window.clearTimeout(timeout);
    unlisten();
  }
}
