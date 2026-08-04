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

  it("空の引用内リストを終了して引用階層だけを残す", () => {
    expect(continuationForLine("> - ", 4)).toEqual({
      replacementFrom: 2,
      replacementTo: 4,
      inserted: "",
    });
  });

  it("空のリストでは余分な改行を追加せず記号だけを削除する", () => {
    expect(continuationForLine("- ", 2)).toEqual({
      replacementFrom: 0,
      replacementTo: 2,
      inserted: "",
    });
  });

  it("ネストしたチェックリストを同じ字下げで継続する", () => {
    expect(continuationForLine("  - [x] 完了", 10).inserted).toBe(
      "\n  - [ ] ",
    );
  });

  it("通常行はインデントだけを継続する", () => {
    expect(continuationForLine("    本文", 6).inserted).toBe("\n    ");
  });
});
