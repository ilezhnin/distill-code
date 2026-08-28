import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

const packageJson = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

function resolveAppVersion(): string {
  return process.env.VITE_APP_VERSION?.trim() || packageJson.version;
}

export default defineConfig({
  plugins: [react()],
  define: {
    "import.meta.env.VITE_APP_VERSION": JSON.stringify(resolveAppVersion()),
  },
  resolve: {
    alias: [
      {
        find: "@",
        replacement: resolve(__dirname, "./src"),
      },
    ],
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    css: true,
    restoreMocks: true,
    // The 5s default is not a budget, it is a coin flip on a cold Windows
    // disk: contractImport and three useConductorGraphSync specs failed on
    // it under a full run and passed alone, twice, while nothing about them
    // had changed. A timeout that fires on machine speed rather than on a
    // hung test is worse than no timeout, because every red run then has to
    // be re-run before it can be believed — which is exactly the habit that
    // lets a real regression through. 30s still catches a genuine hang.
    testTimeout: 30_000,
  },
});
