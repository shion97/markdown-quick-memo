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
import { EditorSelection, type Extension, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";

interface Continuation {
  replacementFrom?: number;
  replacementTo?: number;
  inserted: string;
}

const LIST_PATTERN =
  /^((?:[ \t]*>[ \t]?)*)([ \t]*)([-+*]|\d+[.)])([ \t]+)(\[[ xX]\][ \t]+)?(.*)$/;
const QUOTE_PATTERN = /^((?:[ \t]*>[ \t]?)+)(.*)$/;

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
        inserted: "\n",
      };
    }
    return { inserted: `\n${prefix}` };
  }

  const indentation = /^\s*/.exec(beforeCursor)?.[0] ?? "";
  return { inserted: `\n${indentation}` };
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

function indentList(view: EditorView, remove: boolean): boolean {
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  const list = LIST_PATTERN.exec(line.text);
  if (!list) {
    return false;
  }
  const quoteLength = (list[1] ?? "").length;
  const indentLength = (list[2] ?? "").length;
  const indentationPosition = line.from + quoteLength;
  if (remove) {
    const removable = Math.min(2, indentLength);
    if (removable === 0) {
      return true;
    }
    view.dispatch({
      changes: {
        from: indentationPosition,
        to: indentationPosition + removable,
        insert: "",
      },
      userEvent: "input",
    });
  } else {
    view.dispatch({
      changes: { from: indentationPosition, insert: "  " },
      userEvent: "input",
    });
  }
  return true;
}

function handleTab(view: EditorView, remove: boolean): boolean {
  indentList(view, remove);
  return true;
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
        { key: "Shift-Enter", run: insertPlainLineBreak },
        { key: "Tab", run: (view) => handleTab(view, false) },
        { key: "Shift-Tab", run: (view) => handleTab(view, true) },
        { key: "ArrowLeft", run: cursorCharBackwardLogical },
        { key: "ArrowRight", run: cursorCharForwardLogical },
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
