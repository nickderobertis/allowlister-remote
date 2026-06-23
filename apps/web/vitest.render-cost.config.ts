import { fileURLToPath } from "node:url";
import babel from "@rolldown/plugin-babel";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Dedicated config for the render-cost harness (src/perf/render-cost.perf.tsx).
// It is kept out of the default `test` run (whose include is `*.test.{ts,tsx}`)
// because it is a measurement, not an assertion gate, and because it must run
// twice — once without React Compiler and once with — to produce a delta.
//
// @vitejs/plugin-react v6 transforms JSX with oxc, not Babel, so the compiler
// (a Babel plugin) is wired the way that plugin documents: the @rolldown/plugin-babel
// pass running reactCompilerPreset. REACT_COMPILER=1 adds that pass, matching the
// `reactCompiler: true` production build in next.config.ts. The runner
// (scripts/web-render-cost.mjs) drives both modes and diffs them.
const reactCompiler = process.env.REACT_COMPILER === "1";

export default defineConfig(async () => ({
  plugins: [
    react(),
    ...(reactCompiler ? [await babel({ presets: [reactCompilerPreset({ target: "19" })] })] : []),
  ],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    include: ["src/perf/render-cost.perf.tsx"],
  },
}));
