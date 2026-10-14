import hljs from "highlight.js/lib/common";
import julia from "highlight.js/lib/languages/julia";
import MarkdownIt, { type PluginSimple } from "markdown-it";
import type StateBlock from "markdown-it/lib/rules_block/state_block.mjs";
import type StateInline from "markdown-it/lib/rules_inline/state_inline.mjs";
import { renderMath } from "./editor/math";
import { EditorState } from "@codemirror/state";
import { tableBreakRanges, tableFromLine, tableMatrix } from "./editor/tables";

hljs.registerLanguage("julia", julia);
hljs.registerAliases("jl", { languageName: "julia" });

const mathPlugin: PluginSimple = (markdown) => {
  markdown.inline.ruler.before(
    "escape",
    "math_inline",
    (state: StateInline, silent: boolean): boolean => {
      const parenthesized = state.src.startsWith("\\(", state.pos);
      const dollar =
        state.src[state.pos] === "$" &&
        state.src[state.pos + 1] !== "$" &&
        (state.pos === 0 || state.src[state.pos - 1] !== "\\");
      if (!parenthesized && !dollar) {
        return false;
      }
      const openDelimiter = parenthesized ? "\\(" : "$";
      const closeDelimiter = parenthesized ? "\\)" : "$";
      let end = state.pos + openDelimiter.length;
      while (end < state.posMax) {
        if (state.src.startsWith(closeDelimiter, end)) {
          break;
        }
        if (state.src[end] === "\\") {
          end += 2;
          continue;
        }
        if (state.src[end] === "\n") {
          return false;
        }
        end += 1;
      }
      if (end >= state.posMax || !state.src.startsWith(closeDelimiter, end)) {
        return false;
      }
      const expression = state.src.slice(state.pos + openDelimiter.length, end);
      if (expression.trim() === "") {
        return false;
      }
      if (!silent) {
        const token = state.push("math_inline", "math", 0);
        token.content = expression;
        token.meta = { openDelimiter, closeDelimiter };
      }
      state.pos = end + closeDelimiter.length;
      return true;
    },
  );

  markdown.block.ruler.before(
    "fence",
    "math_display",
    (
      state: StateBlock,
      startLine: number,
      endLine: number,
      silent: boolean,
    ): boolean => {
      const start = state.bMarks[startLine]! + state.tShift[startLine]!;
      const lineEnd = state.eMarks[startLine]!;
      const firstLine = state.src.slice(start, lineEnd);
      if (!firstLine.startsWith("$$")) {
        return false;
      }
      let expression = firstLine.slice(2);
      let nextLine = startLine;
      if (expression.endsWith("$$") && expression.length > 2) {
        expression = expression.slice(0, -2);
      } else {
        let found = false;
        for (nextLine = startLine + 1; nextLine < endLine; nextLine += 1) {
          const from = state.bMarks[nextLine]! + state.tShift[nextLine]!;
          const to = state.eMarks[nextLine]!;
          const line = state.src.slice(from, to);
          const closing = line.indexOf("$$");
          if (closing >= 0) {
            expression += `\n${line.slice(0, closing)}`;
            found = true;
            break;
          }
          expression += `\n${line}`;
        }
        if (!found) {
          return false;
        }
      }
      if (silent) {
        return true;
      }
      const token = state.push("math_display", "math", 0);
      token.block = true;
      token.content = expression.trim();
      token.map = [startLine, nextLine + 1];
      state.line = nextLine + 1;
      return true;
    },
    { alt: ["paragraph", "reference", "blockquote", "list"] },
  );

  markdown.renderer.rules.math_inline = (tokens, index) => {
    const expression = tokens[index]?.content ?? "";
    const metadata = tokens[index]?.meta as
      | { openDelimiter?: string; closeDelimiter?: string }
      | null;
    const openDelimiter = metadata?.openDelimiter ?? "$";
    const closeDelimiter = metadata?.closeDelimiter ?? "$";
    try {
      return `<span class="print-math-inline">${renderMath(expression, false)}</span>`;
    } catch {
      return `<code>${markdown.utils.escapeHtml(`${openDelimiter}${expression}${closeDelimiter}`)}</code>`;
    }
  };
  markdown.renderer.rules.math_display = (tokens, index) => {
    const expression = tokens[index]?.content ?? "";
    try {
      return `<div class="print-math-display">${renderMath(expression, true)}</div>`;
    } catch {
      return `<div class="print-math-fallback">${markdown.utils.escapeHtml(`$$${expression}$$`)}</div>`;
    }
  };
};

const renderer = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
  typographer: false,
  highlight(code, language) {
    const normalizedLanguage = language.trim().toLowerCase();
    if (!normalizedLanguage || !hljs.getLanguage(normalizedLanguage)) {
      return "";
    }
    return hljs.highlight(code, {
      language: normalizedLanguage,
      ignoreIllegals: true,
    }).value;
  },
}).use(mathPlugin);

