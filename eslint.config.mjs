// Type-aware lint for the promise bug class only (floating and misused promises).
// Formatting is Prettier's; no other rules or presets. Scoped to tsconfig.json's
// `include`, because the project service cannot type-parse files outside it.
import tseslint from "typescript-eslint";

export default [
  {
    files: ["src/**/*.{ts,mts}", "examples/**/*.{ts,mts}", "scripts/**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      "@typescript-eslint/no-floating-promises": [
        "error",
        {
          allowForKnownSafeCalls: [{ from: "package", package: "node:test", name: ["test", "it", "describe", "suite"] }],
        },
      ],
      "@typescript-eslint/no-misused-promises": "error",
    },
  },
];
