import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    include: ["src/**/*.test.{ts,tsx}", "app/**/*.test.{ts,tsx}"],
    coverage: {
      reporter: ["text", "html"],
      thresholds: {
        lines: 95,
        functions: 90,
        branches: 80,
        statements: 95,
      },
    },
  },
});
