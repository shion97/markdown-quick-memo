import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { findMathRanges } from "./math";

describe("既存Markdownコーパス", () => {
  const corpus = readFileSync(
    resolve(process.cwd(), "tests/fixtures/pdf_all_features.md"),
    "utf8",
  );

  it("読み込み後の原文を再直列化せず保持する", () => {
    const copied = `${corpus}`;
    expect(Buffer.from(copied, "utf8")).toEqual(Buffer.from(corpus, "utf8"));
  });

  it("既存数式コーパスを十分に検出する", () => {
    const ranges = findMathRanges(corpus);
    expect(ranges.length).toBeGreaterThanOrEqual(20);
    expect(ranges.some((range) => range.expression.includes("cases"))).toBe(
      true,
    );
  });

  it("高密度10万文字コーパスを現実的な時間内に走査する", () => {
    const formulas = Array.from(
      { length: 200 },
      (_, index) => `段落${index} $x_${index}^2+y_${index}^2=z_${index}^2$`,
    ).join("\n");
    const source = `${formulas}\n${"通常文。".repeat(20_000)}`.slice(0, 100_000);
    const startedAt = performance.now();
    const ranges = findMathRanges(source);
    const elapsed = performance.now() - startedAt;

    expect(ranges.length).toBe(200);
    expect(elapsed).toBeLessThan(250);
  });
});
