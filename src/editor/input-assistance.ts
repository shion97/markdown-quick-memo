import {
  cursorCharBackwardLogical,
  cursorCharForwardLogical,
  cursorLineDown,
  cursorLineUp,
  selectCharBackwardLogical,
  selectCharForwardLogical,
  selectLineDown,
  selectLineUp,
} from "@codemirror/commands";
import { syntaxTree } from "@codemirror/language";
import {
  type ChangeSpec,
  EditorSelection,
  type Extension,
  Prec,
} from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { tableRowRanges } from "./decorations";

interface Continuation {
  replacementFrom?: number;
  replacementTo?: number;
  inserted: string;
}

interface TextChange {
  replacementFrom: number;
  replacementTo: number;
  inserted: string;
}

const LIST_PATTERN =
  /^((?:[ \t]*>[ \t]?)*)([ \t]*)([-+*]|\d+[.)])([ \t]+)(\[[ xX]\][ \t]+)?(.*)$/;
const QUOTE_PATTERN = /^((?:[ \t]*>[ \t]?)+)(.*)$/;
const NORMAL_INDENT = "    ";
const LIST_INDENT = "  ";

function reducedQuotePrefix(prefix: string): string {
  return prefix.slice(0, prefix.lastIndexOf(">"));
}

export function continuationForLine(
  lineText: string,
  cursorOffset: number,
): Continuation {
  const beforeCursor = lineText.slice(0, cursorOffset);
  const list = LIST_PATTERN.exec(beforeCursor);
  if (list) {
    const quote = list[1] ?? "";
    const indent = list[2] ?? "";
    const marker = list[3] ?? "-";
    const spacing = list[4] ?? " ";
    const checkbox = list[5] ?? "";
    const content = list[6] ?? "";
    if (content.trim() === "") {
      return {
        replacementFrom: quote.length,
        replacementTo: beforeCursor.length,
        inserted: "",
      };
    }
    const nextMarker = /^\d/.test(marker) ? "1." : marker;
    const nextCheckbox = checkbox ? "[ ] " : "";
    return {
      inserted: `\n${quote}${indent}${nextMarker}${spacing}${nextCheckbox}`,
    };
  }

  const quote = QUOTE_PATTERN.exec(beforeCursor);
  if (quote) {
    const prefix = quote[1] ?? "";
    const content = quote[2] ?? "";
    if (content.trim() === "") {
      return {
        replacementFrom: 0,
        replacementTo: beforeCursor.length,
        inserted: reducedQuotePrefix(prefix),
      };
    }
    return { inserted: `\n${prefix}` };
  }

  const indentation = /^\s*/.exec(beforeCursor)?.[0] ?? "";
  return { inserted: `\n${indentation}` };
}

export function quoteSpaceDeletionForLine(
  lineText: string,
  cursorOffset: number,
): TextChange | null {
  const beforeCursor = lineText.slice(0, cursorOffset);
  const afterCursor = lineText.slice(cursorOffset);
  const quote = QUOTE_PATTERN.exec(beforeCursor);
  if (
    !quote ||
    (quote[2] ?? "") !== "" ||
    !beforeCursor.endsWith(" ") ||
    afterCursor.trim() !== ""
  ) {
    return null;
  }
  return {
    replacementFrom: cursorOffset - 1,
    replacementTo: cursorOffset,
    inserted: "",
  };
}

function inCodeBlock(view: EditorView, position: number): boolean {
  const node = syntaxTree(view.state).resolveInner(position, -1);
  return node.name.includes("Code") && node.name !== "InlineCode";
}

function insertContinuation(view: EditorView): boolean {
  const selection = view.state.selection.main;
  if (!selection.empty || inCodeBlock(view, selection.head)) {
    return false;
  }
  const line = view.state.doc.lineAt(selection.head);
  const cursorOffset = selection.head - line.from;
  const continuation = continuationForLine(line.text, cursorOffset);
  const replacementFrom =
    line.from + (continuation.replacementFrom ?? cursorOffset);
  const replacementTo = line.from + (continuation.replacementTo ?? cursorOffset);
  view.dispatch({
    changes: {
      from: replacementFrom,
      to: replacementTo,
      insert: continuation.inserted,
    },
    selection: {
      anchor: replacementFrom + continuation.inserted.length,
    },
    userEvent: "input",
  });
  return true;
}

