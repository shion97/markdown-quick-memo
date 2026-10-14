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
import { markdownLink } from "./links";
import { tableBreakRanges, tableFromLine, tableRowRanges, type TableAlignment } from "./tables";
import { tableCellSelected, tableInteraction, tableInteractionEffect } from "./table-editing";

class MathWidget extends WidgetType {
  constructor(
    private readonly expression: string,
    private readonly display: boolean,
    private readonly sourcePosition: number,
    private readonly openDelimiter: string,
    private readonly closeDelimiter: string,
  ) {
    super();
  }

  eq(other: MathWidget): boolean {
    return (
      this.expression === other.expression &&
      this.display === other.display &&
      this.sourcePosition === other.sourcePosition &&
      this.openDelimiter === other.openDelimiter &&
      this.closeDelimiter === other.closeDelimiter
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const element = document.createElement(this.display ? "div" : "span");
    element.className = this.display ? "mqm-math-display" : "mqm-math-inline";
    try {
      element.innerHTML = renderMath(this.expression, this.display);
    } catch {
      element.textContent = `${this.openDelimiter}${this.expression}${this.closeDelimiter}`;
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
    private readonly tableFrom: number,
    private readonly row: number,
    private readonly column: number,
    private readonly alignment: TableAlignment,
    private readonly selected: boolean,
  ) {
    super();
  }

  eq(other: EmptyTableCellWidget): boolean {
    return (
      this.sourcePosition === other.sourcePosition &&
      this.heading === other.heading && this.tableFrom === other.tableFrom &&
      this.row === other.row && this.column === other.column &&
      this.alignment === other.alignment && this.selected === other.selected
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const cell = document.createElement("span");
    cell.className = this.heading
      ? "mqm-table-cell mqm-table-cell-heading mqm-table-empty-cell"
      : "mqm-table-cell mqm-table-empty-cell";
    if (this.selected) cell.classList.add("mqm-table-cell-selected");
    cell.dataset.tableFrom = String(this.tableFrom);
    cell.dataset.tableCell = `${this.row}:${this.column}`;
    cell.style.textAlign = this.alignment;
    // Editors without the table editing extension still need an empty-cell caret.
    cell.addEventListener("mousedown", event => {
      if (event.defaultPrevented || event.button !== 0 || event.shiftKey) return;
      if (view.state.field(tableInteraction, false) === undefined) {
        event.preventDefault(); view.dispatch({ selection: { anchor: this.sourcePosition } }); view.focus();
      }
    });
    return cell;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

class TableBreakWidget extends WidgetType {
  toDOM(): HTMLElement { return document.createElement("br"); }
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

function tableDecorations(state: EditorState, startLineNumber: number): { entries: DecorationEntry[]; endLineNumber: number } | null {
  const table = tableFromLine(state, startLineNumber);
  if (!table) return null;
  const entries: DecorationEntry[] = [{ from: table.separator.from, to: table.separator.to, decoration: Decoration.replace({ block: true }) }];
  table.rows.forEach((row, rowIndex) => {
    const line = row.line;
    const heading = rowIndex === 0;
    entries.push({ from: line.from, to: line.from, decoration: Decoration.line({ attributes: {
      class: ["mqm-table-row", heading ? "mqm-table-row-start" : "", rowIndex === table.rows.length - 1 ? "mqm-table-row-end" : ""].filter(Boolean).join(" "),
      style: `--mqm-table-columns: ${table.columns}`,
    } }) });
    for (const separator of tableRowRanges(line).separators) entries.push({ from: separator, to: separator + 1, decoration: Decoration.replace({}) });
    for (let column = 0; column < table.columns; column += 1) {
      const cell = row.cells[column];
      const from = cell?.from ?? line.to;
      const alignment = table.alignments[column]!;
      const selected = tableCellSelected(state, table.from, rowIndex, column);
      if (cell && cell.segmentFrom < cell.from) entries.push({ from: cell.segmentFrom, to: cell.from, decoration: Decoration.replace({}) });
      if (cell && cell.to < cell.segmentTo) entries.push({ from: cell.to, to: cell.segmentTo, decoration: Decoration.replace({}) });
      if (cell?.text) {
        entries.push({ from, to: cell.to, allowOverlap: true, decoration: Decoration.mark({ inclusive: true,
          class: ["mqm-table-cell", heading ? "mqm-table-cell-heading" : "", selected ? "mqm-table-cell-selected" : ""].filter(Boolean).join(" "),
          attributes: { "data-table-from": String(table.from), "data-table-cell": `${rowIndex}:${column}`, style: `text-align: ${alignment}` },
        }) });
        for (const range of tableBreakRanges(cell.text)) entries.push({ from: cell.from + range.from, to: cell.from + range.to, decoration: Decoration.replace({ widget: new TableBreakWidget() }) });
      } else entries.push({ from, to: from, decoration: Decoration.widget({ widget: new EmptyTableCellWidget(from, heading, table.from, rowIndex, column, alignment, selected), side: column + 1 }) });
    }
  });
  return { entries, endLineNumber: state.doc.lineAt(table.to).number };
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
    const table = tableDecorations(state, lineNumber);
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
  mathRanges: readonly MathRange[],
): DecorationEntry[] {
  const results: DecorationEntry[] = [];
  syntaxTree(state).iterate({
    from: segment.from,
    to: segment.to,
    enter: (node) => {
      if (/^(?:ATXHeading[1-6]|SetextHeading[12])$/.test(node.name)) {
        const marker = node.node.getChild("HeaderMark");
        // 数式内の = や --- を見出し記号と誤認した場合、前の本文も太字にしない。
        if (marker && !mathRanges.some((math) =>
          marker.from < math.to && marker.to > math.from,
        )) {
          results.push({
            from: node.from,
            to: node.to,
            decoration: Decoration.mark({ class: "mqm-heading-content" }),
            allowOverlap: true,
          });
        }
      }
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
      const link = markdownLink(state, node.node);
      if (!link || link.image || link.labelFrom >= link.labelTo) return;

      const active = editingTouches(state, node.from, node.to);
      if (!active && node.from < link.labelFrom) {
        results.push({
          from: node.from,
          to: link.labelFrom,
          decoration: Decoration.replace({}),
        });
      }
      results.push({
        from: link.labelFrom,
        to: link.labelTo,
        decoration: Decoration.mark({ class: "mqm-link-text" }),
      });
      if (!active && link.labelTo < node.to) {
        results.push({
          from: link.labelTo,
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
    ...inlineMarkerDecorations(state, segment, mathRanges),
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
          widget: new MathWidget(
            math.expression,
            math.display,
            math.from,
            math.openDelimiter,
            math.closeDelimiter,
          ),
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
        widget: new MathWidget(
          math.expression,
          math.display,
          math.from,
          math.openDelimiter,
          math.closeDelimiter,
        ),
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
      transaction.reconfigured || transaction.effects.some(effect => effect.is(tableInteractionEffect))
    ) {
      return buildDecorations(transaction.state);
    }
    return decorations;
  },
  provide: (field) => EditorView.decorations.from(field),
});
