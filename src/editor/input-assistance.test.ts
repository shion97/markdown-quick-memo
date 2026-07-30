import { describe, expect, it } from "vitest";
import { continuationForLine } from "./input-assistance";

describe("continuationForLine", () => {
  it("番号付きリストはMarkdown原文へ1.を継続する", () => {
    expect(continuationForLine("1. 項目", 5).inserted).toBe("\n1. ");
  });

  it("チェックリストは未チェック状態で継続する", () => {
    expect(continuationForLine("- [x] 完了", 8).inserted).toBe("\n- [ ] ");
  });

  it("引用内リストを同じ階層で継続する", () => {
    expect(continuationForLine(">   - 項目", 8).inserted).toBe("\n>   - ");
  });

  it("通常行はインデントだけを継続する", () => {
    expect(continuationForLine("    本文", 6).inserted).toBe("\n    ");
  });
});
