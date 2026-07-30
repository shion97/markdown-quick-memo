import { syntaxTree } from "@codemirror/language";
import { type EditorState, StateField, type Text } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
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
  constructor(
    private readonly label: string,
    private readonly bullet: boolean,
  ) {
    super();
  }

  eq(other: MarkerWidget): boolean {
    return this.label === other.label && this.bullet === other.bullet;
  }

  toDOM(): HTMLElement {
    const marker = document.createElement("span");
    marker.className = "mqm-list-marker";
    const label = document.createElement("span");
    label.className = this.bullet
      ? "mqm-list-marker-label mqm-list-marker-bullet"
      : "mqm-list-marker-label";
    label.textContent = this.label;
    marker.append(label);
    return marker;
  }
}

class CheckboxWidget extends WidgetType {
  constructor(private readonly checked: boolean) {
    super();
  }

  eq(other: CheckboxWidget): boolean {
    return this.checked === other.checked;
  }

  toDOM(): HTMLElement {
    const checkbox = document.createElement("span");
    checkbox.className = this.checked
      ? "mqm-checkbox mqm-checkbox-checked"
      : "mqm-checkbox";
    checkbox.textContent = this.checked ? "✓" : "";
    checkbox.setAttribute(
      "aria-label",
      this.checked ? "チェック済み" : "未チェック",
    );
    return checkbox;
  }
}

class QuoteMarkerWidget extends WidgetType {
  constructor(private readonly depth: number) {
    super();
  }

  eq(other: QuoteMarkerWidget): boolean {
    return this.depth === other.depth;
  }

