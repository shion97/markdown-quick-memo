// @vitest-environment jsdom
import { history, undo, redo } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import { GFM } from "@lezer/markdown";
import { afterEach, describe, expect, it, vi } from "vitest";
import { markdownDecorations } from "./decorations";
import { markdownInputAssistance } from "./input-assistance";
import { tableEditing, runTableAction, selectTableCells, selectedTableText, pasteTable } from "./table-editing";
import { findTable } from "./tables";

const views: EditorView[] = [];
const source = "| 項目 | 値 |\n| --- | --- |\n| 名前 | 2 |\n| 別名 | 10 |";
function create(sourceText = source, position = sourceText.indexOf("項目"), readOnly = false): EditorView {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({ parent, state: EditorState.create({ doc: sourceText, selection: { anchor: position }, extensions: [
    markdown({ base: markdownLanguage, extensions: [GFM] }), history(),
    tableEditing({ onInsertTable: vi.fn() }), markdownInputAssistance(), markdownDecorations,
    EditorState.readOnly.of(readOnly),
  ] }) });
  views.push(view);
  return view;
}
function press(view: EditorView, key: string, shiftKey = false): boolean {
  return runScopeHandlers(view, new KeyboardEvent("keydown", { key, shiftKey }), "editor");
}
afterEach(() => { views.splice(0).forEach(view => view.destroy()); document.body.replaceChildren(); });

