import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
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
  type MathRange,
  type ProtectedRange,
} from "./math";
import { parseQuotePrefix } from "./quote-prefix";

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
  constructor(
    private readonly depth: number,
    private readonly previousDepth: number,
    private readonly nextDepth: number,
  ) {
    super();
  }

  eq(other: QuoteMarkerWidget): boolean {
    return (
      this.depth === other.depth &&
      this.previousDepth === other.previousDepth &&
      this.nextDepth === other.nextDepth
    );
  }

  toDOM(): HTMLElement {
    const markers = document.createElement("span");
    markers.className = "mqm-quote-markers";
    markers.setAttribute("aria-label", `引用レベル${this.depth}`);
    for (let level = 0; level < this.depth; level += 1) {
      const marker = document.createElement("span");
      const markerDepth = level + 1;
      marker.className = [
        "mqm-quote-marker",
        this.previousDepth >= markerDepth
          ? "mqm-quote-marker-connect-before"
          : "",
        this.nextDepth >= markerDepth
          ? "mqm-quote-marker-connect-after"
          : "",
      ]
        .filter(Boolean)
        .join(" ");
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

class EmptyTableCellWidget extends WidgetType {
  constructor(
    private readonly sourcePosition: number,
    private readonly heading: boolean,
  ) {
    super();
  }

  eq(other: EmptyTableCellWidget): boolean {
    return (
      this.sourcePosition === other.sourcePosition &&
      this.heading === other.heading
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const cell = document.createElement("span");
    cell.className = this.heading
      ? "mqm-table-cell mqm-table-cell-heading mqm-table-empty-cell"
      : "mqm-table-cell mqm-table-empty-cell";
    cell.addEventListener("mousedown", (event) => {
      event.preventDefault();
      view.dispatch({ selection: { anchor: this.sourcePosition } });
      view.focus();
    });
    return cell;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

interface DocumentSegment {
  from: number;
  to: number;
}

interface DecorationEntry {
  from: number;
  to: number;
  decoration: Decoration;
  allowOverlap?: boolean;
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

function editingTouches(
  state: EditorState,
  from: number,
  to: number,
): boolean {
  return !state.readOnly && selectionTouches(state, from, to);
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

interface TableCellRange {
  from: number;
  to: number;
  segmentFrom: number;
  segmentTo: number;
}

export function tableRowRanges(line: {
  from: number;
  to: number;
  text: string;
}): { cells: TableCellRange[]; separators: number[] } {
  const separators: number[] = [];
  let escaped = false;
  let inMath = false;
  for (let index = 0; index < line.text.length; index += 1) {
    const character = line.text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "$") {
      inMath = !inMath;
      continue;
    }
    if (character === "|" && !inMath) {
      separators.push(index);
    }
  }

  const segments: { from: number; to: number }[] = [];
  const firstSeparator = separators[0];
  let segmentFrom =
    firstSeparator !== undefined &&
    line.text.slice(0, firstSeparator).trim().length === 0
      ? firstSeparator + 1
      : 0;
  for (const separator of separators) {
    if (separator >= segmentFrom) {
      segments.push({ from: segmentFrom, to: separator });
    }
    segmentFrom = separator + 1;
  }
  if (
    segmentFrom < line.text.length &&
    line.text.slice(segmentFrom).trim().length > 0
  ) {
    segments.push({ from: segmentFrom, to: line.text.length });
  }

  return {
    separators: separators.map((position) => line.from + position),
    cells: segments.map((segment) => {
      let from = segment.from;
      let to = segment.to;
      while (from < to && /[ \t]/.test(line.text[from] ?? "")) {
        from += 1;
      }
      while (to > from && /[ \t]/.test(line.text[to - 1] ?? "")) {
        to -= 1;
      }
      return {
        from: line.from + from,
        to: line.from + to,
        segmentFrom: line.from + segment.from,
        segmentTo: line.from + segment.to,
      };
    }),
  };
}

function tableDecorations(
  document: Text,
  startLineNumber: number,
  endLineNumber: number,
): { entries: DecorationEntry[]; endLineNumber: number } | null {
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
  const lines = [heading];
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
    lines.push(line);
    lastLine = line;
  }
  const rows = lines.map(tableRowRanges);
  const columnCount = Math.max(...rows.map((row) => row.cells.length));
  const entries: DecorationEntry[] = [
    {
      from: separator.from,
      to: separator.to,
      decoration: Decoration.replace({ block: true }),
    },
  ];

  rows.forEach((row, rowIndex) => {
    const line = lines[rowIndex];
    if (!line) {
      return;
    }
    const headingRow = rowIndex === 0;
    entries.push({
      from: line.from,
      to: line.from,
      decoration: Decoration.line({
        attributes: {
          class: [
            "mqm-table-row",
            rowIndex === 0 ? "mqm-table-row-start" : "",
            rowIndex === rows.length - 1 ? "mqm-table-row-end" : "",
          ]
            .filter(Boolean)
            .join(" "),
          style: `--mqm-table-columns: ${columnCount}`,
        },
      }),
    });
    for (const separatorPosition of row.separators) {
      entries.push({
        from: separatorPosition,
        to: separatorPosition + 1,
        decoration: Decoration.replace({}),
      });
    }
    row.cells.forEach((cell, cellIndex) => {
      if (cell.segmentFrom < cell.from) {
        entries.push({
          from: cell.segmentFrom,
          to: cell.from,
          decoration: Decoration.replace({}),
        });
      }
      if (cell.to < cell.segmentTo) {
        entries.push({
          from: cell.to,
          to: cell.segmentTo,
          decoration: Decoration.replace({}),
        });
      }
      if (cell.from < cell.to) {
        entries.push({
          from: cell.from,
          to: cell.to,
          decoration: Decoration.mark({
            class: headingRow
              ? "mqm-table-cell mqm-table-cell-heading"
              : "mqm-table-cell",
          }),
          allowOverlap: true,
        });
      } else {
        entries.push({
          from: cell.from,
          to: cell.from,
          decoration: Decoration.widget({
            widget: new EmptyTableCellWidget(cell.from, headingRow),
            side: cellIndex + 1,
          }),
        });
      }
    });
    for (
      let cellIndex = row.cells.length;
      cellIndex < columnCount;
      cellIndex += 1
    ) {
      entries.push({
        from: line.to,
        to: line.to,
        decoration: Decoration.widget({
          widget: new EmptyTableCellWidget(line.to, headingRow),
          side: cellIndex + 1,
        }),
      });
    }
  });

  return {
    entries,
    endLineNumber: lastLine.number,
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
    const quote = parseQuotePrefix(text)?.text ?? "";
    const match = /^([ \t]*)\d+[.)][ \t]+/.exec(text.slice(quote.length));
    if (!match) {
      if (/^\s*(?:[-+*])\s+/.test(text)) {
        continue;
      }
      break;
    }
    if (`${quote}${match[1] ?? ""}` === indentation) {
      count += 1;
    }
  }
  return count;
}

function quoteDepth(lineText: string): number {
  return parseQuotePrefix(lineText)?.depth ?? 0;
}

interface ListPrefix {
  quote: string;
  indent: string;
  marker: string;
  spacing: string;
}

function listPrefix(lineText: string): ListPrefix | null {
  const quote = parseQuotePrefix(lineText)?.text ?? "";
  const list = /^([ \t]*)([-+*]|\d+[.)])([ \t]+)/.exec(
    lineText.slice(quote.length),
  );
  if (!list) {
    return null;
  }
  return {
    quote,
    indent: list[1] ?? "",
    marker: list[2] ?? "-",
    spacing: list[3] ?? " ",
  };
}

function lineDecorations(
  state: EditorState,
  segment: DocumentSegment,
): DecorationEntry[] {
  const results: DecorationEntry[] = [];
  const document = state.doc;
  const startLine = document.lineAt(segment.from).number;
  const endLine = document.lineAt(segment.to).number;
  let lineNumber = startLine;

  while (lineNumber <= endLine) {
    const table = tableDecorations(document, lineNumber, endLine);
    if (table) {
      results.push(...table.entries);
      lineNumber = table.endLineNumber + 1;
      continue;
    }

    const line = document.line(lineNumber);
    if (insideFencedCode(state, line.from)) {
      lineNumber += 1;
      continue;
    }
    const lineIsActive = editingTouches(state, line.from, line.to);
    const heading = /^(#{1,6})(\s+)/.exec(line.text);
    if (heading) {
      const level = heading[1]?.length ?? 1;
      const markerLength = level + (heading[2]?.length ?? 1);
      if (!lineIsActive) {
        results.push({
          from: line.from,
          to: line.from + markerLength,
          decoration: Decoration.replace({}),
        });
      }
      results.push({
        from: line.from,
        to: line.from,
        decoration: Decoration.line({
          attributes: { class: `mqm-heading mqm-heading-${level}` },
        }),
      });
    }
    if (/^\s{0,3}(?:---+|\*\*\*+|___+)\s*$/.test(line.text)) {
      if (lineIsActive) {
        results.push({
          from: line.from,
          to: line.from,
          decoration: Decoration.widget({
            widget: new RuleWidget(),
            block: true,
            side: -1,
          }),
        });
        results.push({
          from: line.from,
          to: line.from,
          decoration: Decoration.line({
            attributes: { class: "mqm-decoration-source-line" },
          }),
        });
      } else {
        results.push({
          from: line.from,
          to: line.to,
          decoration: Decoration.replace({
            widget: new RuleWidget(),
            block: true,
          }),
        });
      }
      lineNumber += 1;
      continue;
    }

    const list = listPrefix(line.text);
    if (list) {
      const quote = list.quote;
      const indent = list.indent;
      const indentation = `${quote}${indent}`;
      const marker = list.marker;
      const markerFrom = line.from + indentation.length;
      const markerTo = markerFrom + marker.length + list.spacing.length;
      const remainder = line.text.slice(markerTo - line.from);
      const checkbox = /^(\[[ xX]\])([ \t]+)/.exec(remainder);
      const visualIndent = indent.replace(/\t/g, "  ").length;
      results.push({
        from: line.from,
        to: line.from,
        decoration: Decoration.line({
          attributes: {
            class: lineIsActive ? "mqm-list-line mqm-list-line-active" : "mqm-list-line",
            style: [
              `--mqm-list-indent: ${visualIndent}ch`,
              `--mqm-list-source-width: ${(marker + list.spacing + (checkbox?.[0] ?? "")).replace(/\t/g, "  ").length}ch`,
            ].join("; "),
          },
        }),
      });
      if (!lineIsActive) {
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
      } else {
        results.push({
          from: markerFrom,
          to: checkbox ? markerTo + checkbox[0].length : markerTo,
          decoration: Decoration.mark({ class: "mqm-list-source-marker", inclusive: false }),
        });
      }
    }
    const quote = parseQuotePrefix(line.text);
    if (quote) {
      const markers = quote.markers;
      const depth = quote.depth;
      const previousDepth =
        lineNumber > 1 ? quoteDepth(document.line(lineNumber - 1).text) : 0;
      const nextDepth =
        lineNumber < document.lines
          ? quoteDepth(document.line(lineNumber + 1).text)
          : 0;
      const from = line.from + quote.indentation.length;
      const marker = new QuoteMarkerWidget(depth, previousDepth, nextDepth);
      results.push({
        from,
        to: lineIsActive ? from : from + markers.length,
        decoration: lineIsActive
          ? Decoration.widget({ widget: marker, side: -1 })
          : Decoration.replace({ widget: marker }),
      });
      const sourceWidth = lineIsActive
        ? markers.replace(/\t/g, "  ").length
        : 0;
      results.push({
        from: line.from,
        to: line.from,
        decoration: Decoration.line({
          attributes: {
            class: lineIsActive
              ? "mqm-quote-line mqm-quote-line-active"
              : "mqm-quote-line",
            style: [
              `--mqm-quote-marker-width: ${depth}em`,
              `--mqm-quote-source-width: ${sourceWidth}ch`,
            ].join("; "),
          },
        }),
      });
    }
    lineNumber += 1;
  }

  return results;
}

function inlineMarkerDecorations(
  state: EditorState,
  segment: DocumentSegment,
): DecorationEntry[] {
  const results: DecorationEntry[] = [];
  syntaxTree(state).iterate({
    from: segment.from,
    to: segment.to,
    enter: (node) => {
      if (
        node.name === "Emphasis" &&
        node.to - node.from > 2
      ) {
        results.push({
          from: node.from + 1,
          to: node.to - 1,
          decoration: Decoration.mark({ class: "mqm-emphasis-content" }),
        });
      }
      if (node.name === "InlineCode") {
        const active = editingTouches(state, node.from, node.to);
        const source = state.doc.sliceString(node.from, node.to);
        const opening = /^`+/.exec(source)?.[0].length ?? 0;
        const closing = /`+$/.exec(source)?.[0].length ?? 0;
        if (opening > 0 && closing > 0 && opening + closing <= source.length) {
          if (!active) {
            results.push({
              from: node.from,
              to: node.from + opening,
              decoration: Decoration.replace({}),
            });
          }
          results.push({
            from: node.from + opening,
            to: node.to - closing,
            decoration: Decoration.mark({ class: "mqm-inline-code" }),
          });
          if (!active) {
            results.push({
              from: node.to - closing,
              to: node.to,
              decoration: Decoration.replace({}),
            });
          }
        }
        return false;
      }
      if (
        !["EmphasisMark", "StrikethroughMark"].includes(node.name) ||
        editingTouches(state, node.from, node.to)
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

function linkDecorations(
  state: EditorState,
  segment: DocumentSegment,
): DecorationEntry[] {
  const results: DecorationEntry[] = [];
  syntaxTree(state).iterate({
    from: segment.from,
    to: segment.to,
    enter: (node) => {
      if (node.name !== "Link") {
        return;
      }
      const linkMarks: { from: number; to: number }[] = [];
      let child = node.node.firstChild;
      while (child) {
        if (child.name === "LinkMark") {
          linkMarks.push({ from: child.from, to: child.to });
        }
        child = child.nextSibling;
      }
      const openingMark = linkMarks[0];
      const closingLabelMark = linkMarks[1];
      if (
        !openingMark ||
        !closingLabelMark ||
        openingMark.to >= closingLabelMark.from
      ) {
        return false;
      }

      const active = editingTouches(state, node.from, node.to);
      if (!active) {
        results.push({
          from: node.from,
          to: openingMark.to,
          decoration: Decoration.replace({}),
        });
      }
      results.push({
        from: openingMark.to,
        to: closingLabelMark.from,
        decoration: Decoration.mark({ class: "mqm-link-text" }),
      });
      if (!active) {
        results.push({
          from: closingLabelMark.from,
          to: node.to,
          decoration: Decoration.replace({}),
        });
      }
      return false;
    },
  });
  return results;
}

function fencedCodeDecorations(
  state: EditorState,
  segment: DocumentSegment,
): DecorationEntry[] {
  const results: DecorationEntry[] = [];
  syntaxTree(state).iterate({
    from: segment.from,
    to: segment.to,
    enter: (node) => {
      if (node.name !== "FencedCode") {
        return;
      }
      const active = editingTouches(state, node.from, node.to);
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
        if (!active) {
          results.push({
            from: markerFrom,
            to: markerTo,
            decoration: Decoration.replace({}),
          });
        }
        if (markerTo < firstLine.to) {
          results.push({
            from: markerTo,
            to: firstLine.to,
            decoration: Decoration.mark({ class: "mqm-code-language" }),
          });
        }
      }

      const closing = /^([ \t]*)(`{3,}|~{3,})[ \t]*$/.exec(lastLine.text);
      if (closing && !active) {
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

function displayMathGapDecorations(
  state: EditorState,
  mathRanges: readonly MathRange[],
): DecorationEntry[] {
  const results: DecorationEntry[] = [];
  const collapsedLinePositions = new Set<number>();

  const addCollapsedLine = (lineNumber: number): void => {
    if (lineNumber < 1 || lineNumber > state.doc.lines) {
      return;
    }
    const line = state.doc.line(lineNumber);
    if (
      line.text.trim() !== "" ||
      selectionTouches(state, line.from, line.to) ||
      collapsedLinePositions.has(line.from)
    ) {
      return;
    }
    collapsedLinePositions.add(line.from);
    results.push({
      from: line.from,
      to: line.from,
      decoration: Decoration.line({
        attributes: { class: "mqm-math-gap-collapsed" },
      }),
    });
  };

  for (const math of mathRanges) {
    if (!math.display) {
      continue;
    }
    const firstLine = state.doc.lineAt(math.from);
    const lastLine = state.doc.lineAt(Math.max(math.from, math.to - 1));
    const standalone =
      state.doc.sliceString(firstLine.from, math.from).trim() === "" &&
      state.doc.sliceString(math.to, lastLine.to).trim() === "";
    if (!standalone) {
      continue;
    }
    addCollapsedLine(firstLine.number - 1);
    addCollapsedLine(lastLine.number + 1);
  }

  return results;
}

export function buildDecorations(state: EditorState): DecorationSet {
  const entries: DecorationEntry[] = [];
  const segment = documentSegment(state);

  const text = state.doc.sliceString(segment.from, segment.to);
  const mathRanges = findMathRanges(
    text,
    segment.from,
    protectedRanges(state, segment),
  );
  const markdownEntries = [
    ...lineDecorations(state, segment),
    ...inlineMarkerDecorations(state, segment),
    ...linkDecorations(state, segment),
    ...fencedCodeDecorations(state, segment),
  ];
  entries.push(...markdownEntries.filter((entry) => !mathRanges.some((math) =>
    entry.from === entry.to
      ? math.from < entry.from && entry.from < math.to
      : entry.from < math.to && entry.to > math.from && !entry.allowOverlap,
  )));
  entries.push(...displayMathGapDecorations(state, mathRanges));
  for (const math of mathRanges) {
    if (editingTouches(state, math.from, math.to)) {
      if (math.display) {
        const firstLine = state.doc.lineAt(math.from);
        const lastLine = state.doc.lineAt(Math.max(math.from, math.to - 1));
        for (
          let lineNumber = firstLine.number;
          lineNumber <= lastLine.number;
          lineNumber += 1
        ) {
          const line = state.doc.line(lineNumber);
          const classes = ["mqm-math-display-source-line"];
          if (lineNumber === firstLine.number) {
            classes.push("mqm-math-display-source-start");
          }
          if (lineNumber === lastLine.number) {
            classes.push("mqm-math-display-source-end");
          }
          entries.push({
            from: line.from,
            to: line.from,
            decoration: Decoration.line({
              attributes: { class: classes.join(" ") },
            }),
          });
        }
      }
      entries.push({
        from: math.from,
        to: math.from,
        decoration: Decoration.widget({
          widget: new MathWidget(math.expression, math.display, math.from),
          block: math.display,
          side: -1,
        }),
      });
      entries.push({
        from: math.from,
        to: math.to,
        decoration: Decoration.mark({ class: "mqm-decoration-source mqm-math-source" }),
      });
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
    if (entry.from === entry.to || entry.allowOverlap) {
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
    ensureSyntaxTree(state, state.doc.length, 100);
    return buildDecorations(state);
  },
  update(decorations, transaction) {
    if (
      transaction.docChanged ||
      transaction.selection ||
      transaction.reconfigured
    ) {
      return buildDecorations(transaction.state);
    }
    return decorations;
  },
  provide: (field) => EditorView.decorations.from(field),
});
