import { describe, expect, it } from "vitest";
import {
  findMathRanges,
  MAX_MATH_INPUT_LENGTH,
  renderMath,
} from "./math";

describe("findMathRanges", () => {
  it("インライン数式と独立数式を検出する", () => {
    const source = "前 $x^2$ 後\n$$\\frac{a}{b}$$";
    const ranges = findMathRanges(source);

    expect(ranges).toHaveLength(2);
    expect(ranges[0]).toMatchObject({ expression: "x^2", display: false });
    expect(ranges[1]).toMatchObject({
      expression: "\\frac{a}{b}",
      display: true,
    });
  });

  it("エスケープと保護範囲内のドル記号を除外する", () => {
    const source = "\\$escaped$ `code $x$` $valid$";
    const codeStart = source.indexOf("`code");
    const codeEnd = source.indexOf("`", codeStart + 1) + 1;
    const ranges = findMathRanges(source, 0, [
      { from: codeStart, to: codeEnd },
    ]);

    expect(ranges.map((range) => range.expression)).toEqual(["valid"]);
  });

  it("上限を超える数式をDecoration候補にしない", () => {
    const expression = "x".repeat(MAX_MATH_INPUT_LENGTH + 1);
    expect(findMathRanges(`$${expression}$`)).toEqual([]);
  });

  it("数式に完全に含まれるリンク風の範囲は数式の認識を妨げない", () => {
    const source = "$[a](b) + <x>$";
    expect(findMathRanges(source, 0, [{ from: 1, to: 7 }])).toHaveLength(1);
  });

  it.each(["`$x$`", "[label $x$](url)", "![label $x$](image)"])(
    "数式を含むコード・リンク・画像は保護する: %s", (source) => {
      expect(findMathRanges(source, 0, [{ from: 0, to: source.length }])).toEqual([]);
    },
  );
});

describe("renderMath", () => {
  it("危険なHTMLを信頼せずKaTeX HTMLを生成する", () => {
    const html = renderMath("\\href{javascript:alert(1)}{x}", false);
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain("onclick=");
  });
});
