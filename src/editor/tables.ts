import { syntaxTree } from "@codemirror/language";
import { type EditorState, type Line } from "@codemirror/state";
import { findMathRanges } from "./math";

export type TableAlignment = "left" | "center" | "right";
export interface TableCellRange {
  from: number;
  to: number;
  segmentFrom: number;
  segmentTo: number;
  text: string;
}
export interface MarkdownTable {
  from: number;
  to: number;
  rows: { line: Line; cells: TableCellRange[] }[];
  separator: Line;
  columns: number;
  alignments: TableAlignment[];
}

function escapedAt(text: string, position: number): boolean {
  let backslashes = 0;
  for (let cursor = position - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

function codeRanges(text: string): { from: number; to: number }[] {
  const ranges: { from: number; to: number }[] = [];
  const runs = [...text.matchAll(/`+/g)];
  for (let index = 0; index < runs.length; index += 1) {
    const opening = runs[index]!;
    if (escapedAt(text, opening.index)) continue;
    const closingIndex = runs.findIndex((run, candidate) => candidate > index && run[0].length === opening[0].length);
    if (closingIndex >= 0) {
      const closing = runs[closingIndex]!;
      ranges.push({ from: opening.index, to: closing.index + closing[0].length });
      index = closingIndex;
    }
  }
  return ranges;
}

export function tableMathRanges(text: string, offset = 0) {
  const protectedCodes = codeRanges(text).map(range => ({ from: range.from + offset, to: range.to + offset }));
  return findMathRanges(text, offset, protectedCodes);
}

export function tableBreakRanges(text: string): { from: number; to: number }[] {
  const codes = codeRanges(text);
  const protectedRanges = [...codes, ...findMathRanges(text, 0, codes)];
  return [...text.matchAll(/<br\s*\/?\s*>/gi)]
    .filter(match => !escapedAt(text, match.index) && !protectedRanges.some(range => match.index >= range.from && match.index < range.to))
    .map(match => ({ from: match.index, to: match.index + match[0].length }));
}

export function tableRowRanges(line: { from: number; to: number; text: string }): { cells: TableCellRange[]; separators: number[] } {
  const math = tableMathRanges(line.text);
  const separators: number[] = [];
  for (let index = 0; index < line.text.length; index += 1) {
    if (line.text[index] === "|" && !escapedAt(line.text, index) && !math.some(range => index >= range.from && index < range.to)) separators.push(index);
  }
  const leadingPipe = separators[0] !== undefined && line.text.slice(0, separators[0]).trim() === "";
  const lastSeparator = separators.at(-1);
  const trailingPipe = lastSeparator !== undefined && line.text.slice(lastSeparator + 1).trim() === "" && (separators.length > 1 || !leadingPipe);
  const boundaries = [-1, ...separators, line.text.length];
  const segments = boundaries.slice(0, -1).map((boundary, index) => ({ from: boundary + 1, to: boundaries[index + 1]! }));
  if (leadingPipe) segments.shift();
  if (trailingPipe) segments.pop();
  return {
    separators: separators.map(position => line.from + position),
    cells: segments.map(segment => {
      const raw = line.text.slice(segment.from, segment.to);
      const leading = raw.match(/^[ \t]*/)?.[0].length ?? 0;
      const content = raw.replace(/^[ \t]+/, "").replace(/[ \t]+$/, "");
      const from = line.from + segment.from + leading;
      return { from, to: from + content.length, segmentFrom: line.from + segment.from, segmentTo: line.from + segment.to, text: content };
    }),
  };
}

function codeBlockAt(state: EditorState, position: number): boolean {
  let node = syntaxTree(state).resolveInner(position, 1);
  while (node) {
    if (node.name === "FencedCode" || node.name === "CodeBlock") return true;
    if (!node.parent) break;
    node = node.parent;
  }
  return false;
}

export function tableFromLine(state: EditorState, lineNumber: number): MarkdownTable | null {
  if (lineNumber < 1 || lineNumber >= state.doc.lines) return null;
  const heading = state.doc.line(lineNumber);
  const separator = state.doc.line(lineNumber + 1);
  if (!heading.text.includes("|") || !separator.text.includes("|")) return null;
  const delimiterCells = tableRowRanges(separator).cells;
  if (!delimiterCells.length || !delimiterCells.every(cell => /^:?-{2,}:?$/.test(cell.text))) return null;
  if (codeBlockAt(state, heading.from)) return null;
  const protectedCodes = codeRanges(state.doc.toString());
  syntaxTree(state).iterate({ enter: node => {
    if (node.name === "FencedCode" || node.name === "CodeBlock") {
      protectedCodes.push({ from: node.from, to: node.to });
      return false;
    }
  } });
  if (findMathRanges(state.doc.toString(), 0, protectedCodes).some(range => range.display && range.from <= heading.from && range.to >= separator.to)) return null;
  const rows = [{ line: heading, cells: tableRowRanges(heading).cells }];
  let to = separator.to;
  for (let next = lineNumber + 2; next <= state.doc.lines; next += 1) {
    const line = state.doc.line(next);
    if (!line.text.includes("|") || !line.text.trim() || codeBlockAt(state, line.from)) break;
    rows.push({ line, cells: tableRowRanges(line).cells });
    to = line.to;
  }
  const columns = Math.max(delimiterCells.length, ...rows.map(row => row.cells.length));
  const alignments = Array.from({ length: columns }, (_, column): TableAlignment => {
    const delimiter = delimiterCells[column]?.text ?? "---";
    return delimiter.startsWith(":") && delimiter.endsWith(":") ? "center" : delimiter.endsWith(":") ? "right" : "left";
  });
  return { from: heading.from, to, rows, separator, columns, alignments };
}

export function findTable(state: EditorState, position: number): MarkdownTable | null {
  const current = state.doc.lineAt(position).number;
  for (let start = current; start >= 1; start -= 1) {
    if (!state.doc.line(start).text.includes("|")) break;
    const table = tableFromLine(state, start);
    if (table && position >= table.from && position <= table.to) return table;
  }
  return null;
}

export function tableMatrix(table: MarkdownTable): string[][] {
  return table.rows.map(row => Array.from({ length: table.columns }, (_, column) => row.cells[column]?.text ?? ""));
}

export function serializeTable(rows: readonly string[][], alignments: readonly TableAlignment[] = []): string {
  const columns = Math.max(1, alignments.length, ...rows.map(row => row.length));
  const rowText = (row: readonly string[]) => `| ${Array.from({ length: columns }, (_, column) => row[column] ?? "").join(" | ")} |`;
  const delimiters = Array.from({ length: columns }, (_, column) => alignments[column] === "center" ? ":---:" : alignments[column] === "right" ? "---:" : "---");
  return [rowText(rows[0] ?? []), rowText(delimiters), ...rows.slice(1).map(rowText)].join("\n");
}

export function clipboardCellText(text: string): string {
  let result = text;
  for (const range of tableBreakRanges(text).reverse()) result = result.slice(0, range.from) + "\n" + result.slice(range.to);
  return result;
}

export function markdownCellText(text: string): string {
  const normalized = text.replace(/\r\n?/g, "\n").replace(/\n/g, "<br>").replace(/\t/g, " ");
  const math = tableMathRanges(normalized);
  return normalized.replace(/\|/g, (character, index: number) => !escapedAt(normalized, index) && !math.some(range => index >= range.from && index < range.to) ? "\\|" : character);
}

export function readClipboardTable(text: string, html = ""): string[][] | null {
  if (html && typeof document !== "undefined") {
    const template = document.createElement("template");
    template.innerHTML = html;
    const table = template.content.querySelector("table");
    if (table) {
      const plainText = (node: Node): string => {
        if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
        if (node instanceof globalThis.Element && /^(SCRIPT|STYLE|TEMPLATE)$/.test(node.tagName)) return "";
        if (node instanceof globalThis.Element && node.tagName === "BR") return "\n";
        return Array.from(node.childNodes, plainText).join("");
      };
      const rows = Array.from(table.rows, row => Array.from(row.cells, cell => plainText(cell)));
      if (rows.length && rows.some(row => row.length)) return rows;
    }
  }
  if (!text.includes("\t") || text.split(/\r?\n/).some(line => {
    const cells = tableRowRanges({ from: 0, to: line.length, text: line }).cells;
    return line.includes("|") && cells.length && cells.every(cell => /^:?-{2,}:?$/.test(cell.text));
  })) return null;
  const rows: string[][] = [[]];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (character === '"' && (quoted || cell === "")) {
      if (quoted && text[index + 1] === '"') { cell += '"'; index += 1; }
      else quoted = !quoted;
    } else if (!quoted && (character === "\t" || character === "\n" || character === "\r")) {
      rows.at(-1)!.push(cell);
      cell = "";
      if (character !== "\t") {
        if (character === "\r" && text[index + 1] === "\n") index += 1;
        rows.push([]);
      }
    } else cell += character;
  }
  if (quoted) return null;
  if (cell !== "" || rows.at(-1)!.length || !/[\r\n]$/.test(text)) rows.at(-1)!.push(cell);
  else rows.pop();
  return rows.length ? rows : null;
}
