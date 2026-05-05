import js from "@eslint/js";
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import globals from "globals";

export default [
  js.configs.recommended,
  {
    files: ["src/**/*.ts", "tests/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 2023, sourceType: "module" },
      globals: {
        ...globals.node,
        ...globals.es2023,
      },
    },
    plugins: { "@typescript-eslint": tsPlugin },
    rules: {
      // TS 已经做了类型检查，比 ESLint 的 no-undef 更准确（且 NodeJS 这种 ambient namespace ESLint 不认）
      "no-undef": "off",
      // 用 TS 版本的 no-unused-vars，避免 JS 规则对接口/类型签名误报
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          // 关掉对函数/接口签名参数的检查 —— 接口里"未使用"是正常的
          args: "none",
        },
      ],
      "no-console": "off",
    },
  },
  { ignores: ["dist/", "coverage/", "node_modules/"] },
];
