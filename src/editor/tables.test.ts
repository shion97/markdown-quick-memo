import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { GFM } from "@lezer/markdown";
import { describe, expect, it } from "vitest";
import { findTable, readClipboardTable, serializeTable, tableRowRanges, tableBreakRanges } from "./tables";

function state(source: string): EditorState {
  return EditorState.create({ doc: source, extensions: markdown({ base: markdownLanguage, extensions: [GFM] }) });
}

describe("表の共通処理", () => {
  it("外側のパイプ省略、2本の区切り線、不揃いなセルを内容を落とさず認識する", () => {
    const table = findTable(state("名前 | 値\n:-- | --:\n名前 \\| 別名 | $a|b$ | 追加\n短い |\n\n本文"), 0)!;
    expect(table.rows.map(row => row.cells.map(cell => cell.text))).toEqual([
      ["名前", "値"], ["名前 \\| 別名", "$a|b$", "追加"], ["短い"],
    ]);
    expect(table.columns).toBe(3);
    expect(table.alignments).toEqual(["left", "right", "left"]);
    expect(serializeTable(table.rows.map(row => row.cells.map(cell => cell.text)), table.alignments)).toContain("| 短い |  |  |");
  });

  it("空の1列の表と、外側パイプのない空セルを扱う", () => {
    expect(findTable(state("| |\n| -- |"), 1)?.columns).toBe(1);
    expect(tableRowRanges({ from: 0, to: 6, text: "a|  |c" }).cells).toHaveLength(3);
  });

  it("コードブロックと数式ブロック内は表にしない", () => {
    for (const fence of ["```", "~~~", "$$"]) {
      const source = `${fence}\n| a | b |\n| -- | -- |\n${fence}`;
      expect(findTable(state(source), source.indexOf("a"))).toBeNull();
    }
  });

  it("コード内の数式記号を、後続の表を囲む数式として扱わない", () => {
    const source = "```\n$$\n```\n\n| a | b |\n| --- | --- |\n\n$$\nx\n$$";
    expect(findTable(state(source), source.indexOf("a"))?.columns).toBe(2);
    expect(findTable(state("| `$$` |\n| --- |\n| `$$` |"), 2)?.columns).toBe(1);
  });

  it("コード・数式・エスケープ内のbrは改行にしない", () => {
    const text = "a<br>b `<br>` $x<br>y$ \\(x<br>y\\) \\<br>";
    expect(tableBreakRanges(text)).toEqual([{ from: 1, to: 5 }]);
  });

  it("セル内の全角スペースを構造操作で消さない", () => {
    const table = findTable(state("| 　名前　 |\n| --- |"), 2)!;
    expect(table.rows[0]?.cells[0]?.text).toBe("　名前　");
    expect(serializeTable(table.rows.map(row => row.cells.map(cell => cell.text)))).toContain("| 　名前　 |");
  });

  it("TSVの空セル、引用符、セル内改行と末尾の行区切りを保持する", () => {
    expect(readClipboardTable('a\t"b\nb"\r\n\t"c""d"\r\n')).toEqual([["a", "b\nb"], ["", 'c"d']]);
    expect(readClipboardTable("普通の文章\n次の行")).toBeNull();
    expect(readClipboardTable("| a | b |\n| --- | --- |\na\tb")).toBeNull();
  });
});
