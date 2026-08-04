import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

export interface OutlineHeading {
  level: number;
  label: string;
  position: number;
}

export function extractOutline(state: EditorState): OutlineHeading[] {
  const headings: OutlineHeading[] = [];
  syntaxTree(state).iterate({
    enter: (node) => {
      const match = /^ATXHeading([1-6])$/.exec(node.name);
      if (!match) {
        return;
      }
      const line = state.doc.lineAt(node.from);
      const source = line.text.replace(/^\s{0,3}#{1,6}[ \t]+/, "");
      const label = source.replace(/[ \t]+#+[ \t]*$/, "").trim();
      if (!label || /^#+$/.test(label)) {
        return;
      }
      headings.push({
        level: Number(match[1]),
        label,
        position: line.from,
      });
    },
  });
  return headings;
}

export function navigateToHeading(
  view: EditorView,
  position: number,
): void {
  view.dispatch({
    selection: { anchor: position },
    scrollIntoView: true,
  });
  view.focus();
}
