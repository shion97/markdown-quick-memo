import { syntaxTree } from "@codemirror/language";
import { RangeSetBuilder, type Text } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import {
  findMathRanges,
  renderMath,
  type ProtectedRange,
} from "./math";

class MathWidget extends WidgetType {
  constructor(
    private readonly expression: string,
    private readonly display: boolean,
    private readonly sourcePosition: number,
  ) {
    super();
  }

  eq(other: MathWidget): boolean {
    return (
      this.expression === other.expression &&
      this.display === other.display &&
      this.sourcePosition === other.sourcePosition
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const element = document.createElement(this.display ? "div" : "span");
    element.className = this.display ? "mqm-math-display" : "mqm-math-inline";
    try {
      element.innerHTML = renderMath(this.expression, this.display);
    } catch {
      element.textContent = this.display
        ? `$$${this.expression}$$`
        : `$${this.expression}$`;
      element.classList.add("mqm-math-fallback");
    }
    element.addEventListener("mousedown", (event) => {
      event.preventDefault();
      view.dispatch({ selection: { anchor: this.sourcePosition } });
      view.focus();
    });
    return element;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

class MarkerWidget extends WidgetType {
  constructor(private readonly label: string) {
    super();
  }

  eq(other: MarkerWidget): boolean {
    return this.label === other.label;
  }

  toDOM(): HTMLElement {
    const marker = document.createElement("span");
    marker.className = "mqm-list-marker";
    marker.textContent = this.label;
    return marker;
  }
}

class RuleWidget extends WidgetType {
  toDOM(): HTMLElement {
    const rule = document.createElement("div");
    rule.className = "mqm-horizontal-rule";
    return rule;
  }
}

class TableWidget extends WidgetType {
  constructor(
    private readonly rows: readonly (readonly string[])[],
    private readonly sourcePosition: number,
  ) {
    super();
  }

  eq(other: TableWidget): boolean {
    return JSON.stringify(this.rows) === JSON.stringify(other.rows);
  }

  toDOM(view: EditorView): HTMLElement {
    const table = document.createElement("table");
    table.className = "mqm-table";
    const [heading, ...bodyRows] = this.rows;
    if (heading) {
      const head = table.createTHead().insertRow();
      for (const value of heading) {
        const cell = document.createElement("th");
        appendTableCellContent(cell, value);
        head.append(cell);
      }
    }
    const body = table.createTBody();
    for (const row of bodyRows) {
      const tableRow = body.insertRow();
      for (const value of row) {
        const cell = tableRow.insertCell();
        appendTableCellContent(cell, value);
      }
    }
    table.addEventListener("mousedown", (event) => {
      event.preventDefault();
      view.dispatch({ selection: { anchor: this.sourcePosition } });
      view.focus();
    });
    return table;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

function appendTableCellContent(cell: HTMLElement, source: string): void {
  const math = findMathRanges(source);
  let position = 0;
  for (const range of math) {
    cell.append(document.createTextNode(source.slice(position, range.from)));
    const mathElement = document.createElement("span");
    mathElement.className = "mqm-math-inline";
    try {
      mathElement.innerHTML = renderMath(range.expression, false);
    } catch {
      mathElement.textContent = source.slice(range.from, range.to);
      mathElement.classList.add("mqm-math-fallback");
    }
    cell.append(mathElement);
    position = range.to;
  }
  cell.append(document.createTextNode(source.slice(position)));
}

interface VisibleSegment {
  from: number;
  to: number;
}

function expandedVisibleSegments(view: EditorView): VisibleSegment[] {
  return view.visibleRanges.map((range) => {
    const fromLine = view.state.doc.lineAt(range.from);
    const toLine = view.state.doc.lineAt(range.to);
    const startLine = Math.max(1, fromLine.number - 2);
    const endLine = Math.min(view.state.doc.lines, toLine.number + 2);
    return {
      from: view.state.doc.line(startLine).from,
      to: view.state.doc.line(endLine).to,
    };
  });
}

function protectedRanges(
  view: EditorView,
  segment: VisibleSegment,
): ProtectedRange[] {
  const protectedNodes: ProtectedRange[] = [];
  syntaxTree(view.state).iterate({
    from: segment.from,
    to: segment.to,
    enter: (node) => {
      const name = node.name.toLowerCase();
      if (
        name.includes("code") ||
        name.includes("url") ||
        name.includes("link") ||
        name.includes("image")
      ) {
        protectedNodes.push({ from: node.from, to: node.to });
      }
    },
  });
  return protectedNodes;
}

function selectionTouches(
  view: EditorView,
  from: number,
  to: number,
): boolean {
  return view.state.selection.ranges.some(
    (selection) => selection.from <= to && selection.to >= from,
  );
}

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let current = "";
  let escaped = false;
  let inMath = false;
  for (const character of trimmed) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      current += character;
      escaped = true;
      continue;
    }
    if (character === "$") {
      inMath = !inMath;
      current += character;
      continue;
    }
    if (character === "|" && !inMath) {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }
  cells.push(current.trim());
  return cells;
}

function tableDecoration(
  document: Text,
  startLineNumber: number,
  endLineNumber: number,
  view: EditorView,
): { from: number; to: number; decoration: Decoration } | null {
  if (startLineNumber + 1 > endLineNumber) {
    return null;
  }
  const heading = document.line(startLineNumber);
  const separator = document.line(startLineNumber + 1);
  if (
    !heading.text.includes("|") ||
    !/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(
      separator.text,
    )
  ) {
    return null;
  }
  const lines = [heading.text];
  let lastLine = separator;
  for (
    let lineNumber = startLineNumber + 2;
    lineNumber <= endLineNumber;
    lineNumber += 1
  ) {
    const line = document.line(lineNumber);
    if (!line.text.includes("|") || line.text.trim() === "") {
      break;
    }
    lines.push(line.text);
    lastLine = line;
  }
  if (selectionTouches(view, heading.from, lastLine.to)) {
    return null;
  }
  const rows = lines.map(splitTableRow);
  return {
    from: heading.from,
    to: lastLine.to,
    decoration: Decoration.replace({
      widget: new TableWidget(rows, heading.from),
      block: true,
      inclusive: false,
    }),
  };
}

function orderedListNumber(
  document: Text,
  lineNumber: number,
  indentation: string,
): number {
  let count = 1;
  const minimum = Math.max(1, lineNumber - 200);
  for (let previous = lineNumber - 1; previous >= minimum; previous -= 1) {
    const text = document.line(previous).text;
    if (text.trim() === "") {
      break;
    }
    const match = /^(\s*(?:>\s*)*\s*)\d+[.)]\s+/.exec(text);
    if (!match) {
      if (/^\s*(?:[-+*])\s+/.test(text)) {
        continue;
      }
      break;
    }
    if ((match[1] ?? "") === indentation) {
      count += 1;
    }
  }
  return count;
}

function lineDecorations(
  view: EditorView,
  segment: VisibleSegment,
): { from: number; to: number; decoration: Decoration }[] {
  const results: { from: number; to: number; decoration: Decoration }[] = [];
  const document = view.state.doc;
  const startLine = document.lineAt(segment.from).number;
  const endLine = document.lineAt(segment.to).number;
  let lineNumber = startLine;

  while (lineNumber <= endLine) {
    const table = tableDecoration(document, lineNumber, endLine, view);
    if (table) {
      results.push(table);
      lineNumber = document.lineAt(table.to).number + 1;
      continue;
    }

    const line = document.line(lineNumber);
    if (!selectionTouches(view, line.from, line.to)) {
      const heading = /^(#{1,6})(\s+)/.exec(line.text);
      if (heading) {
        const level = heading[1]?.length ?? 1;
        const markerLength = level + (heading[2]?.length ?? 1);
        results.push({
          from: line.from,
          to: line.from + markerLength,
          decoration: Decoration.replace({}),
        });
        results.push({
          from: line.from,
          to: line.from,
          decoration: Decoration.line({
            attributes: { class: `mqm-heading mqm-heading-${level}` },
          }),
        });
      }
      if (/^\s{0,3}(?:---+|\*\*\*+|___+)\s*$/.test(line.text)) {
        results.push({
          from: line.from,
          to: line.to,
          decoration: Decoration.replace({
            widget: new RuleWidget(),
            block: true,
          }),
        });
        lineNumber += 1;
        continue;
      }

      const list = /^(\s*(?:>\s*)*\s*)([-+*]|\d+[.)])(\s+)/.exec(line.text);
      if (list) {
        const indentation = list[1] ?? "";
        const marker = list[2] ?? "-";
        const markerFrom = line.from + indentation.length;
        const markerTo = markerFrom + marker.length + (list[3]?.length ?? 1);
        const label = /^\d/.test(marker)
          ? `${orderedListNumber(document, lineNumber, indentation)}. `
          : indentation.replace(/>\s*/g, "").length === 0
            ? "● "
            : "○ ";
        results.push({
          from: markerFrom,
          to: markerTo,
          decoration: Decoration.replace({
            widget: new MarkerWidget(label),
          }),
        });
      }

      const quote = /^(\s*)((?:>\s*)+)/.exec(line.text);
      if (quote) {
        const markers = quote[2] ?? "";
        const depth = (markers.match(/>/g) ?? []).length;
        const from = line.from + (quote[1]?.length ?? 0);
        results.push({
          from,
          to: from + markers.length,
          decoration: Decoration.replace({}),
        });
        results.push({
          from: line.from,
          to: line.from,
          decoration: Decoration.line({
            attributes: {
              class: "mqm-quote-line",
              style: `--mqm-quote-depth: ${depth}`,
            },
          }),
        });
      }
    }
    lineNumber += 1;
  }

  return results;
}

function inlineMarkerDecorations(
  view: EditorView,
  segment: VisibleSegment,
): { from: number; to: number; decoration: Decoration }[] {
  const results: { from: number; to: number; decoration: Decoration }[] = [];
  syntaxTree(view.state).iterate({
    from: segment.from,
    to: segment.to,
    enter: (node) => {
      if (
        !["EmphasisMark", "StrikethroughMark"].includes(node.name) ||
        selectionTouches(view, node.from, node.to)
      ) {
        return;
      }
      results.push({
        from: node.from,
        to: node.to,
        decoration: Decoration.replace({}),
      });
    },
  });
  return results;
}

export function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const entries: { from: number; to: number; decoration: Decoration }[] = [];

  for (const segment of expandedVisibleSegments(view)) {
    entries.push(...lineDecorations(view, segment));
    entries.push(...inlineMarkerDecorations(view, segment));
    const text = view.state.doc.sliceString(segment.from, segment.to);
    for (const math of findMathRanges(
      text,
      segment.from,
      protectedRanges(view, segment),
    )) {
      if (selectionTouches(view, math.from, math.to)) {
        continue;
      }
      entries.push({
        from: math.from,
        to: math.to,
        decoration: Decoration.replace({
          widget: new MathWidget(math.expression, math.display, math.from),
          block: math.display,
          inclusive: false,
        }),
      });
    }
  }

  entries
    .sort((left, right) => left.from - right.from || left.to - right.to)
    .filter(
      (entry, index, all) =>
        index === 0 ||
        entry.from >= (all[index - 1]?.to ?? 0) ||
        entry.from === entry.to,
    )
    .forEach((entry) => {
      builder.add(entry.from, entry.to, entry.decoration);
    });
  return builder.finish();
}

export const markdownDecorations = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }

    update(update: ViewUpdate): void {
      if (update.view.composing) {
        return;
      }
      if (
        update.docChanged ||
        update.selectionSet ||
        update.viewportChanged ||
        update.geometryChanged
      ) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  {
    decorations: (plugin) => plugin.decorations,
  },
);
