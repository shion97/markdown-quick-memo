import MarkdownIt, { type PluginSimple } from "markdown-it";
import type StateBlock from "markdown-it/lib/rules_block/state_block.mjs";
import type StateInline from "markdown-it/lib/rules_inline/state_inline.mjs";
import { renderMath } from "./editor/math";

const mathPlugin: PluginSimple = (markdown) => {
  markdown.inline.ruler.before(
    "escape",
    "math_inline",
    (state: StateInline, silent: boolean): boolean => {
      if (
        state.src[state.pos] !== "$" ||
        state.src[state.pos + 1] === "$" ||
        (state.pos > 0 && state.src[state.pos - 1] === "\\")
      ) {
        return false;
      }
      let end = state.pos + 1;
      while (end < state.posMax) {
        if (state.src[end] === "\\") {
          end += 2;
          continue;
        }
        if (state.src[end] === "$") {
          break;
        }
        if (state.src[end] === "\n") {
          return false;
        }
        end += 1;
      }
      if (end >= state.posMax || state.src[end] !== "$") {
        return false;
      }
      const expression = state.src.slice(state.pos + 1, end);
      if (expression.trim() === "") {
        return false;
      }
      if (!silent) {
        const token = state.push("math_inline", "math", 0);
        token.content = expression;
      }
      state.pos = end + 1;
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
    try {
      return `<span class="print-math-inline">${renderMath(expression, false)}</span>`;
    } catch {
      return `<code>${markdown.utils.escapeHtml(`$${expression}$`)}</code>`;
    }
  };
  markdown.renderer.rules.math_display = (tokens, index) => {
    const expression = tokens[index]?.content ?? "";
    try {
      return `<div class="print-math-display">${renderMath(expression, true)}</div>`;
    } catch {
      return `<pre>${markdown.utils.escapeHtml(`$$${expression}$$`)}</pre>`;
    }
  };
};

const renderer = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
  typographer: false,
}).use(mathPlugin);

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
  target.innerHTML = renderer.render(markdown);
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
}
