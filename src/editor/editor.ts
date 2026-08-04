import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";
import {
  closeSearchPanel,
  openSearchPanel,
  search,
  searchKeymap,
  searchPanelOpen,
} from "@codemirror/search";
import { EditorState, Prec, type Extension } from "@codemirror/state";
import {
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightSpecialChars,
  keymap,
  scrollPastEnd,
} from "@codemirror/view";
import { GFM } from "@lezer/markdown";
import { markdownDecorations } from "./decorations";
import { markdownInputAssistance } from "./input-assistance";
import { requestCompleteOutline, type OutlineHeading } from "./outline";

export interface EditorCallbacks {
  onDocumentChanged: (content: string) => void;
  onCountsChanged: (characters: number, words: number) => void;
  onOutlineChanged: (headings: OutlineHeading[]) => void;
  onCursorChanged: (line: number, column: number) => void;
  onControlClick: (position: number) => void;
}

const editorExtensions = new WeakMap<EditorView, readonly Extension[]>();

const japaneseSearchPhrases: Record<string, string> = {
  Find: "検索",
  Replace: "置換",
  next: "次へ",
  previous: "前へ",
  all: "すべて選択",
  "match case": "大文字・小文字を区別",
  regexp: "正規表現",
  "by word": "単語単位",
  replace: "置換",
  "replace all": "すべて置換",
  close: "閉じる",
  "current match": "現在の一致",
  "on line": "行",
};

function toggleSearchPanel(view: EditorView): boolean {
  return searchPanelOpen(view.state)
    ? closeSearchPanel(view)
    : openSearchPanel(view);
}

function editorTheme(): Extension {
  return EditorView.theme({
    "&": {
      height: "100%",
      fontSize: "16px",
    },
    ".cm-scroller": {
      fontFamily: "'BIZ UDGothic', 'Yu Gothic UI', 'Segoe UI', sans-serif",
      lineHeight: "1.75",
      overflow: "auto",
    },
    ".cm-content": {
      padding: "26px clamp(24px, 5vw, 72px) 42px",
      maxWidth: "1040px",
      margin: "0 auto",
      width: "100%",
      caretColor: "var(--accent)",
    },
    ".cm-line": {
      padding: "0 2px",
    },
    ".cm-activeLine": {
      backgroundColor: "color-mix(in srgb, var(--accent) 6%, transparent)",
    },
    ".cm-selectionBackground, ::selection": {
      backgroundColor: "color-mix(in srgb, var(--accent) 25%, transparent) !important",
    },
    "&.cm-focused": {
      outline: "none",
    },
  });
}

function countWords(content: string): number {
  const latinWords = content.match(/[A-Za-z0-9_]+/g)?.length ?? 0;
  const japaneseRuns =
    content.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu)
      ?.length ?? 0;
  return latinWords + japaneseRuns;
}

export function documentCounts(content: string): {
  characters: number;
  words: number;
} {
  return { characters: content.length, words: countWords(content) };
}

export function createEditor(
  parent: HTMLElement,
  callbacks: EditorCallbacks,
): EditorView {
  let countTimer: number | undefined;
  let cancelOutlineRefresh: (() => void) | undefined;
  const extensions: Extension[] = [
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    highlightActiveLine(),
    markdown({
      base: markdownLanguage,
      extensions: [GFM],
    }),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    EditorState.phrases.of(japaneseSearchPhrases),
    search({ top: true }),
    Prec.highest(
      keymap.of([
        {
          key: "Mod-f",
          run: toggleSearchPanel,
          scope: "editor search-panel",
        },
      ]),
    ),
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
    markdownInputAssistance(),
    markdownDecorations,
    editorTheme(),
    EditorView.lineWrapping,
    scrollPastEnd(),
    EditorView.updateListener.of((update) => {
      if (update.docChanged || update.selectionSet) {
        const head = update.state.selection.main.head;
        const line = update.state.doc.lineAt(head);
        callbacks.onCursorChanged(line.number, head - line.from + 1);
      }
      if (!update.docChanged) {
        return;
      }
      const content = update.state.doc.toString();
      callbacks.onDocumentChanged(content);
      if (countTimer !== undefined) {
        window.clearTimeout(countTimer);
      }
      countTimer = window.setTimeout(() => {
        const counts = documentCounts(content);
        callbacks.onCountsChanged(counts.characters, counts.words);
        cancelOutlineRefresh?.();
        cancelOutlineRefresh = requestCompleteOutline(
          update.view,
          callbacks.onOutlineChanged,
        );
      }, 120);
    }),
    EditorView.domEventHandlers({
      mousedown: (event, view) => {
        if (!(event.ctrlKey || event.metaKey)) {
          return false;
        }
        const position = view.posAtCoords({
          x: event.clientX,
          y: event.clientY,
        });
        if (position === null) {
          return false;
        }
        callbacks.onControlClick(position);
        return true;
      },
    }),
  ];
  const state = EditorState.create({
    doc: "",
    extensions,
  });
  const view = new EditorView({ state, parent });
  editorExtensions.set(view, extensions);
  return view;
}

export function replaceDocument(view: EditorView, content: string): void {
  const extensions = editorExtensions.get(view);
  if (!extensions) {
    throw new Error("エディター設定を復元できません。");
  }
  view.setState(EditorState.create({ doc: content, extensions }));
}