// Use the same cell boundaries as the editor, without enabling arbitrary HTML.
renderer.block.ruler.at("table", (state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean => {
  if (startLine + 1 >= endLine || state.sCount[startLine]! - state.blkIndent >= 4) return false;
  const lines: string[] = [];
  for (let line = startLine; line < endLine; line += 1) {
    const content = state.src.slice(state.bMarks[line]! + state.tShift[line]!, state.eMarks[line]!);
    if (line > startLine + 1 && (!content.includes("|") || state.sCount[line]! < state.blkIndent)) break;
    lines.push(content);
  }
  const table = tableFromLine(EditorState.create({ doc: lines.join("\n") }), 1);
  if (!table) return false;
  if (silent) return true;
  const finalLine = startLine + table.rows.length + 1;
  const open = state.push("table_open", "table", 1);
  open.block = true; open.map = [startLine, finalLine];
  const rows = tableMatrix(table);
  rows.forEach((row, rowIndex) => {
    const heading = rowIndex === 0;
    if (heading) state.push("thead_open", "thead", 1);
    else if (rowIndex === 1) state.push("tbody_open", "tbody", 1);
    state.push("tr_open", "tr", 1);
    row.forEach((text, column) => {
      const tag = heading ? "th" : "td";
      const token = state.push(`${tag}_open`, tag, 1);
      token.attrSet("style", `text-align: ${table.alignments[column]}`);
      const inline = state.push("inline", "", 0);
      inline.content = text;
      for (const range of tableBreakRanges(text).reverse()) inline.content = inline.content.slice(0, range.from) + "\\\n" + inline.content.slice(range.to);
      inline.children = [];
      state.push(`${tag}_close`, tag, -1);
    });
    state.push("tr_close", "tr", -1);
    if (heading) state.push("thead_close", "thead", -1);
  });
  if (rows.length > 1) state.push("tbody_close", "tbody", -1);
  state.push("table_close", "table", -1);
  state.line = finalLine;
  return true;
});

function firstTextNode(
  element: HTMLElement,
): ReturnType<typeof document.createTextNode> | null {
  const walker = document.createTreeWalker(
    element,
    globalThis.NodeFilter.SHOW_TEXT,
  );
  return walker.nextNode() as ReturnType<typeof document.createTextNode> | null;
}

function decoratePrintMarkup(target: HTMLElement): void {
  for (const heading of target.querySelectorAll<HTMLElement>(
    "h1, h2, h3, h4, h5, h6",
  )) {
    heading.classList.add(
      "mqm-heading",
      `mqm-heading-${heading.tagName.slice(1)}`,
    );
  }
  for (const inlineCode of target.querySelectorAll<HTMLElement>(
    "code:not(pre code)",
  )) {
    inlineCode.classList.add("mqm-inline-code");
  }
  for (const codeBlock of target.querySelectorAll<HTMLElement>(
    "pre:not(.print-math-fallback)",
  )) {
    codeBlock.classList.add("mqm-print-code-block");
    const code = codeBlock.querySelector<HTMLElement>("code");
    const languageClass = Array.from(code?.classList ?? []).find((className) =>
      className.startsWith("language-"),
    );
    const language = languageClass?.slice("language-".length);
    if (language) {
      const label = document.createElement("span");
      label.className = "mqm-code-language mqm-print-code-language";
      label.textContent = language;
      label.setAttribute("aria-label", `コード言語: ${language}`);
      codeBlock.prepend(label);
    }
  }
  for (const quote of target.querySelectorAll<HTMLElement>("blockquote")) {
    quote.classList.add("mqm-print-quote");
  }
  for (const table of target.querySelectorAll<HTMLElement>("table")) {
    table.classList.add("mqm-table");
  }
  for (const rule of target.querySelectorAll<HTMLElement>("hr")) {
    rule.classList.add("mqm-horizontal-rule");
  }
  for (const list of target.querySelectorAll<HTMLElement>("ul, ol")) {
    list.classList.add("mqm-print-list");
  }
  for (const listItem of target.querySelectorAll<HTMLElement>("li")) {
    listItem.classList.add("mqm-print-list-item");
    const textNode = firstTextNode(listItem);
    const checkbox = /^\[([ xX])\][ \t]+/.exec(textNode?.data ?? "");
    if (!textNode || !checkbox) {
      continue;
    }
    const checked = checkbox[1]?.toLowerCase() === "x";
    textNode.data = textNode.data.slice(checkbox[0].length);
    const checkboxElement = document.createElement("span");
    checkboxElement.className = checked
      ? "mqm-checkbox mqm-checkbox-checked"
      : "mqm-checkbox";
    checkboxElement.textContent = checked ? "✓" : "";
    checkboxElement.setAttribute(
      "aria-label",
      checked ? "チェック済み" : "未チェック",
    );
    textNode.parentNode?.insertBefore(checkboxElement, textNode);
    listItem.classList.add("mqm-print-task-item");
  }
}

function imageLoaded(image: HTMLImageElement): Promise<void> {
  if (image.complete) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    image.addEventListener("load", () => resolve(), { once: true });
    image.addEventListener("error", () => resolve(), { once: true });
  });
}

export async function preparePrintDocument(
  markdown: string,
  target: HTMLElement,
  resolveLocalImage: (path: string) => Promise<string>,
): Promise<void> {
  target.classList.add("print-root-preparing");
  try {
    target.innerHTML = renderer.render(markdown);
    decoratePrintMarkup(target);
    const images = [...target.querySelectorAll<HTMLImageElement>("img")];
    await Promise.all(
      images.map(async (image) => {
        const source = image.getAttribute("src") ?? "";
        if (/^https?:\/\//i.test(source)) {
          const replacement = document.createElement("span");
          replacement.className = "print-image-blocked";
          replacement.textContent = `外部画像（取得しません）: ${image.alt || source}`;
          image.replaceWith(replacement);
          return;
        }
        try {
          image.src = await resolveLocalImage(source);
          await imageLoaded(image);
        } catch {
          const replacement = document.createElement("span");
          replacement.className = "print-image-missing";
          replacement.textContent = `画像を読み込めません: ${image.alt || source}`;
          image.replaceWith(replacement);
        }
      }),
    );
    target.getBoundingClientRect();
    if (document.fonts) {
      await document.fonts.ready;
    }
    if (typeof window.requestAnimationFrame === "function") {
      await new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => {
          window.requestAnimationFrame(() => resolve());
        });
      });
    }
  } finally {
    target.classList.remove("print-root-preparing");
  }
}
