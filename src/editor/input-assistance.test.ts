import { describe, expect, it } from "vitest";
import {
  continuationForLine,
  quoteSpaceDeletionForLine,
} from "./input-assistance";

describe("continuationForLine", () => {
  it("番号付きリストはMarkdown原文へ1.を継続する", () => {
    expect(continuationForLine("1. 項目", 5).inserted).toBe("\n1. ");
  });

  it("チェックリストは未チェック状態で継続する", () => {
    expect(continuationForLine("- [x] 完了", 8).inserted).toBe("\n- [ ] ");
  });

  it("引用内リストを同じ階層で継続する", () => {
    expect(continuationForLine(">   - 項目", 8).inserted).toBe("\n>   - ");
    const continuousQuoteList = ">>>> - 項目";
    expect(
      continuationForLine(continuousQuoteList, continuousQuoteList.length)
        .inserted,
    ).toBe("\n>>>> - ");
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

  it("空の最浅引用は改行せず同じ行で終了する", () => {
    expect(continuationForLine("> ", 2)).toEqual({
      replacementFrom: 0,
      replacementTo: 2,
      inserted: "",
    });
  });

  it("空の深い引用は改行せず同じ行で一段ずつ浅くする", () => {
    expect(continuationForLine("> > ", 4)).toEqual({
      replacementFrom: 0,
      replacementTo: 4,
      inserted: "> ",
    });
    expect(continuationForLine("> > > ", 6)).toEqual({
      replacementFrom: 0,
      replacementTo: 6,
      inserted: "> > ",
    });
    expect(continuationForLine(">>>> ", 5)).toEqual({
      replacementFrom: 0,
      replacementTo: 5,
      inserted: ">>> ",
    });
  });

  it("引用本文がある場合は同じ深度を次行へ継続する", () => {
    expect(continuationForLine("> > 本文", 6).inserted).toBe("\n> > ");
    expect(continuationForLine(">>>> 本文", 7).inserted).toBe("\n>>>> ");
  });

  it("最後の引用記号直後に半角スペースがない行は通常改行する", () => {
    for (const source of [
      ">本文",
      ">>>>本文",
      ">>>>\t本文",
      "> > > >本文",
      ">>>>- 項目",
    ]) {
      expect(continuationForLine(source, source.length).inserted).toBe("\n");
    }
  });
});

describe("quoteSpaceDeletionForLine", () => {
  it("空引用の末尾にある半角スペースだけを削除する", () => {
    expect(quoteSpaceDeletionForLine("> ", 2)).toEqual({
      replacementFrom: 1,
      replacementTo: 2,
      inserted: "",
    });
    expect(quoteSpaceDeletionForLine("> > > ", 6)).toEqual({
      replacementFrom: 5,
      replacementTo: 6,
      inserted: "",
    });
    expect(quoteSpaceDeletionForLine(">>>> ", 5)).toEqual({
      replacementFrom: 4,
      replacementTo: 5,
      inserted: "",
    });
  });

  it("本文中や半角スペース以外の末尾では専用削除を行わない", () => {
    expect(quoteSpaceDeletionForLine("> 本文", 2)).toBeNull();
    expect(quoteSpaceDeletionForLine(">\t", 2)).toBeNull();
    expect(quoteSpaceDeletionForLine(">>>>", 4)).toBeNull();
  });
});
