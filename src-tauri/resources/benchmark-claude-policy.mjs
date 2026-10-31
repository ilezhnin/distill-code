// Loaded only by a host-owned benchmark bridge. Installed bridge files stay intact.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const expected = new Map([
  [
    "acp-agent.js",
    "aa41834c24f2c09a39af0b10731cc10fb882968f75a12c3735e50a9d080b20c4",
  ],
  [
    "session-titles.js",
    "11894b60a0d2b6b1e3a6c0bc8e651b752a8039295a7c9cf120c9e592d4d25dc0",
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