function insertPlainLineBreak(view: EditorView): boolean {
  const selection = view.state.selection.main;
  view.dispatch({
    changes: {
      from: selection.from,
      to: selection.to,
      insert: "\n",
    },
    selection: { anchor: selection.from + 1 },
    userEvent: "input",
  });
  return true;
}

function deleteQuoteSpace(view: EditorView): boolean {
  const selection = view.state.selection.main;
  if (!selection.empty || inCodeBlock(view, selection.head)) {
    return false;
  }
  const line = view.state.doc.lineAt(selection.head);
  const cursorOffset = selection.head - line.from;
  const deletion = quoteSpaceDeletionForLine(line.text, cursorOffset);
  if (!deletion) {
    return false;
  }
  const from = line.from + deletion.replacementFrom;
  view.dispatch({
    changes: {
      from,
      to: line.from + deletion.replacementTo,
      insert: deletion.inserted,
    },
    selection: { anchor: from },
    userEvent: "delete.backward",
  });
  return true;
}

function deleteSoftIndent(view: EditorView): boolean {
  const selection = view.state.selection.main;
  if (view.state.selection.ranges.length !== 1 || !selection.empty) {
    return false;
  }
  const line = view.state.doc.lineAt(selection.head);
  const beforeCursor = line.text.slice(0, selection.head - line.from);
  if (!/^ +$/.test(beforeCursor)) {
    return false;
  }
  const removable = Math.min(NORMAL_INDENT.length, beforeCursor.length);
  view.dispatch({
    changes: { from: selection.head - removable, to: selection.head },
    selection: { anchor: selection.head - removable },
    userEvent: "delete.backward",
  });
  return true;
}

function handleBackspace(view: EditorView): boolean {
  return deleteQuoteSpace(view) || deleteSoftIndent(view);
}

function indentationChange(
  view: EditorView,
  line: { from: number; text: string },
  remove: boolean,
): ChangeSpec | null {
  const list = inCodeBlock(view, line.from)
    ? null
    : LIST_PATTERN.exec(line.text);
  const quoteLength = (list?.[1] ?? "").length;
  const indentation = list?.[2] ?? /^ */.exec(line.text)?.[0] ?? "";
  const indentationPosition = line.from + quoteLength;
  const indent = list ? LIST_INDENT : NORMAL_INDENT;
  if (!remove) {
    return { from: indentationPosition, insert: indent };
  }
  const removable = Math.min(indent.length, indentation.length);
  return removable === 0
    ? null
    : { from: indentationPosition, to: indentationPosition + removable };
}

function changeSelectedLines(view: EditorView, remove: boolean): void {
  const selection = view.state.selection.main;
  const changes: ChangeSpec[] = [];
  for (let position = selection.from; position <= selection.to; ) {
    const line = view.state.doc.lineAt(position);
    if (selection.empty || selection.to > line.from) {
      const change = indentationChange(view, line, remove);
      if (change) {
        changes.push(change);
      }
    }
    position = line.to + 1;
  }
  const changeSet = view.state.changes(changes);
  view.dispatch({
    changes: changeSet,
    selection: EditorSelection.range(
      changeSet.mapPos(selection.anchor, 1),
      changeSet.mapPos(selection.head, 1),
    ),
    userEvent: "input.indent",
  });
}

function handleTab(view: EditorView, remove: boolean): boolean {
  const selection = view.state.selection.main;
  if (!selection.empty) {
    changeSelectedLines(view, remove);
    return true;
  }
  const line = view.state.doc.lineAt(selection.head);
  const list = inCodeBlock(view, line.from) ? null : LIST_PATTERN.exec(line.text);
  if (list || remove) {
    const change = indentationChange(view, line, remove);
    if (change) {
      view.dispatch({ changes: change, userEvent: "input.indent" });
    }
    return true;
  }
  view.dispatch({
    changes: { from: selection.head, insert: NORMAL_INDENT },
    selection: { anchor: selection.head + NORMAL_INDENT.length },
    userEvent: "input",
  });
  return true;
}

function insideTable(view: EditorView, position: number): boolean {
  let node = syntaxTree(view.state).resolveInner(position, 1);
  while (true) {
    if (node.name === "Table") {
      return true;
    }
    const parent = node.parent;
    if (!parent) {
      return false;
    }
    node = parent;
  }
}

