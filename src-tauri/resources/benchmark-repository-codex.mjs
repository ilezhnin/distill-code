// Loaded only by an isolated repository Codex bridge, before codex-acp's
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

// Each control is an exact edit with the number of places it must apply.
const controls = [
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
    // Tool turns must not leave a transcript in the shared sign-in home.
    name: "ephemeral thread",
    anchor:
      'return await this.sendRequest({ method: "thread/start", params });',
    replacement:
      'return await this.sendRequest({ method: "thread/start", params: { ...params, ephemeral: true } });',
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
