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

export const backend = {
  bootstrap: (): Promise<BootstrapPayload> => invoke("bootstrap"),
  frontendReady: (): Promise<void> => invoke("frontend_ready"),
  openDocument: (path: string): Promise<DocumentPayload> =>
    invoke("open_document", { path }),
  saveDocument: (
    content: string,
    revision: number,
    path?: string,
  ): Promise<SaveResult> =>
    invoke("save_document", {
      content,
      revision,
      path: path ?? null,
    }),
  renameDocument: (newName: string): Promise<DocumentPayload> =>
    invoke("rename_document", { newName }),
  revealDocument: (): Promise<void> => invoke("reveal_document"),
  localImageData: (relativePath: string): Promise<string> =>
    invoke("local_image_data", { relativePath }),
  hideWindow: (): Promise<void> => invoke("hide_window"),
  confirmExit: (): Promise<void> => invoke("confirm_exit"),
  hotkeyStatus: (): Promise<HotkeyStatus> => invoke("hotkey_status"),
  updateHotkey: (shortcut: string): Promise<HotkeyStatus> =>
    invoke("update_hotkey", { shortcut }),
  pdfTarget: (): Promise<PdfTarget> => invoke("pdf_target"),
  exportPdf: (outputPath: string): Promise<string> =>
    invoke("export_pdf", { outputPath }),
  openPdf: (outputPath: string): Promise<void> =>
    invoke("open_pdf", { outputPath }),
  openExternalUrl: (url: string): Promise<void> =>
    invoke("open_external_url", { url }),
  setWindowOpacity: (opacity: number): Promise<void> =>
    invoke("set_window_opacity", { opacity }),
};

export function onBackendEvent(
  eventName: string,
  handler: () => void | Promise<void>,
): Promise<UnlistenFn> {
  return listen(eventName, () => {
    void handler();
  });
}

export function onBackendPayload<T>(
  eventName: string,
  handler: (payload: T) => void,
): Promise<UnlistenFn> {
  return listen<T>(eventName, (event) => {
    handler(event.payload);
  });
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
  });
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
