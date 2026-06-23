// ESLint exists in this repo for ONE purpose: React Compiler lint rules that
// Biome has no equivalent for. Biome remains the primary linter and formatter
// (see the root AGENTS.md) — do not migrate general linting here.
//
// The rules that remain are compiler bailout detectors: they flag the
// Rules-of-React violations that make React Compiler silently *skip* optimizing a
// component (refs/state written during render, impurity, mutation, unsupported
// syntax, incompatible libraries, …) — exactly what react-compiler-healthcheck
// cannot detect. Every one is forced to error so a regression fails CI, and the
// list is derived from the plugin's recommended set so new compiler rules are
// adopted automatically. This runs in CI (`just check`) and pre-push, never
// pre-commit.
//
// EXCLUDED below are rules that are either owned by Biome (so we never double-lint)
// or advisory heuristics that do NOT block compilation (the compiler still
// optimizes the component) — keeping them would force refactors of legitimate
// code for zero compiler-coverage gain.

import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

const EXCLUDED = new Set([
  // Owned by Biome — keep ESLint to compiler-only rules.
  "react-hooks/rules-of-hooks", // → Biome correctness/useHookAtTopLevel
  "react-hooks/exhaustive-deps", // → Biome correctness/useExhaustiveDependencies
  // Advisory perf heuristic ("you might not need an effect"), NOT a compiler
  // bailout: the compiler still optimizes these components (confirmed via the
  // compiler's own panicThreshold). It conflicts with this app's SSR-safe pattern
  // of initializing client-only state in a mount effect, so enabling it would
  // mean refactoring correct code without improving compiler coverage.
  "react-hooks/set-state-in-effect",
]);

const compilerRules = Object.fromEntries(
  Object.keys(reactHooks.configs["recommended-latest"].rules)
    .filter((id) => !EXCLUDED.has(id))
    .map((id) => [id, "error"]),
);

export default tseslint.config({
  files: ["src/**/*.{ts,tsx}", "app/**/*.{ts,tsx}"],
  ignores: ["**/*.test.{ts,tsx}", "**/*.perf.{ts,tsx}"],
  plugins: { "react-hooks": reactHooks },
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
  rules: compilerRules,
});