  toDOM(): HTMLElement {
    const markers = document.createElement("span");
    markers.className = "mqm-quote-markers";
    markers.setAttribute("aria-label", `引用レベル${this.depth}`);
    for (let level = 0; level < this.depth; level += 1) {
      const marker = document.createElement("span");
      marker.className = "mqm-quote-marker";
      markers.append(marker);
    }
    return markers;
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

interface InlineCodeRange extends ProtectedRange {
  content: string;
}

function findInlineCodeRanges(source: string): InlineCodeRange[] {
  const ranges: InlineCodeRange[] = [];
  let position = 0;
  while (position < source.length) {
    if (source[position] !== "`") {
      position += 1;
      continue;
    }
    let markerLength = 1;
    while (source[position + markerLength] === "`") {
      markerLength += 1;
    }
    const marker = "`".repeat(markerLength);
    const contentFrom = position + markerLength;
    const closing = source.indexOf(marker, contentFrom);
    if (closing < 0) {
      position = contentFrom;
      continue;
    }
    let content = source.slice(contentFrom, closing);
    if (
      content.startsWith(" ") &&
      content.endsWith(" ") &&
      content.trim().length > 0
    ) {
      content = content.slice(1, -1);
    }
    ranges.push({
      from: position,
      to: closing + markerLength,
      content,
    });
    position = closing + markerLength;
  }
  return ranges;
}

function appendTableCellContent(cell: HTMLElement, source: string): void {
  const inlineCode = findInlineCodeRanges(source);
  const ranges = [
    ...inlineCode.map((range) => ({ ...range, kind: "code" as const })),
    ...findMathRanges(source, 0, inlineCode).map((range) => ({
      ...range,
      kind: "math" as const,
    })),
  ].sort((left, right) => left.from - right.from);
  let position = 0;
  for (const range of ranges) {
    cell.append(document.createTextNode(source.slice(position, range.from)));
    if (range.kind === "code") {
      const codeElement = document.createElement("code");
      codeElement.className = "mqm-inline-code";
      codeElement.textContent = range.content;
      cell.append(codeElement);
    } else {
      const mathElement = document.createElement("span");
      mathElement.className = "mqm-math-inline";
      try {
        mathElement.innerHTML = renderMath(range.expression, false);
      } catch {
        mathElement.textContent = source.slice(range.from, range.to);
        mathElement.classList.add("mqm-math-fallback");
      }
      cell.append(mathElement);
    }
    position = range.to;
  }
  cell.append(document.createTextNode(source.slice(position)));
}

interface DocumentSegment {
  from: number;
  to: number;
}

function documentSegment(state: EditorState): DocumentSegment {
  return { from: 0, to: state.doc.length };
}

function protectedRanges(
  state: EditorState,
  segment: DocumentSegment,
): ProtectedRange[] {
  const protectedNodes: ProtectedRange[] = [];
  syntaxTree(state).iterate({
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
  state: EditorState,
  from: number,
  to: number,
): boolean {
  return state.selection.ranges.some(
    (selection) => selection.from <= to && selection.to >= from,
  );
}

function insideFencedCode(state: EditorState, position: number): boolean {
  let node = syntaxTree(state).resolveInner(position, 1);
  while (node) {
    if (node.name === "FencedCode") {
      return true;
    }
    const parent = node.parent;
    if (!parent) {
      break;
    }
    node = parent;
  }
  return false;
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
  state: EditorState,
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
  if (selectionTouches(state, heading.from, lastLine.to)) {
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
    const match =
      /^((?:[ \t]*>[ \t]?)*[ \t]*)\d+[.)][ \t]+/.exec(text);
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
  state: EditorState,
  segment: DocumentSegment,
): { from: number; to: number; decoration: Decoration }[] {
  const results: { from: number; to: number; decoration: Decoration }[] = [];
  const document = state.doc;
  const startLine = document.lineAt(segment.from).number;
  const endLine = document.lineAt(segment.to).number;
  let lineNumber = startLine;

  while (lineNumber <= endLine) {
    const table = tableDecoration(document, lineNumber, endLine, state);
    if (table) {
      results.push(table);
      lineNumber = document.lineAt(table.to).number + 1;
      continue;
    }

    const line = document.line(lineNumber);
    if (insideFencedCode(state, line.from)) {
      lineNumber += 1;
      continue;
    }
    const lineIsActive = selectionTouches(state, line.from, line.to);
    if (!lineIsActive) {
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

      const list =
        /^((?:[ \t]*>[ \t]?)*)([ \t]*)([-+*]|\d+[.)])([ \t]+)/.exec(
          line.text,
        );
      if (list) {
        const quote = list[1] ?? "";
        const indent = list[2] ?? "";
        const indentation = `${quote}${indent}`;
        const marker = list[3] ?? "-";
        const markerFrom = line.from + indentation.length;
        const markerTo = markerFrom + marker.length + (list[4]?.length ?? 1);
        const remainder = line.text.slice(markerTo - line.from);
        const checkbox = /^(\[[ xX]\])([ \t]+)/.exec(remainder);
        const visualIndent = indent.replace(/\t/g, "  ").length;
        results.push({
          from: line.from,
          to: line.from,
          decoration: Decoration.line({
            attributes: {
              class: "mqm-list-line",
              style: `--mqm-list-indent: ${visualIndent}ch`,
            },
          }),
        });
        if (checkbox) {
          results.push({
            from: markerFrom,
            to: markerTo + checkbox[0].length,
            decoration: Decoration.replace({
              widget: new CheckboxWidget(/[xX]/.test(checkbox[1] ?? "")),
            }),
          });
        } else {
          const label = /^\d/.test(marker)
            ? `${orderedListNumber(document, lineNumber, indentation)}.`
            : visualIndent === 0
              ? "●"
              : "○";
          results.push({
            from: markerFrom,
            to: markerTo,
            decoration: Decoration.replace({
              widget: new MarkerWidget(label, !/^\d/.test(marker)),
            }),
          });
        }
      }

      const quote = /^([ \t]*)((?:>[ \t]?)+)/.exec(line.text);
      if (quote) {
        const markers = quote[2] ?? "";
        const depth = (markers.match(/>/g) ?? []).length;
        const from = line.from + (quote[1]?.length ?? 0);
        results.push({
          from,
          to: from + markers.length,
          decoration: Decoration.replace({
            widget: new QuoteMarkerWidget(depth),
          }),
        });
        results.push({
          from: line.from,
          to: line.from,
          decoration: Decoration.line({
            attributes: { class: "mqm-quote-line" },
          }),
        });
      }
    }
    if (lineIsActive) {
      const activeList =
        /^((?:[ \t]*>[ \t]?)*)([ \t]*)([-+*]|\d+[.)])([ \t]+)/.exec(
          line.text,
        );
      if (activeList) {
        const indent = activeList[2] ?? "";
        const visualIndent = indent.replace(/\t/g, "  ").length;
        results.push({
          from: line.from,
          to: line.from,
          decoration: Decoration.line({
            attributes: {
              class: "mqm-list-line",
              style: `--mqm-list-indent: ${visualIndent}ch`,
            },
          }),
        });
      }
      if (/^([ \t]*)((?:>[ \t]?)+)/.test(line.text)) {
        results.push({
          from: line.from,
          to: line.from,
          decoration: Decoration.line({
            attributes: { class: "mqm-quote-line" },
          }),
        });
      }
    }
    lineNumber += 1;
  }

  return results;
}

function inlineMarkerDecorations(
  state: EditorState,
  segment: DocumentSegment,
): { from: number; to: number; decoration: Decoration }[] {
  const results: { from: number; to: number; decoration: Decoration }[] = [];
  syntaxTree(state).iterate({
    from: segment.from,
    to: segment.to,
    enter: (node) => {
      if (
        node.name === "Emphasis" &&
        !selectionTouches(state, node.from, node.to) &&
        node.to - node.from > 2
      ) {
        results.push({
          from: node.from + 1,
          to: node.to - 1,
          decoration: Decoration.mark({ class: "mqm-emphasis-content" }),
        });
      }
      if (node.name === "InlineCode") {
        if (selectionTouches(state, node.from, node.to)) {
          return false;
        }
        const source = state.doc.sliceString(node.from, node.to);
        const opening = /^`+/.exec(source)?.[0].length ?? 0;
        const closing = /`+$/.exec(source)?.[0].length ?? 0;
        if (opening > 0 && closing > 0 && opening + closing <= source.length) {
          results.push({
            from: node.from,
            to: node.from + opening,
            decoration: Decoration.replace({}),
          });
          results.push({
            from: node.from + opening,
            to: node.to - closing,
            decoration: Decoration.mark({ class: "mqm-inline-code" }),
          });
          results.push({
            from: node.to - closing,
            to: node.to,
            decoration: Decoration.replace({}),
          });
        }
        return false;
      }
      if (
        !["EmphasisMark", "StrikethroughMark"].includes(node.name) ||
        selectionTouches(state, node.from, node.to)
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

function fencedCodeDecorations(
  state: EditorState,
  segment: DocumentSegment,
): { from: number; to: number; decoration: Decoration }[] {
  const results: { from: number; to: number; decoration: Decoration }[] = [];
  syntaxTree(state).iterate({
    from: segment.from,
    to: segment.to,
    enter: (node) => {
      if (
        node.name !== "FencedCode" ||
        selectionTouches(state, node.from, node.to)
      ) {
        return;
      }
      const firstLine = state.doc.lineAt(node.from);
      const lastLine = state.doc.lineAt(Math.max(node.from, node.to - 1));
      for (
        let lineNumber = firstLine.number;
        lineNumber <= lastLine.number;
        lineNumber += 1
      ) {
        const line = state.doc.line(lineNumber);
        const classes = ["mqm-code-block-line"];
        if (lineNumber === firstLine.number) {
          classes.push("mqm-code-block-start");
        }
        if (lineNumber === lastLine.number) {
          classes.push("mqm-code-block-end");
        }
        results.push({
          from: line.from,
          to: line.from,
          decoration: Decoration.line({
            attributes: { class: classes.join(" ") },
          }),
        });
      }

      const opening = /^([ \t]*)(`{3,}|~{3,})(.*)$/.exec(firstLine.text);
      if (opening) {
        const markerFrom = firstLine.from + (opening[1]?.length ?? 0);
        const markerTo = markerFrom + (opening[2]?.length ?? 0);
        results.push({
          from: markerFrom,
          to: markerTo,
          decoration: Decoration.replace({}),
        });
        if (markerTo < firstLine.to) {
          results.push({
            from: markerTo,
            to: firstLine.to,
            decoration: Decoration.mark({ class: "mqm-code-language" }),
          });
        }
      }

      const closing = /^([ \t]*)(`{3,}|~{3,})[ \t]*$/.exec(lastLine.text);
      if (closing) {
        const markerFrom = lastLine.from + (closing[1]?.length ?? 0);
        results.push({
          from: markerFrom,
          to: lastLine.to,
          decoration: Decoration.replace({}),
        });
      }
      return false;
    },
  });
  return results;
}

export function buildDecorations(state: EditorState): DecorationSet {
  const entries: { from: number; to: number; decoration: Decoration }[] = [];
  const segment = documentSegment(state);

  entries.push(...lineDecorations(state, segment));
  entries.push(...inlineMarkerDecorations(state, segment));
  entries.push(...fencedCodeDecorations(state, segment));
  const text = state.doc.sliceString(segment.from, segment.to);
  for (const math of findMathRanges(
    text,
    segment.from,
    protectedRanges(state, segment),
  )) {
    if (selectionTouches(state, math.from, math.to)) {
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

  const accepted: typeof entries = [];
  let coveredUntil = -1;
  for (const entry of entries.sort(
    (left, right) => left.from - right.from || left.to - right.to,
  )) {
    if (entry.from === entry.to) {
      accepted.push(entry);
      continue;
    }
    if (entry.from < coveredUntil) {
      continue;
    }
    accepted.push(entry);
    coveredUntil = entry.to;
  }
  return Decoration.set(
    accepted.map((entry) =>
      entry.decoration.range(entry.from, entry.to),
    ),
    true,
  );
}

export const markdownDecorations = StateField.define<DecorationSet>({
  create(state) {
    return buildDecorations(state);
  },
  update(decorations, transaction) {
    if (transaction.docChanged || transaction.selection) {
      return buildDecorations(transaction.state);
    }
    return decorations;
  },
  provide: (field) => EditorView.decorations.from(field),
});
