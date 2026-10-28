import { isolateHistory } from "@codemirror/commands";
import { EditorState, Prec, StateEffect, StateField, findClusterBreak, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, keymap, type ViewUpdate } from "@codemirror/view";
import { clipboardCellText, findTable, markdownCellText, readClipboardTable, serializeTable, tableMatrix, tableMathRanges, tableRowRanges, type MarkdownTable, type TableAlignment, type TableCellRange } from "./tables";

export interface CellCoordinate { row: number; column: number }
interface TableInteraction {
  tableFrom: number;
  anchor: CellCoordinate;
  head: CellCoordinate;
  selected: boolean;
}
export const tableInteractionEffect = StateEffect.define<TableInteraction | null>();
export const tableInteraction = StateField.define<TableInteraction | null>({
  create: () => null,
  update(value, transaction) {
    if (transaction.docChanged || transaction.selection || transaction.reconfigured) value = null;
    for (const effect of transaction.effects) if (effect.is(tableInteractionEffect)) value = effect.value;
    return value;
  },
});

function bounds(interaction: TableInteraction): { top: number; bottom: number; left: number; right: number } {
  return {
    top: Math.min(interaction.anchor.row, interaction.head.row), bottom: Math.max(interaction.anchor.row, interaction.head.row),
    left: Math.min(interaction.anchor.column, interaction.head.column), right: Math.max(interaction.anchor.column, interaction.head.column),
  };
}

export function tableCellSelected(state: EditorState, tableFrom: number, row: number, column: number): boolean {
  const interaction = state.field(tableInteraction, false);
  if (!interaction?.selected || interaction.tableFrom !== tableFrom) return false;
  const area = bounds(interaction);
  return row >= area.top && row <= area.bottom && column >= area.left && column <= area.right;
}

function coordinateAt(table: MarkdownTable, position: number): CellCoordinate {
  const row = Math.max(0, table.rows.findIndex(candidate => position >= candidate.line.from && position <= candidate.line.to));
  const cells = table.rows[row]!.cells;
  const next = cells.findIndex(cell => position <= cell.to);
  return { row, column: next >= 0 ? next : Math.max(0, cells.length - 1) };
}

function context(view: EditorView): { table: MarkdownTable; cell: CellCoordinate } | null {
  const interaction = view.state.field(tableInteraction, false);
  const table = findTable(view.state, interaction?.tableFrom ?? view.state.selection.main.head);
  if (!table) return null;
  return { table, cell: interaction?.tableFrom === table.from ? interaction.head : coordinateAt(table, view.state.selection.main.head) };
}

function clampCell(table: MarkdownTable, cell: CellCoordinate): CellCoordinate {
  return { row: Math.max(0, Math.min(table.rows.length - 1, cell.row)), column: Math.max(0, Math.min(table.columns - 1, cell.column)) };
}

function cellPosition(table: MarkdownTable, cell: CellCoordinate): number {
  return table.rows[cell.row]!.cells[cell.column]?.from ?? table.rows[cell.row]!.line.to;
}

function moveTo(view: EditorView, table: MarkdownTable, cell: CellCoordinate, selected = false, anchor = cell): void {
  const target = clampCell(table, cell);
  view.dispatch({ selection: { anchor: cellPosition(table, target) },
    effects: tableInteractionEffect.of({ tableFrom: table.from, head: target, anchor, selected }), scrollIntoView: true, userEvent: "select" });
}

export function selectTableCells(view: EditorView, anchor: CellCoordinate, head = anchor): boolean {
  const current = context(view);
  if (!current) return false;
  moveTo(view, current.table, head, true, clampCell(current.table, anchor));
  return true;
}

