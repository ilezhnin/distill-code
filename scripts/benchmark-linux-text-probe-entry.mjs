// Offline sandbox entry. Exercise the exact production bootstrap before the
// hostile-context/model-stub protocol suite uses its invented account homes.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
const [provider, script, ...args] = process.argv.slice(2);
assert.equal(process.env.DISTILL_LINUX_POLICY_PROBE, "offline-v1");
assert.equal(process.platform, "linux");
assert.equal(process.env.HOME, "/home/candidate");
if (provider !== "grok") {
  const policies = JSON.parse(
    await readFile(
      new URL(
        "../src-tauri/resources/benchmark-native-policies.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  process.env.DISTILL_BENCH_TEXT_PROVIDER = provider;
  process.env.CODEX_CONFIG = JSON.stringify(policies.codex.config);
  process.env.DISTILL_BENCH_MODEL_CATALOG_POLICY = JSON.stringify(
    policies.codex.modelCatalog,
  );
  await import("../src-tauri/resources/benchmark-linux-text-bootstrap.mjs");
  if (provider === "codex") {
    const config = JSON.parse(process.env.CODEX_CONFIG);
    assert.equal(config.model_catalog_json, "/tmp/text-model-catalog.json");
    const catalog = JSON.parse(
      await readFile(config.model_catalog_json, "utf8"),
    );
    const models = Array.isArray(catalog) ? catalog : catalog.models;
    assert(models.length > 0);
    for (const model of models)
      for (const [key, expected] of Object.entries(
        policies.codex.modelCatalog,
      )) {
        assert.deepEqual(
          model[key],
          expected,
          `Bootstrap model capability ${key}`,
        );
      }
  }
}
process.argv = [process.execPath, script, ...args];
await import(pathToFileURL(script).href);