function moveAcrossTableCellBoundary(
  view: EditorView,
  direction: "backward" | "forward",
): boolean {
  const selection = view.state.selection.main;
  const line = view.state.doc.lineAt(selection.head);
  if (
    view.state.selection.ranges.length !== 1 ||
    !selection.empty ||
    !insideTable(view, line.from)
  ) {
    return false;
  }
  const cells = tableRowRanges(line).cells;
  const cellIndex = cells.findIndex(
    (cell) => selection.head >= cell.from && selection.head <= cell.to,
  );
  const currentCell = cellIndex >= 0 ? cells[cellIndex] : undefined;
  const target = currentCell
    ? direction === "forward" && selection.head === currentCell.to
      ? cells[cellIndex + 1]?.from
      : direction === "backward" && selection.head === currentCell.from
        ? cells[cellIndex - 1]?.to
        : undefined
    : direction === "forward" && selection.head < (cells[0]?.from ?? 0)
      ? cells[0]?.from
      : direction === "backward" &&
          selection.head > (cells[cells.length - 1]?.to ?? line.to)
        ? cells[cells.length - 1]?.to
        : undefined;
  if (target === undefined) {
    return false;
  }
  view.dispatch({
    selection: { anchor: target },
    scrollIntoView: true,
    userEvent: "select",
  });
  return true;
}

function moveCursorBackward(view: EditorView): boolean {
  return (
    moveAcrossTableCellBoundary(view, "backward") ||
    cursorCharBackwardLogical(view)
  );
}

function moveCursorForward(view: EditorView): boolean {
  return (
    moveAcrossTableCellBoundary(view, "forward") ||
    cursorCharForwardLogical(view)
  );
}

export function createPairInputHandler(): (
  view: EditorView,
  from: number,
  to: number,
  text: string,
) => boolean {
  const pairs: Record<string, string> = {
    "(": ")",
    "[": "]",
    "{": "}",
    '"': '"',
    "'": "'",
    "`": "`",
  };
  let pendingClosing: { character: string; position: number } | undefined;
  let skippedClosingCharacter: string | undefined;

  return (view, from, to, text) => {
    const expectedClosing = pendingClosing;
    const previouslySkippedClosing = skippedClosingCharacter;
    pendingClosing = undefined;
    skippedClosingCharacter = undefined;
    if (view.composing) {
      return false;
    }
    if (
      text === "`" &&
      view.state.doc.sliceString(Math.max(0, from - 2), from) === "``"
    ) {
      view.dispatch({
        changes: { from, to, insert: "`\n\n```" },
        selection: { anchor: from + 2 },
        userEvent: "input",
      });
      return true;
    }
    if (text === previouslySkippedClosing) {
      return false;
    }
    if (
      expectedClosing &&
      text === expectedClosing.character &&
      from === to &&
      from === expectedClosing.position &&
      view.state.doc.sliceString(from, from + 1) === expectedClosing.character
    ) {
      view.dispatch({ selection: { anchor: from + 1 } });
      skippedClosingCharacter = text;
      return true;
    }

    const closing = pairs[text];
    if (!closing) {
      return false;
    }

    const selection = view.state.selection.main;
    if (!selection.empty) {
      const selected = view.state.doc.sliceString(selection.from, selection.to);
      view.dispatch({
        changes: {
          from: selection.from,
          to: selection.to,
          insert: `${text}${selected}${closing}`,
        },
        selection: EditorSelection.range(
          selection.from + 1,
          selection.to + 1,
        ),
        userEvent: "input",
      });
      return true;
    }

    view.dispatch({
      changes: { from, to, insert: `${text}${closing}` },
      selection: { anchor: from + 1 },
      userEvent: "input",
    });
    pendingClosing = { character: closing, position: from + 1 };
    return true;
  };
}

export function markdownInputAssistance(): Extension {
  return [
    Prec.highest(
      keymap.of([
        { key: "Enter", run: insertContinuation },
        { key: "Backspace", run: handleBackspace },
        { key: "Shift-Enter", run: insertPlainLineBreak },
        { key: "Tab", run: (view) => handleTab(view, false) },
        { key: "Shift-Tab", run: (view) => handleTab(view, true) },
        { key: "ArrowLeft", run: moveCursorBackward },
        { key: "ArrowRight", run: moveCursorForward },
        { key: "ArrowUp", run: cursorLineUp },
        { key: "ArrowDown", run: cursorLineDown },
        { key: "Shift-ArrowLeft", run: selectCharBackwardLogical },
        { key: "Shift-ArrowRight", run: selectCharForwardLogical },
        { key: "Shift-ArrowUp", run: selectLineUp },
        { key: "Shift-ArrowDown", run: selectLineDown },
      ]),
    ),
    EditorView.inputHandler.of(createPairInputHandler()),
  ];
}
