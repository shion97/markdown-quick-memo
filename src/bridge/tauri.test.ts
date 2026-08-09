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

import { invokeWithBackendPayload } from "./tauri";

afterEach(() => {
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
