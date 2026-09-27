import { defineConfig, normalizePath, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const host = process.env.TAURI_DEV_HOST;
const rootDir = fileURLToPath(new URL(".", import.meta.url));
const packageJson = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

function resolveAppVersion(): string {
  return process.env.VITE_APP_VERSION?.trim() || packageJson.version;
}

/**
 * Dev only. A module that is not a component (a store, the ACP connection, a
 * module-level cache, a locale) cannot be hot-swapped. Fast Refresh re-runs
 * the components that import it against a fresh, empty copy, while everything
 * that captured the old copy at startup keeps using it: the notification
 * handler, the startup loaders. The window then shows every project without
 * chats and every chat fails to replay until someone reloads. Reload the page
 * instead; the host keeps every session, so nothing is lost. Components keep
 * Fast Refresh, and stylesheets keep hot updates.
 */
function reloadOnNonComponentChange(): Plugin {
  const srcDir = `${normalizePath(resolve(rootDir, "src"))}/`;
  return {
    name: "distill:reload-on-non-component-change",
    apply: "serve",
    hotUpdate({ file, modules }) {
      if (this.environment.name !== "client") return;
      if (!file.startsWith(srcDir) || /\.(tsx|jsx|css)$/.test(file)) return;
      // Tailwind lists every source file, tests included, as a dependency of
      // the global stylesheet. Only a module some script imports is loaded.
      const loaded = modules.some((module) =>
        [...module.importers].some(
          (importer) => importer.file && !importer.file.endsWith(".css"),
        ),
      );
      if (!loaded) return;
      this.environment.hot.send({ type: "full-reload" });
      return [];
    },
  };
}

export default defineConfig(() => {
  const define: Record<string, string> = {
    "import.meta.env.VITE_APP_VERSION": JSON.stringify(resolveAppVersion()),
  };

  return {
    plugins: [react(), reloadOnNonComponentChange()],
    define,
    resolve: {
      alias: [
        {
          find: "@",
          replacement: resolve(rootDir, "src"),
        },
      ],
    },
    clearScreen: false,
    server: {
      port: parseInt(process.env.VITE_PORT || "1520", 10),
      strictPort: true,
      host: host || false,
      hmr: host
        ? {
            protocol: "ws",
            host,
            port: parseInt(process.env.VITE_PORT || "1520", 10) + 1,
          }
        : undefined,
      watch: {
        // Test reports are HTML, and Vite reloads the page for any HTML file
        // that changes: every Playwright run reloaded the running app. Agent
        // worktrees are whole second checkouts of this repository.
        ignored: [
          "**/src-tauri/**",
          "**/test-results/**",
          "**/transcript-playwright-report/**",
          "**/.claude/**",
        ],
      },
    },
  };
});
