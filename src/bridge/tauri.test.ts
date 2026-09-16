// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauriMocks.invoke,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: tauriMocks.listen,
}));

import { backend, configureBackendEvents, invokeWithBackendPayload, onBackendPayload } from "./tauri";

afterEach(() => {
  configureBackendEvents(undefined);
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("invokeWithBackendPayload", () => {
  it("購読完了後に処理を開始し、完了ペイロードを返す", async () => {
    const unlisten = vi.fn();
    let emitPayload: ((event: { payload: string }) => void) | undefined;
    tauriMocks.listen.mockImplementation(
      async (_eventName: string, handler: (event: { payload: string }) => void) => {
        emitPayload = handler;
        return unlisten;
      },
    );
    const invokeAction = vi.fn(async () => {
      expect(emitPayload).toBeDefined();
      emitPayload?.({ payload: "完了" });
    });

    await expect(
      invokeWithBackendPayload("completed", 1_000, invokeAction),
    ).resolves.toBe("完了");

    expect(invokeAction).toHaveBeenCalledOnce();
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it("開始処理が失敗した場合も購読を解除する", async () => {
    const unlisten = vi.fn();
    tauriMocks.listen.mockResolvedValue(unlisten);

    await expect(
      invokeWithBackendPayload("completed", 1_000, async () => {
        throw new Error("開始失敗");
      }),
    ).rejects.toThrow("開始失敗");

    expect(unlisten).toHaveBeenCalledOnce();
  });

  it("完了イベントが届かなければタイムアウトして購読を解除する", async () => {
    vi.useFakeTimers();
    const unlisten = vi.fn();
    tauriMocks.listen.mockResolvedValue(unlisten);

    const completion = invokeWithBackendPayload(
      "completed",
      1_000,
      async () => undefined,
    );
    const expectation = expect(completion).rejects.toThrow(
      "completedが1秒以内に完了しませんでした。",
    );
    await vi.advanceTimersByTimeAsync(1_000);

    await expectation;
    expect(unlisten).toHaveBeenCalledOnce();
  });
});

describe("backend", () => {
  it("文書の保存に文書IDと保存先を明示する", async () => {
    tauriMocks.invoke.mockResolvedValue({ path: "C:\\memo.md", revision: 2 });
    await backend.saveDocument("本文", 2, "C:\\memo.md", "document-2");
    expect(tauriMocks.invoke).toHaveBeenCalledWith("save_document", {
      documentId: "document-2", content: "本文", revision: 2, path: "C:\\memo.md",
    });
  });

  it("タブ受け渡しとPDF完了は自分のウィンドウ宛のイベントだけを購読する", async () => {
    configureBackendEvents("memo-2");
    tauriMocks.listen.mockResolvedValue(vi.fn());
    await onBackendPayload("receive-tab", vi.fn());
    expect(tauriMocks.listen).toHaveBeenCalledWith("receive-tab", expect.any(Function), { target: "memo-2" });
    let deliver!: (event: { payload: string }) => void;
    tauriMocks.listen.mockImplementation(async (_event: string, handler: typeof deliver) => {
      deliver = handler;
      return vi.fn();
    });
    await invokeWithBackendPayload("pdf-export-completed", 1000, async () => { deliver({ payload: "完了" }); });
    expect(tauriMocks.listen).toHaveBeenLastCalledWith("pdf-export-completed", expect.any(Function), { target: "memo-2" });
  });

  it("コピー文字列をcopy_textコマンドへ渡す", async () => {
    tauriMocks.invoke.mockResolvedValue(undefined);

    await backend.copyText("日本語😀\n複数行");

    expect(tauriMocks.invoke).toHaveBeenCalledWith("copy_text", {
      text: "日本語😀\n複数行",
    });
  });
});