describe("表の編集", () => {
  it("Tabで区切り線を飛ばし、末尾では行を追加する。1回のUndoで戻せる", () => {
    const view = create();
    press(view, "Tab");
    expect(view.state.selection.main.head).toBe(source.indexOf("値"));
    press(view, "Tab");
    expect(view.state.selection.main.head).toBe(source.indexOf("名前"));
    expect(view.state.doc.toString()).toBe(source);
    view.dispatch({ selection: { anchor: source.indexOf("10") } });
    press(view, "Tab");
    expect(findTable(view.state, 0)?.rows).toHaveLength(4);
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(source);
    expect(redo(view)).toBe(true);
    expect(findTable(view.state, 0)?.rows).toHaveLength(4);
  });

  it("先頭のShift+Tabは留まり、Enterは下の同じ列へ移動する", () => {
    const view = create();
    press(view, "Tab", true);
    expect(view.state.selection.main.head).toBe(source.indexOf("項目"));
    view.dispatch({ selection: { anchor: source.indexOf("値") } });
    press(view, "Enter");
    expect(view.state.selection.main.head).toBe(source.indexOf("2"));
    press(view, "Enter");
    expect(view.state.selection.main.head).toBe(source.indexOf("10"));
  });

  it("Shift+Enterはbrを保存し、Escで本文へ抜ける", () => {
    const view = create();
    press(view, "Enter", true);
    expect(view.state.doc.toString()).toContain("| <br>項目 | 値 |");
    expect(view.dom.querySelectorAll(".mqm-table-cell br")).toHaveLength(1);
    press(view, "Escape");
    expect(view.state.doc.lineAt(view.state.selection.main.head).text).toBe("");
    expect(view.state.selection.main.head).toBe(view.state.doc.length);
  });

  it("列移動は整列も移動し、行並べ替えは見出しを固定した自然順にする", () => {
    const view = create();
    runTableAction(view, "align-right", { row: 0, column: 1 });
    runTableAction(view, "column-left", { row: 0, column: 1 });
    expect(findTable(view.state, 0)?.alignments).toEqual(["right", "left"]);
    runTableAction(view, "sort-desc", { row: 1, column: 0 });
    expect(findTable(view.state, 0)?.rows.map(row => row.cells[0]?.text)).toEqual(["値", "10", "2"]);
  });

  it("見出しの移動・削除を禁止し、不足セルを補って追加する", () => {
    const view = create("| a | b |\n| -- | -- |\n| x | y | z |\n| q |", 2);
    expect(runTableAction(view, "row-delete", { row: 0, column: 0 })).toBe(false);
    expect(runTableAction(view, "row-before", { row: 0, column: 0 })).toBe(false);
    expect(runTableAction(view, "row-down", { row: 0, column: 0 })).toBe(false);
    runTableAction(view, "column-after", { row: 0, column: 1 });
    const table = findTable(view.state, 0)!;
    expect(table.columns).toBe(4);
    expect(table.rows.map(row => row.cells.length)).toEqual([4, 4, 4]);
    expect(table.rows[1]?.cells[3]?.text).toBe("z");
  });

  it("矩形選択をTSVコピーし、内容だけ消してUndoで復元する", () => {
    const view = create("| a | b |\n| --- | --- |\n| x<br>y | **z** |", 2);
    selectTableCells(view, { row: 0, column: 0 }, { row: 1, column: 1 });
    expect(selectedTableText(view.state)).toBe('a\tb\n"x\ny"\t**z**');
    press(view, "Backspace");
    expect(findTable(view.state, 0)?.rows.flatMap(row => row.cells.map(cell => cell.text))).toEqual(["", "", "", ""]);
    undo(view);
    expect(view.state.doc.toString()).toContain("**z**");
  });

  it("貼り付けで不足行・列を追加し、パイプを安全に保存する", () => {
    const view = create();
    view.dispatch({ selection: { anchor: source.indexOf("10") } });
    expect(pasteTable(view, [["p|q", "次"], ["a\nb", "最後"]])).toBe(true);
    const table = findTable(view.state, 0)!;
    expect(table.columns).toBe(3);
    expect(table.rows[2]?.cells[1]?.text).toBe("p\\|q");
    expect(table.rows[3]?.cells[1]?.text).toBe("a<br>b");
    undo(view);
    expect(view.state.doc.toString()).toBe(source);
  });

  it("表外に貼り付けると独立した表を作る", () => {
    const view = create("前後", 1);
    pasteTable(view, [["a", "b"], ["c", "d"]]);
    expect(view.state.doc.toString()).toBe("前\n\n| a | b |\n| --- | --- |\n| c | d |\n\n後");
  });

  it("閲覧モードではコピーでき、変更・行追加・貼り付けを禁止する", () => {
    const view = create(source, 2, true);
    selectTableCells(view, { row: 0, column: 0 }, { row: 0, column: 1 });
    expect(selectedTableText(view.state)).toBe("項目\t値");
    expect(runTableAction(view, "column-delete", { row: 0, column: 0 })).toBe(false);
    expect(pasteTable(view, [["x", "y"]])).toBe(false);
    press(view, "Delete");
    expect(view.state.doc.toString()).toBe(source);
  });

  it("最後の列の削除は表全体を削除する", () => {
    const view = create("| a |\n| -- |\n| b |", 2);
    runTableAction(view, "column-delete", { row: 0, column: 0 });
    expect(view.state.doc.toString()).toBe("");
    undo(view);
    expect(view.state.doc.toString()).toBe("| a |\n| -- |\n| b |");
  });

  it("Shift+クリックとShift+矢印で矩形選択し、Escは選択だけ解除する", () => {
    const view = create();
    const cell = view.dom.querySelector<HTMLElement>('[data-table-cell="1:1"]')!;
    cell.dispatchEvent(new MouseEvent("mousedown", { button: 0, shiftKey: true, bubbles: true, cancelable: true }));
    expect(selectedTableText(view.state)).toBe("項目\t値\n名前\t2");
    expect(view.dom.querySelectorAll(".mqm-table-cell-selected")).toHaveLength(4);
    press(view, "ArrowDown", true);
    expect(selectedTableText(view.state)).toContain("別名\t10");
    press(view, "Escape");
    expect(selectedTableText(view.state)).toBeNull();
    expect(view.state.doc.toString()).toBe(source);
  });

  it("右クリックしたセルを操作対象にし、境界操作を無効にする", () => {
    const view = create();
    view.dom.querySelector<HTMLElement>('[data-table-cell="0:0"]')!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    const buttons = [...menu.querySelectorAll<HTMLButtonElement>("button")];
    expect(buttons.find(button => button.textContent === "行を削除")?.disabled).toBe(true);
    buttons.find(button => button.textContent === "列を右に挿入")!.click();
    expect(findTable(view.state, 0)?.columns).toBe(3);
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it("HTML表の貼り付けでは文字と改行だけを保存する", () => {
    const view = create();
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { getData: (type: string) => type === "text/html" ? '<table><tr><td>a<br>b<script>alert(1)</script></td><td><img src=x onerror=alert(1)>安全</td></tr></table>' : "a\tb" } });
    view.contentDOM.dispatchEvent(event);
    expect(findTable(view.state, 0)?.rows[0]?.cells.map(cell => cell.text)).toEqual(["a<br>b", "安全"]);
    expect(view.dom.querySelector("script, img[src]")).toBeNull();
  });

  it("行の挿入・移動・削除、列の挿入・移動・削除をUndoで戻せる", () => {
    const view = create();
    for (const action of ["row-before", "row-after", "row-up", "row-down", "row-delete", "column-before", "column-after", "column-left", "column-right", "column-delete", "align-center", "align-left"] as const) {
      expect(runTableAction(view, action, { row: action === "row-down" ? 1 : 2, column: action === "column-right" ? 0 : 1 }), action).toBe(true);
      undo(view);
      expect(view.state.doc.toString()).toBe(source);
    }
  });

  it("並べ替えで同値の行の順序を保持する", () => {
    const view = create("| 名前 | 値 |\n| --- | --- |\n| A | 2 |\n| B | 10 |\n| C | 2 |", 2);
    runTableAction(view, "sort-asc", { row: 0, column: 1 });
    expect(findTable(view.state, 0)?.rows.slice(1).map(row => row.cells[0]?.text)).toEqual(["A", "C", "B"]);
  });

  it("矩形選択は他のエディターへ混ざらず、通常の文字選択で解除される", () => {
    const first = create();
    const second = create();
    selectTableCells(first, { row: 0, column: 0 }, { row: 1, column: 1 });
    expect(selectedTableText(second.state)).toBeNull();
    first.dispatch({ selection: { anchor: 2, head: 4 } });
    expect(selectedTableText(first.state)).toBeNull();
  });

  it("手入力のパイプは補助するが、既にエスケープしたパイプは重ねない", () => {
    for (const prefix of ["名前", "名前\\"]) {
      const text = `| ${prefix} |\n| --- |`;
      const view = create(text, 2 + prefix.length);
      const selection = view.state.selection.main;
      const handled = view.state.facet(EditorView.inputHandler).some(handler => handler(view, selection.from, selection.to, "|", () => view.state.update({ changes: { from: selection.from, insert: "|" } })));
      if (!handled) view.dispatch({ changes: { from: selection.from, insert: "|" } });
      expect(findTable(view.state, 0)?.columns).toBe(1);
      expect(findTable(view.state, 0)?.rows[0]?.cells[0]?.text).toBe("名前\\|");
    }
  });
});
