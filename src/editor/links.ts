import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { findMathRanges, type ProtectedRange } from "./math";

type SyntaxNode = ReturnType<typeof syntaxTree>["topNode"];

interface MarkdownLink {
  from: number;
  to: number;
  labelFrom: number;
  labelTo: number;
  image: boolean;
  target: string;
}

export function markdownLink(state: EditorState, node: SyntaxNode): MarkdownLink | null {
  if (node.name === "Link" || node.name === "Image") {
    const marks: SyntaxNode[] = [];
    let url: SyntaxNode | null = null;
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.name === "LinkMark") marks.push(child);
      if (child.name === "URL") url = child;
    }
    const [opening, labelEnd, destinationStart, closing] = marks;
    if (!opening || !labelEnd || !destinationStart || !closing || !url ||
      state.sliceDoc(destinationStart.from, destinationStart.to) !== "(" ||
      state.sliceDoc(closing.from, closing.to) !== ")") return null;
    const target = state.sliceDoc(url.from, url.to).replace(/^<|>$/g, "").replace(/\\([\\()[\]])/g, "$1");
    return { from: node.from, to: node.to, labelFrom: opening.to, labelTo: labelEnd.from, image: node.name === "Image", target };
  }
  if (node.name === "Autolink") {
    const url = node.getChild("URL");
    if (!url) return null;
    let target = state.sliceDoc(url.from, url.to);
    if (!target.includes(":") && target.includes("@")) target = `mailto:${target}`;
    return { from: node.from, to: node.to, labelFrom: url.from, labelTo: url.to, image: false, target };
  }
  if (node.name === "URL" && !["Link", "Image", "Autolink", "LinkReference"].includes(node.parent?.name ?? "")) {
    const prefix = state.sliceDoc(state.doc.lineAt(node.from).from, node.from);
    if (/!?\[[^\]\n]*\]\(\s*<?$/.test(prefix)) return null;
    let target = state.sliceDoc(node.from, node.to);
    if (target.startsWith("www.")) target = `https://${target}`;
    if (!/^https?:\/\//i.test(target)) return null;
    return { from: node.from, to: node.to, labelFrom: node.from, labelTo: node.to, image: false, target };
  }
  return null;
}

export function markdownTargetAt(state: EditorState, position: number): MarkdownLink | null {
  const tree = ensureSyntaxTree(state, position) ?? syntaxTree(state);
  const protectedRanges: ProtectedRange[] = [];
  tree.iterate({ enter: (node) => {
    if (/code|url|link|image/i.test(node.name)) protectedRanges.push({ from: node.from, to: node.to });
  } });
  if (findMathRanges(state.doc.toString(), 0, protectedRanges).some((range) => position >= range.from && position < range.to)) return null;
  let target: MarkdownLink | null = null;
  tree.iterate({ from: position, to: position, enter: (node) => {
    if (/code/i.test(node.name)) return false;
    const link = markdownLink(state, node.node);
    if (link && position >= link.from && position < link.to) {
      target = link;
      return false;
    }
    if (["Link", "Image", "Autolink"].includes(node.name)) return false;
  } });
  return target;
}
