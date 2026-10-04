// Loaded only by a host-owned Codex benchmark bridge, before codex-acp's
// dist/index.js. Installed bridge files stay intact: the controls below edit
// the source as Node loads it, and only the pinned build is edited.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

// The `codex.runtime.files.entrypoint` pin of benchmark-native-policies.json.
const pinned =
  "cb4b021dfe1ea1b579b02800ac03c057273803535dad9ac2cd262eb174152269";
const entrypoint = join(dirname(process.argv[1]), "index.js");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
if (digest(readFileSync(entrypoint)) !== pinned) {
  throw new Error(
    "capability_missing: pinned Codex benchmark adapter source changed",
  );
}

// codex-acp starts `codex app-server` without settings of its own, and the
// app-server reads `model_catalog_json` only when it starts: a thread's
// configuration cannot replace the catalog. The host's catalog is the
// account's own with the tool surface each model declares (code mode, extra
// tools, apply_patch) taken out, so the bridge must start the CLI with it.
// Without it, or with a CLI the bridge would start through a shell, the
// bridge does not run.
if (process.env.CODEX_PATH) {
  throw new Error(
    "capability_missing: Codex benchmark bridge must start its pinned CLI",
  );
}
const catalog = (() => {
  try {
    return JSON.parse(process.env.CODEX_CONFIG ?? "{}").model_catalog_json;
  } catch {
    return undefined;
  }
})();
if (typeof catalog !== "string" || catalog === "") {
  throw new Error(
    "capability_missing: Codex benchmark model catalog is unavailable",
  );
}
globalThis[Symbol.for("distill.codexStartupArgs")] = [
  "-c",
  `model_catalog_json=${JSON.stringify(catalog)}`,
];

// A call the model makes in a turn that offers no tools is refused inside
// codex: it answers the model with an error and asks it again, and codex-acp
// turns nothing about it into an update, so the host would never see the
// attempt. The raw response items the thread is started with show it; each
// call item becomes a failed `tool_call` update, which the host tags as a
// violation of the no-tool policy like any other provider's.
globalThis[Symbol.for("distill.codexToolCall")] = (params) => {
  const item = params?.item;
  const type = typeof item?.type === "string" ? item.type : "";
  if (!type.endsWith("_call")) return null;
  return {
    sessionUpdate: "tool_call",
    toolCallId: `distill-raw-${item.call_id ?? item.id ?? type}`,
    title: typeof item.name === "string" ? item.name : type,
    kind: "other",
    status: "failed",
    rawInput: item,
  };
};

// Each control is an exact edit with the number of places it must apply.
const controls = [
  {
    name: "startup",
    anchor:
      'spawn(process.execPath, [bundledCodexPath, "app-server"], { env: spawnEnv })',
    replacement:
      'spawn(process.execPath, [bundledCodexPath, "app-server", ...globalThis[Symbol.for("distill.codexStartupArgs")]], { env: spawnEnv })',
    count: 1,
  },
  {
    // The first completed turn otherwise starts a title thread on another
    // model, outside the turn's usage.
    name: "title",
    anchor: "  onTurnCompleted(userPromptText) {",
    replacement: "  onTurnCompleted(userPromptText) {\n    return;",
    count: 1,
  },
  {
    // An owned session runs one turn, so the thread total is the turn total;
    // the last request alone undercounts a turn that made several.
    name: "prompt usage",
    anchor: "usage: this.buildPromptUsage(sessionState.lastTokenUsage),",
    replacement:
      "usage: this.buildPromptUsage(sessionState.totalTokenUsage ?? sessionState.lastTokenUsage),",
    count: 4,
  },
  {
    name: "quota usage",
    anchor: "    const lastTokenUsage = sessionState.lastTokenUsage;",
    replacement:
      "    const lastTokenUsage = sessionState.totalTokenUsage ?? sessionState.lastTokenUsage;",
    count: 1,
  },
  {
    name: "quota token count",
    anchor: "        token_count: sessionState.lastTokenUsage,",
    replacement: "        token_count: lastTokenUsage,",
    count: 1,
  },
  {
    // Every thread reports the raw items of its model responses.
    name: "raw events",
    anchor:
      'return await this.sendRequest({ method: "thread/start", params });',
    replacement:
      'return await this.sendRequest({ method: "thread/start", params: { ...params, experimentalRawEvents: true } });',
    count: 1,
  },
  {
    // codex-acp ignores raw items; a call among them becomes an update.
    name: "tool call report",
    anchor: '      case "rawResponseItem/completed":\n',
    replacement:
      '      case "rawResponseItem/completed": {\n        const call = globalThis[Symbol.for("distill.codexToolCall")](notification.params);\n        if (call) return call;\n      }\n',
    count: 1,
  },
];

const entrypointUrl = pathToFileURL(entrypoint).href;
registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (url !== entrypointUrl) return loaded;
    let source =
      typeof loaded.source === "string"
        ? loaded.source
        : Buffer.from(loaded.source).toString("utf8");
    if (digest(source) !== pinned) {
      throw new Error(
        "capability_missing: Codex bridge source changed while loading",
      );
    }
    for (const { name, anchor, replacement, count } of controls) {
      const parts = source.split(anchor);
      if (parts.length !== count + 1) {
        throw new Error(
          `capability_missing: Codex ${name} control is unavailable`,
        );
      }
      source = parts.join(replacement);
    }
    return { ...loaded, source };
  },
});
