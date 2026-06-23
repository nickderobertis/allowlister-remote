import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Dedicated config for the heap-footprint harness (src/perf/heap.perf.ts). Like
// the render-cost harness it is a measurement, not an assertion gate, so it is
// kept out of the default `test` run (whose include is `*.test.{ts,tsx}`). It is
// pure data — no DOM — so it runs in the node environment, and it needs neither
// the React Compiler pass nor the test setup file.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/perf/heap.perf.ts"],
  },
});