export function selectedTableText(state: EditorState): string | null {
  const interaction = state.field(tableInteraction, false);
  if (!interaction?.selected) return null;
  const table = findTable(state, interaction.tableFrom);
  if (!table) return null;
  const area = bounds(interaction);
  return tableMatrix(table).slice(area.top, area.bottom + 1).map(row => row.slice(area.left, area.right + 1).map(text => {
    const content = clipboardCellText(text);
    return /[\t\r\n"]/.test(content) ? `"${content.replace(/"/g, '""')}"` : content;
  }).join("\t")).join("\n");
}

function replaceTable(view: EditorView, table: MarkdownTable, rows: string[][], alignments: TableAlignment[], target: CellCoordinate, keepSelection = false): void {
  const source = serializeTable(rows, alignments);
  const local = EditorState.create({ doc: source });
  const line = local.doc.line(target.row === 0 ? 1 : target.row + 2);
  const position = tableRowRanges(line).cells[target.column]?.from ?? line.to;
  const interaction = view.state.field(tableInteraction, false);
  view.dispatch({ changes: { from: table.from, to: table.to, insert: source }, selection: { anchor: table.from + position },
    effects: tableInteractionEffect.of(keepSelection && interaction ? interaction : { tableFrom: table.from, anchor: target, head: target, selected: false }),
    annotations: isolateHistory.of("full"), userEvent: "input.table" });
}

function navigate(view: EditorView, direction: "next" | "previous" | "down"): boolean {
  if (view.composing) return false;
  const current = context(view);
  if (!current) return false;
  const { table, cell } = current;
  let row = cell.row;
  let column = cell.column;
  if (direction === "down") row += 1;
  else if (direction === "next") { column += 1; if (column >= table.columns) { column = 0; row += 1; } }
  else { column -= 1; if (column < 0) { column = table.columns - 1; row -= 1; } }
  if (row < 0) { moveTo(view, table, { row: 0, column: 0 }); return true; }
  if (row >= table.rows.length) {
    if (direction === "down") return exitTable(view, false);
    if (view.state.readOnly) return true;
    const rows = tableMatrix(table);
    rows.push(Array.from({ length: table.columns }, () => ""));
    replaceTable(view, table, rows, table.alignments, { row, column });
  } else moveTo(view, table, { row, column });
  return true;
}

function lineBreak(view: EditorView): boolean {
  if (view.composing) return false;
  const current = context(view);
  if (!current) return false;
  if (view.state.readOnly) return true;
  const selection = view.state.selection.main;
  const { table, cell } = current;
  const existing = table.rows[cell.row]!.cells[cell.column];
  if (!existing) {
    const rows = tableMatrix(table);
    rows[cell.row]![cell.column] = "<br>";
    replaceTable(view, table, rows, table.alignments, cell);
    return true;
  }
  if (selection.from < existing.from || selection.to > existing.to) return false;
  view.dispatch({ changes: { from: selection.from, to: selection.to, insert: "<br>" }, selection: { anchor: selection.from + 4 },
    annotations: isolateHistory.of("full"), userEvent: "input.table" });
  return true;
}

function exitTable(view: EditorView, deselectOnly = true): boolean {
  if (view.composing) return false;
  const current = context(view);
  if (!current) return false;
  if (deselectOnly && view.state.field(tableInteraction, false)?.selected) {
    moveTo(view, current.table, current.cell);
    return true;
  }
  const { table } = current;
  const nextLine = view.state.doc.lineAt(table.to).number + 1;
  if (nextLine <= view.state.doc.lines && view.state.doc.line(nextLine).text === "") {
    view.dispatch({ selection: { anchor: view.state.doc.line(nextLine).from }, effects: tableInteractionEffect.of(null), scrollIntoView: true });
  } else if (!view.state.readOnly) {
    const insert = table.to === view.state.doc.length ? "\n\n" : "\n";
    view.dispatch({ changes: { from: table.to, insert }, selection: { anchor: table.to + insert.length }, effects: tableInteractionEffect.of(null),
      annotations: isolateHistory.of("full"), userEvent: "input.table", scrollIntoView: true });
  } else view.dispatch({ selection: { anchor: Math.min(view.state.doc.length, table.to + 1) }, effects: tableInteractionEffect.of(null) });
  return true;
}

function extendSelection(view: EditorView, rowOffset: number, columnOffset: number): boolean {
  if (view.composing) return false;
  const interaction = view.state.field(tableInteraction, false);
  const current = context(view);
  if (!current || !interaction?.selected) return false;
  moveTo(view, current.table, { row: interaction.head.row + rowOffset, column: interaction.head.column + columnOffset }, true, interaction.anchor);
  return true;
}

function clearCells(view: EditorView): boolean {
  if (view.composing) return false;
  const interaction = view.state.field(tableInteraction, false);
  const current = context(view);
  if (!current || !interaction?.selected) return false;
  if (view.state.readOnly) return true;
  const rows = tableMatrix(current.table);
  const area = bounds(interaction);
  for (let row = area.top; row <= area.bottom; row += 1) for (let column = area.left; column <= area.right; column += 1) rows[row]![column] = "";
  replaceTable(view, current.table, rows, current.table.alignments, interaction.head, true);
  return true;
}

function cellDeletion(cell: TableCellRange, from: number, to: number) {
  let start = from - cell.from;
  let end = to - cell.from;
  // An escaped pipe must stay escaped or be deleted with its escape.
  for (const match of cell.text.matchAll(/\\+\|/g)) {
    const pipe = match.index + match[0].length - 1;
    if ((match[0].length - 1) % 2 === 1 && start < pipe + 1 && end > pipe - 1) {
      start = Math.min(start, pipe - 1);
      end = Math.max(end, pipe + 1);
    }
  }
  const remaining = cell.text.slice(0, start) + cell.text.slice(end);
  const insert = markdownCellText(remaining);
  let cursorOffset = 0;
  for (let offset = 0; offset < start; offset += 1) {
    if (remaining[offset] === "|" && insert[cursorOffset] === "\\") cursorOffset += 1;
    cursorOffset += 1;
  }
  return { from: cell.from, to: cell.to, insert, cursor: cell.from + cursorOffset };
}

function deleteCellText(view: EditorView, forward: boolean): boolean {
  if (view.composing) return false;
  if (clearCells(view)) return true;
  const current = context(view);
  if (!current) return false;
  if (view.state.readOnly) return true;
  const { table, cell } = current;
  const selection = view.state.selection.main;
  if (selection.empty) {
    const existing = table.rows[cell.row]!.cells[cell.column];
    if (!existing || selection.head < existing.from || selection.head > existing.to) return true;
    const offset = selection.head - existing.from;
    const target = existing.from + findClusterBreak(existing.text, offset, forward, forward);
    if (target === selection.head) return true;
    const change = cellDeletion(existing, Math.min(target, selection.head), Math.max(target, selection.head));
    view.dispatch({ changes: change, selection: { anchor: change.cursor }, userEvent: forward ? "delete.forward" : "delete.backward" });
  } else {
    const changes = table.rows.flatMap(row => row.cells.flatMap(existing => {
      const from = Math.max(existing.from, selection.from), to = Math.min(existing.to, selection.to);
      return from < to ? [cellDeletion(existing, from, to)] : [];
    }));
    if (changes.length) view.dispatch({ changes, selection: { anchor: changes[0]!.cursor }, userEvent: "delete.selection" });
  }
  return true;
}

export type TableAction = "row-before" | "row-after" | "row-delete" | "row-up" | "row-down" |
  "column-before" | "column-after" | "column-delete" | "column-left" | "column-right" |
  "align-left" | "align-center" | "align-right" | "sort-asc" | "sort-desc" |
  "select-cell" | "select-row" | "select-column" | "select-table";

export function runTableAction(view: EditorView, action: TableAction, coordinate?: CellCoordinate): boolean {
  const current = context(view);
  if (!current || view.composing) return false;
  const { table } = current;
  const cell = clampCell(table, coordinate ?? current.cell);
  if (action.startsWith("select-")) {
    const anchor = { row: action === "select-column" || action === "select-table" ? 0 : cell.row,
      column: action === "select-row" || action === "select-table" ? 0 : cell.column };
    const head = { row: action === "select-column" || action === "select-table" ? table.rows.length - 1 : cell.row,
      column: action === "select-row" || action === "select-table" ? table.columns - 1 : cell.column };
    moveTo(view, table, head, true, anchor);
    return true;
  }
  if (view.state.readOnly) return false;
  const rows = tableMatrix(table);
  const alignments = [...table.alignments];
  const target = { ...cell };
  if (action === "row-before" || action === "row-after") {
    if (action === "row-before" && cell.row === 0) return false;
    target.row = Math.max(1, cell.row + (action === "row-after" ? 1 : 0));
    rows.splice(target.row, 0, Array.from({ length: table.columns }, () => ""));
  } else if (action === "row-delete") {
    if (cell.row === 0) return false;
    rows.splice(cell.row, 1);
    target.row = Math.min(cell.row, rows.length - 1);
  } else if (action === "row-up" || action === "row-down") {
    const destination = cell.row + (action === "row-up" ? -1 : 1);
    if (cell.row === 0 || destination < 1 || destination >= rows.length) return false;
    rows.splice(destination, 0, rows.splice(cell.row, 1)[0]!);
    target.row = destination;
  } else if (action === "column-before" || action === "column-after") {
    target.column = cell.column + (action === "column-after" ? 1 : 0);
    rows.forEach(row => row.splice(target.column, 0, ""));
    alignments.splice(target.column, 0, "left");
  } else if (action === "column-delete") {
    if (table.columns === 1) {
      view.dispatch({ changes: { from: table.from, to: table.to }, selection: { anchor: table.from }, effects: tableInteractionEffect.of(null), annotations: isolateHistory.of("full"), userEvent: "input.table" });
      return true;
    }
    rows.forEach(row => row.splice(cell.column, 1));
    alignments.splice(cell.column, 1);
    target.column = Math.min(cell.column, alignments.length - 1);
  } else if (action === "column-left" || action === "column-right") {
    const destination = cell.column + (action === "column-left" ? -1 : 1);
    if (destination < 0 || destination >= table.columns) return false;
    rows.forEach(row => row.splice(destination, 0, row.splice(cell.column, 1)[0]!));
    alignments.splice(destination, 0, alignments.splice(cell.column, 1)[0]!);
    target.column = destination;
  } else if (action.startsWith("align-")) alignments[cell.column] = action.slice(6) as TableAlignment;
  else {
    const compare = new Intl.Collator("ja", { numeric: true }).compare;
    const body = rows.slice(1).sort((first, second) => compare(first[cell.column]!, second[cell.column]!) * (action === "sort-desc" ? -1 : 1));
    rows.splice(1, rows.length - 1, ...body);
  }
  replaceTable(view, table, rows, alignments, target);
  return true;
}

export function pasteTable(view: EditorView, cells: string[][]): boolean {
  if (view.state.readOnly || view.composing || !cells.length || !cells.some(row => row.length)) return false;
  const current = context(view);
  if (current) {
    const interaction = view.state.field(tableInteraction, false);
    const area = interaction?.selected ? bounds(interaction) : null;
    const start = area ? { row: area.top, column: area.left } : current.cell;
    const rows = tableMatrix(current.table);
    const columns = Math.max(current.table.columns, start.column + Math.max(...cells.map(row => row.length)));
    while (rows.length < start.row + cells.length) rows.push([]);
    rows.forEach(row => { while (row.length < columns) row.push(""); });
    cells.forEach((row, rowIndex) => row.forEach((text, column) => { rows[start.row + rowIndex]![start.column + column] = markdownCellText(text); }));
    const alignments = Array.from({ length: columns }, (_, column) => current.table.alignments[column] ?? "left");
    replaceTable(view, current.table, rows, alignments, start);
  } else insertMarkdownTable(view, cells);
  return true;
}

export function insertMarkdownTable(view: EditorView, cells: string[][]): boolean {
  if (view.state.readOnly || view.composing) return false;
  const current = context(view);
  const selection = current ? { from: current.table.to, to: current.table.to } : view.state.selection.main;
  const before = view.state.doc.sliceString(0, selection.from);
  const after = view.state.doc.sliceString(selection.to);
  const prefix = before && !before.endsWith("\n\n") ? before.endsWith("\n") ? "\n" : "\n\n" : "";
  const suffix = after && !after.startsWith("\n\n") ? after.startsWith("\n") ? "\n" : "\n\n" : "";
  const source = serializeTable(cells.map(row => row.map(markdownCellText)));
  view.dispatch({ changes: { from: selection.from, to: selection.to, insert: prefix + source + suffix },
    selection: { anchor: selection.from + prefix.length + 2 }, annotations: isolateHistory.of("full"), userEvent: "input.table" });
  return true;
}

const menuActions: [TableAction, string][] = [
  ["row-before", "行を上に挿入"], ["row-after", "行を下に挿入"], ["row-delete", "行を削除"], ["row-up", "行を上へ移動"], ["row-down", "行を下へ移動"],
  ["column-before", "列を左に挿入"], ["column-after", "列を右に挿入"], ["column-delete", "列を削除"], ["column-left", "列を左へ移動"], ["column-right", "列を右へ移動"],
  ["align-left", "左寄せ"], ["align-center", "中央寄せ"], ["align-right", "右寄せ"], ["sort-asc", "この列で昇順に並べ替え"], ["sort-desc", "この列で降順に並べ替え"],
  ["select-cell", "セルを選択"], ["select-row", "行を選択"], ["select-column", "列を選択"], ["select-table", "表全体を選択"],
];

interface TableCallbacks { onInsertTable: () => void }
export function tableEditing(callbacks: TableCallbacks): Extension {
  return [tableInteraction, Prec.highest(keymap.of([
    { key: "Tab", run: view => navigate(view, "next") }, { key: "Shift-Tab", run: view => navigate(view, "previous") },
    { key: "Enter", run: view => navigate(view, "down") }, { key: "ArrowDown", run: view => navigate(view, "down") },
    { key: "Shift-Enter", run: lineBreak }, { key: "Escape", run: view => exitTable(view) },
    { key: "Shift-ArrowUp", run: view => extendSelection(view, -1, 0) }, { key: "Shift-ArrowDown", run: view => extendSelection(view, 1, 0) },
    { key: "Shift-ArrowLeft", run: view => extendSelection(view, 0, -1) }, { key: "Shift-ArrowRight", run: view => extendSelection(view, 0, 1) },
    { key: "Delete", run: view => deleteCellText(view, true) }, { key: "Backspace", run: view => deleteCellText(view, false) },
  ])), ViewPlugin.fromClass(class {
    private menu: HTMLElement | null = null;
    private menuParent: HTMLElement | null = null;
    private submenu: HTMLElement | null = null;
    private submenuButton: HTMLButtonElement | null = null;
    constructor(private view: EditorView) { document.addEventListener("mousedown", this.outside); }
    private outside = (event: MouseEvent) => { if (this.menu && event.target instanceof Node && !this.menu.contains(event.target)) this.close(); };
    private closeSubmenu(): void {
      this.submenu?.remove();
      this.submenu = null;
      this.submenuButton?.setAttribute("aria-expanded", "false");
      this.submenuButton = null;
    }
    close(): void { this.closeSubmenu(); this.menu?.remove(); this.menu = null; this.menuParent?.classList.remove("table-menu-open"); this.menuParent = null; }
    update(update: ViewUpdate): void {
      if (update.docChanged || update.selectionSet || update.startState.readOnly !== update.state.readOnly) this.close();
    }
    destroy(): void { this.close(); document.removeEventListener("mousedown", this.outside); }
    private locate(event: MouseEvent): { table: MarkdownTable; cell: CellCoordinate } | null {
      const element = event.target instanceof globalThis.Element ? event.target.closest<HTMLElement>("[data-table-cell]") : null;
      if (element) {
        const table = findTable(this.view.state, Number(element.dataset.tableFrom));
        const [row, column] = element.dataset.tableCell!.split(":").map(Number);
        if (table && row !== undefined && column !== undefined) return { table, cell: clampCell(table, { row, column }) };
      }
      const position = this.view.posAtCoords({ x: event.clientX, y: event.clientY });
      const table = position === null ? null : findTable(this.view.state, position);
      return table && position !== null ? { table, cell: coordinateAt(table, position) } : null;
    }
    mousedown(event: MouseEvent): boolean {
      if (event.target instanceof Node && this.menu?.contains(event.target)) return false;
      if (event.button !== 0 || event.ctrlKey || event.metaKey || this.view.composing) return false;
      const target = this.locate(event);
      if (!target) { this.view.dispatch({ effects: tableInteractionEffect.of(null) }); return false; }
      const current = context(this.view);
      if (event.shiftKey && current?.table.from === target.table.from) {
        const anchor = this.view.state.field(tableInteraction, false)?.anchor ?? current.cell;
        moveTo(this.view, target.table, target.cell, true, anchor);
        this.view.focus();
        return true;
      }
      this.view.dispatch({ effects: tableInteractionEffect.of(null) });
      const cell = target.table.rows[target.cell.row]!.cells[target.cell.column];
      if (!cell || !cell.text) { moveTo(this.view, target.table, target.cell); this.view.focus(); return true; }
      return false;
    }
    contextmenu(event: MouseEvent): boolean {
      if (this.view.composing) return false;
      this.close();
      const target = this.locate(event);
      if (!target && this.view.state.readOnly) return false;
      if (target) {
        const interaction = this.view.state.field(tableInteraction, false);
        if (!interaction?.selected || !tableCellSelected(this.view.state, target.table.from, target.cell.row, target.cell.column)) moveTo(this.view, target.table, target.cell);
      } else {
        const position = this.view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (position !== null) this.view.dispatch({ selection: { anchor: position }, effects: tableInteractionEffect.of(null) });
      }
      const menu = document.createElement("div");
      menu.className = "popover mqm-table-menu";
      menu.setAttribute("role", "menu");
      menu.setAttribute("aria-label", "表の操作");
      const addButton = (parent: HTMLElement, label: string, run: () => void, disabled = false, closesMenu = true): HTMLButtonElement => {
        const button = document.createElement("button");
        button.type = "button"; button.textContent = label; button.disabled = disabled; button.setAttribute("role", "menuitem");
        button.addEventListener("click", () => {
          if (closesMenu) { this.close(); run(); this.view.focus(); }
          else run();
        });
        parent.append(button);
        return button;
      };
      const addAction = (parent: HTMLElement, action: TableAction, label: string) => {
        if (!target) return;
        const { row, column } = target.cell;
        const disabled = (!action.startsWith("select-") && this.view.state.readOnly) ||
          ((action === "row-delete" || action === "row-up" || action === "row-down") && row === 0) ||
          (action === "row-before" && row === 0) ||
          (action === "row-up" && row <= 1) || (action === "row-down" && row >= target.table.rows.length - 1) ||
          (action === "column-left" && column === 0) || (action === "column-right" && column === target.table.columns - 1);
        addButton(parent, label, () => { runTableAction(this.view, action, target.cell); }, disabled);
      };
      if (target) {
        for (const [group, label] of [["row", "行"], ["column", "列"]] as const) {
          const button = addButton(menu, label, () => {
            const alreadyOpen = this.submenuButton === button;
            this.closeSubmenu();
            if (alreadyOpen) { button.focus(); return; }
            const submenu = document.createElement("div");
            submenu.className = "popover mqm-table-menu mqm-table-submenu";
            submenu.setAttribute("role", "menu");
            submenu.setAttribute("aria-label", `${label}の操作`);
            for (const [action, actionLabel] of menuActions) {
              if (action.startsWith(`${group}-`) || action === `select-${group}` || (group === "column" && action.startsWith("sort-"))) addAction(submenu, action, actionLabel);
            }
            const alignmentLabel = document.createElement("div");
            alignmentLabel.className = "mqm-table-menu-label";
            alignmentLabel.textContent = "アライメント";
            submenu.append(alignmentLabel);
            for (const [action, actionLabel] of menuActions) if (action.startsWith("align-")) addAction(submenu, action, actionLabel);
            menu.append(submenu);
            this.submenu = submenu;
            this.submenuButton = button;
            button.setAttribute("aria-expanded", "true");
            const parentRect = menu.getBoundingClientRect();
            const buttonRect = button.getBoundingClientRect();
            const childRect = submenu.getBoundingClientRect();
            const left = parentRect.right + childRect.width <= window.innerWidth ? parentRect.right : parentRect.left - childRect.width;
            submenu.style.left = `${Math.max(0, Math.min(left, window.innerWidth - childRect.width))}px`;
            submenu.style.top = `${Math.max(0, Math.min(buttonRect.top, window.innerHeight - childRect.height))}px`;
            submenu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
          }, false, false);
          button.dataset.tableMenuGroup = group;
          button.setAttribute("aria-haspopup", "menu");
          button.setAttribute("aria-expanded", "false");
          const arrow = document.createElement("span");
          arrow.textContent = "›";
          arrow.setAttribute("aria-hidden", "true");
          button.append(arrow);
        }
        for (const [action, label] of menuActions) if (action === "select-cell" || action === "select-table") addAction(menu, action, label);
      }
      else addButton(menu, "表を挿入", callbacks.onInsertTable);
      menu.addEventListener("keydown", event => {
        const activeMenu = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('[role="menu"]') ?? menu : menu;
        const buttons = [...activeMenu.querySelectorAll<HTMLButtonElement>(":scope > button:not(:disabled)")];
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if ((event.key === "Escape" || event.key === "ArrowLeft") && this.submenu) {
          event.preventDefault(); event.stopPropagation();
          const parentButton = this.submenuButton;
          this.closeSubmenu(); parentButton?.focus();
        } else if (event.key === "ArrowRight" && document.activeElement instanceof HTMLButtonElement && document.activeElement.dataset.tableMenuGroup) {
          event.preventDefault(); event.stopPropagation();
          if (this.submenuButton !== document.activeElement) document.activeElement.click();
        } else if (event.key === "Escape" || event.key === "Tab") { event.preventDefault(); event.stopPropagation(); this.close(); this.view.focus(); }
        else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault(); event.stopPropagation(); buttons[(index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
        }
      });
      this.view.dom.append(menu);
      this.menu = menu;
      this.menuParent = this.view.dom;
      this.menuParent.classList.add("table-menu-open");
      const rect = menu.getBoundingClientRect();
      menu.style.left = `${Math.max(0, Math.min(event.clientX, window.innerWidth - rect.width))}px`;
      menu.style.top = `${Math.max(0, Math.min(event.clientY, window.innerHeight - rect.height))}px`;
      menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
      return true;
    }
  }, { eventHandlers: {
    mousedown(event) { return this.mousedown(event); }, contextmenu(event) { return this.contextmenu(event); },
    paste(event, view) {
      if (view.state.readOnly || view.composing) return false;
      const text = event.clipboardData?.getData("text/plain") ?? "";
      let cells = readClipboardTable(text, event.clipboardData?.getData("text/html") ?? "");
      const current = context(view);
      if (!cells && current && text && (view.state.field(tableInteraction, false)?.selected || !current.table.rows[current.cell.row]!.cells[current.cell.column])) cells = [[text]];
      return cells !== null && pasteTable(view, cells);
    },
    keydown(event, view) {
      if (event.isComposing || view.composing) return false;
      if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && view.state.field(tableInteraction, false)?.selected) {
        const current = context(view)!;
        moveTo(view, current.table, current.cell);
      }
      return false;
    },
  } }), EditorView.inputHandler.of((view, from, to, text) => {
    if (view.composing || view.state.readOnly || view.state.selection.ranges.length !== 1) return false;
    const current = context(view);
    if (!current) return false;
    const existing = current.table.rows[current.cell.row]!.cells[current.cell.column];
    if (existing) {
      if (from < existing.from || to > existing.to) return false;
      const row = current.table.rows[current.cell.row]!.line;
      if (tableMathRanges(row.text, row.from).some(range => from > range.from && from < range.to)) return false;
      const precedingBackslashes = /\\+$/.exec(view.state.doc.sliceString(existing.from, from))?.[0].length ?? 0;
      if (text === "|" && precedingBackslashes % 2 === 1) return false;
      const insert = markdownCellText(text);
      if (insert === text) return false;
      view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length }, userEvent: "input" });
      return true;
    }
    const rows = tableMatrix(current.table);
    rows[current.cell.row]![current.cell.column] = markdownCellText(text);
    replaceTable(view, current.table, rows, current.table.alignments, current.cell);
    const table = findTable(view.state, current.table.from)!;
    view.dispatch({ selection: { anchor: table.rows[current.cell.row]!.cells[current.cell.column]!.to } });
    return true;
  })];
}
