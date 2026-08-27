import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Node-environment tests for repo scripts. The hook launcher lives here
    // rather than in the jsdom suite because it is a shell script exercised
    // through a real child process.
    include: [
      "scripts/release/tests/**/*.test.mjs",
      "scripts/hooks/tests/**/*.test.mjs",
    ],
    testTimeout: 15_000,
  },
});
