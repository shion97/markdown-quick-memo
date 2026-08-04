// @vitest-environment jsdom

import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { GFM } from "@lezer/markdown";
import { afterEach, describe, expect, it } from "vitest";
import { buildOutlineTree, extractOutline, navigateToHeading } from "./outline";

const views: EditorView[] = [];

function createState(source: string): EditorState {
  return EditorState.create({
    doc: source,
    extensions: [
      markdown({
        base: markdownLanguage,
        extensions: [GFM],
      }),
    ],
  });
}

afterEach(() => {
  for (const view of views.splice(0)) {
    view.destroy();
  }
  document.body.replaceChildren();
});

describe("extractOutline", () => {
  it("ATX見出しの深さ、表示名、位置を抽出する", () => {
    const source = "# 見出し1\n本文\n### 見出し3 ###\n###### 見出し6";

    expect(extractOutline(createState(source))).toEqual([
      { level: 1, label: "見出し1", position: 0 },
      { level: 3, label: "見出し3", position: source.indexOf("###") },
      { level: 6, label: "見出し6", position: source.indexOf("######") },
    ]);
  });

  it("コード内の記号、Setext見出し、空見出しを除外する", () => {
    const source = [
      "```md",
      "# コード内",
      "```",
      "",
      "Setext見出し",
      "---",
      "",
      "### ###",
      "",
      "## 対象",
    ].join("\n");

    expect(extractOutline(createState(source))).toEqual([
      { level: 2, label: "対象", position: source.indexOf("## 対象") },
    ]);
  });

  it("同名見出しを位置の異なる項目として保持する", () => {
    const source = "# 同名\n\n# 同名";

    expect(extractOutline(createState(source))).toEqual([
      { level: 1, label: "同名", position: 0 },
      { level: 1, label: "同名", position: source.lastIndexOf("#") },
    ]);
  });
});

describe("buildOutlineTree", () => {
  it("見出しレベルが飛んでも直前の浅い見出しへ接続する", () => {
    const headings = extractOutline(
      createState("# 親\n### 子\n#### 孫\n## 兄弟\n# 次の親"),
    );

    const tree = buildOutlineTree(headings);

    expect(tree).toHaveLength(2);
    expect(tree[0]?.label).toBe("親");
    expect(tree[0]?.children.map((node) => node.label)).toEqual(["子", "兄弟"]);
    expect(tree[0]?.children[0]?.children[0]?.label).toBe("孫");
    expect(tree[1]?.label).toBe("次の親");
  });

  it("同名見出しへ位置に依存しない異なるキーを割り当てる", () => {
    const first = buildOutlineTree(
      extractOutline(createState("# 親\n## 同名\n## 同名")),
    );
    const shifted = buildOutlineTree(
      extractOutline(createState("本文\n# 親\n## 同名\n## 同名")),
    );

    expect(first[0]?.key).toBe(shifted[0]?.key);
    expect(first[0]?.children[0]?.key).toBe(shifted[0]?.children[0]?.key);
    expect(first[0]?.children[0]?.key).not.toBe(first[0]?.children[1]?.key);
  });
});

describe("navigateToHeading", () => {
  it("該当見出しへカーソルとフォーカスを移す", () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({
      state: createState("本文\n\n## 移動先"),
      parent,
    });
    views.push(view);
    const [heading] = extractOutline(view.state);

    navigateToHeading(view, heading!.position);

    expect(view.state.selection.main.head).toBe(heading?.position);
    expect(view.hasFocus).toBe(true);
  });
});
