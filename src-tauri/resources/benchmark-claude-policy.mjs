// Loaded only by a host-owned benchmark bridge. Installed bridge files stay intact.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const expected = new Map([
  [
    "acp-agent.js",
    "a17444ae89c5dd8f6cccaf278107438100521cf5cb367fb8991e48ce0f46bbf1",
  ],
  [
    "session-titles.js",
    "a78f6ed7e85193fbb0ebc97b37c0adde70d1000eac94e70e310e75dd580e079a",
  ],
]);
const directory = dirname(process.argv[1]);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const [name, hash] of expected) {
  if (digest(readFileSync(join(directory, name))) !== hash) {
    throw new Error(
      "capability_missing: pinned Claude benchmark adapter source changed",
    );
  }
}
const titleUrl = pathToFileURL(join(directory, "session-titles.js")).href;
registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (url !== titleUrl) return loaded;
    const source =
      typeof loaded.source === "string"
        ? loaded.source
        : Buffer.from(loaded.source).toString("utf8");
    if (digest(source) !== expected.get("session-titles.js")) {
      throw new Error(
        "capability_missing: Claude title module changed while loading",
      );
    }
    const guard = "    canRequest(session) {";
    if (source.split(guard).length !== 2) {
      throw new Error(
        "capability_missing: Claude title control is unavailable",
      );
    }
    return {
      ...loaded,
      source: source.replace(guard, `${guard}\n        return false;`),
    };
  },
});
