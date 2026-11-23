// ACP v1 exposes the Codex token breakdown only in a prompt response. A
// provider-started turn has no response. Keep the pinned bridge's per-turn
// calculation on its ordinary context update so the host can bill it once.
import * as modules from "node:module";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

// The Codex executable and any tools it starts inherit only the user's options.
const options = (process.env.NODE_OPTIONS ?? "")
  .replace(`--import=${import.meta.url}`, "")
  .trim();
if (options) process.env.NODE_OPTIONS = options;
else delete process.env.NODE_OPTIONS;

function entrypoint() {
  try {
    return pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return undefined;
  }
}
const entry = entrypoint();
if (
  entry?.endsWith("/node_modules/@agentclientprotocol/codex-acp/dist/index.js")
)
  modules.registerHooks?.({
    load(url, context, next) {
      const loaded = next(url, context);
      if (url !== entry) return loaded;
      const source = Buffer.from(loaded.source).toString();
      const signature = "  createUsageUpdate(params) {";
      if (
        source.split(signature).length !== 2 ||
        !source.includes("var PromptTokenUsage = class") ||
        !source.includes("function toPromptUsage(")
      ) {
        process.stderr.write(
          "[flock] Codex bridge lacks the per-turn usage adapter\n",
        );
        return loaded;
      }
      const wrapper = `  createUsageUpdate(params) {
    const state = this.sessionState;
    const baseline = state.totalTokenUsage;
    const update = this.flockContextUsage(params);
    if (update && params.threadId === state.sessionId && params.turnId) {
      if (state.flockUsageTurn !== params.turnId) {
        state.flockUsageTurn = params.turnId;
        state.flockUsage = new PromptTokenUsage(baseline);
      }
      state.flockUsage.observeModelOutput();
      state.flockUsage.observe(state.totalTokenUsage, state.lastTokenUsage);
      const usage = state.flockUsage.usage();
      if (usage) update._meta = { ...update._meta, codexTurnUsage: toPromptUsage(usage) };
    }
    return update;
  }
  flockContextUsage(params) {`;
      return { ...loaded, source: source.replace(signature, wrapper) };
    },
  });
