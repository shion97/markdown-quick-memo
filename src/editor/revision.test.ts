import { describe, expect, it } from "vitest";
import { RevisionTracker } from "./revision";

describe("RevisionTracker", () => {
  it("現在のリビジョンと一致する保存結果だけを受理する", () => {
    const tracker = new RevisionTracker();
    const savingRevision = tracker.changed();
    tracker.changed();

    expect(tracker.acceptSavedRevision(savingRevision)).toBe(false);
    expect(tracker.dirty).toBe(true);
    expect(tracker.acceptSavedRevision(tracker.current)).toBe(true);
    expect(tracker.dirty).toBe(false);
  });

  it("文書切替時にdirty状態をリセットする", () => {
    const tracker = new RevisionTracker();
    tracker.changed();
    tracker.reset();

    expect(tracker.current).toBe(0);
    expect(tracker.dirty).toBe(false);
  });
});
