import katex from "katex";

export const MAX_MATH_INPUT_LENGTH = 4_000;
export const MAX_KATEX_EXPANSIONS = 1_000;
export const MAX_KATEX_SIZE = 20;

export interface MathRange {
  from: number;
  to: number;
  expression: string;
  display: boolean;
}

export interface ProtectedRange {
  from: number;
  to: number;
}

const renderedMathCache = new Map<string, string>();
const MAX_CACHE_ENTRIES = 512;

function overlapsProtected(
  from: number,
  to: number,
  protectedRanges: readonly ProtectedRange[],
): boolean {
  return protectedRanges.some(
    (range) =>
      from < range.to && to > range.from &&
      !(from < range.from && range.to < to),
  );
}

export function findMathRanges(
  text: string,
  offset = 0,
  protectedRanges: readonly ProtectedRange[] = [],
): MathRange[] {
  const ranges: MathRange[] = [];
  let index = 0;

  while (index < text.length) {
    if (text[index] === "\\" && text[index + 1] === "$") {
      index += 2;
      continue;
    }
    if (text[index] !== "$") {
      index += 1;
      continue;
    }

    const display = text[index + 1] === "$";
    const delimiterLength = display ? 2 : 1;
    const from = index;
    let end = index + delimiterLength;
    let found = false;
    while (end < text.length) {
      if (text[end] === "\\") {
        end += 2;
        continue;
      }
      if (
        text[end] === "$" &&
        (!display || text[end + 1] === "$")
      ) {
        found = true;
        break;
      }
      if (!display && text[end] === "\n") {
        break;
      }
      end += 1;
    }
    if (!found) {
      index += delimiterLength;
      continue;
    }

    const to = end + delimiterLength;
    const absoluteFrom = offset + from;
    const absoluteTo = offset + to;
    const expression = text.slice(from + delimiterLength, end);
    if (
      expression.trim() !== "" &&
      expression.length <= MAX_MATH_INPUT_LENGTH &&
      !overlapsProtected(absoluteFrom, absoluteTo, protectedRanges)
    ) {
      ranges.push({
        from: absoluteFrom,
        to: absoluteTo,
        expression,
        display,
      });
      index = to;
    } else {
      index += delimiterLength;
    }
  }

  return ranges;
}

export function renderMath(expression: string, display: boolean): string {
  if (expression.length > MAX_MATH_INPUT_LENGTH) {
    throw new Error("数式が長すぎます。");
  }
  const key = `${display ? "d" : "i"}:${expression}`;
  const cached = renderedMathCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const rendered = katex.renderToString(expression, {
    displayMode: display,
    throwOnError: true,
    trust: false,
    strict: "warn",
    maxExpand: MAX_KATEX_EXPANSIONS,
    maxSize: MAX_KATEX_SIZE,
    output: "htmlAndMathml",
  });
  if (renderedMathCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = renderedMathCache.keys().next().value;
    if (oldest !== undefined) {
      renderedMathCache.delete(oldest);
    }
  }
  renderedMathCache.set(key, rendered);
  return rendered;
}

export function clearMathCache(): void {
  renderedMathCache.clear();
}
