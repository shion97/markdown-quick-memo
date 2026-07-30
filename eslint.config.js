import eslint from "@eslint/js";
import parser from "@typescript-eslint/parser";
import typescript from "@typescript-eslint/eslint-plugin";

export default [
  {
    ignores: [
      ".venv/**",
      "build/**",
      "dist/**",
      "dist-web/**",
      "node_modules/**",
      "src-tauri/target/**",
    ],
  },
  eslint.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
      globals: {
        document: "readonly",
        window: "readonly",
        performance: "readonly",
        HTMLElement: "readonly",
        HTMLButtonElement: "readonly",
        HTMLDialogElement: "readonly",
        HTMLInputElement: "readonly",
        HTMLImageElement: "readonly",
        KeyboardEvent: "readonly",
        MouseEvent: "readonly",
        Event: "readonly",
        CustomEvent: "readonly",
        Node: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        process: "readonly",
        Buffer: "readonly",
      },
    },
    plugins: {
      "@typescript-eslint": typescript,
    },
    rules: {
      ...typescript.configs.recommended.rules,
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
];
