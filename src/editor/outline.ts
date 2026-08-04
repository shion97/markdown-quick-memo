import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

export interface OutlineHeading {
  level: number;
  label: string;
  position: number;
}

export interface OutlineNode extends OutlineHeading {
  key: string;
  children: OutlineNode[];
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

export function buildOutlineTree(headings: readonly OutlineHeading[]): OutlineNode[] {
  const roots: OutlineNode[] = [];
  const ancestors: OutlineNode[] = [];
  const siblingOccurrences = new Map<string, number>();

  for (const heading of headings) {
    while (
      ancestors.length > 0 &&
      ancestors[ancestors.length - 1]!.level >= heading.level
    ) {
      ancestors.pop();
    }

    const parent = ancestors[ancestors.length - 1];
    const parentKey = parent?.key ?? "root";
    const signature = `${parentKey}/${heading.level}:${encodeURIComponent(heading.label)}`;
    const occurrence = (siblingOccurrences.get(signature) ?? 0) + 1;
    siblingOccurrences.set(signature, occurrence);

    const node: OutlineNode = {
      ...heading,
      key: `${signature}:${occurrence}`,
      children: [],
    };
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
    ancestors.push(node);
  }

  return roots;
}

export function navigateToHeading(
  view: EditorView,
  position: number,
): void {
  view.dispatch({
    selection: { anchor: position },
    effects: EditorView.scrollIntoView(position, { y: "start" }),
  });
  view.focus();
}
