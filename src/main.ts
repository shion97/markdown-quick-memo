import "katex/dist/katex.min.css";
import "./styles.css";
import { MarkdownQuickMemoApplication } from "./app";

const root = document.querySelector<HTMLElement>("#app");
if (!root) {
  throw new Error("アプリケーションのルート要素が見つかりません。");
}

const application = new MarkdownQuickMemoApplication(root);
application.initialize().catch((error: unknown) => {
  root.innerHTML = `
    <main class="fatal-error">
      <h1>Markdown Quick Memoを初期化できませんでした</h1>
      <pre></pre>
    </main>
  `;
  const details = root.querySelector("pre");
  if (details) {
    details.textContent = error instanceof Error ? error.message : String(error);
  }
});
