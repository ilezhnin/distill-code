// Runs inside bench-run's fresh Linux home before the pinned text adapter.
// No Windows account cache, personal configuration, hooks or skills are read.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

if (process.platform !== "linux" || process.env.HOME !== "/home/candidate") {
  throw new Error("capability_missing: isolated Linux text runtime required");
}
if (process.env.DISTILL_BENCH_TEXT_PROVIDER === "codex") {
  const result = spawnSync(
    "/opt/distill-tools/bin/codex",
    ["debug", "models"],
    {
      env: process.env,
      cwd: "/workspace",
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      "capability_missing: isolated Codex model catalog unavailable",
    );
  }
  const models = JSON.parse(result.stdout).models;
  if (
    !Array.isArray(models) ||
    models.length === 0 ||
    models.length > 4096 ||
    models.some(
      (model) => !model || typeof model !== "object" || Array.isArray(model),
    )
  ) {
    throw new Error("capability_missing: invalid isolated Codex model catalog");
  }
  const fields = JSON.parse(process.env.DISTILL_BENCH_MODEL_CATALOG_POLICY);
  const path = "/tmp/text-model-catalog.json";
  writeFileSync(
    path,
    JSON.stringify({
      models: models.map((model) => ({ ...model, ...fields })),
    }),
    { mode: 0o600 },
  );
  process.env.CODEX_CONFIG = JSON.stringify({
    ...JSON.parse(process.env.CODEX_CONFIG),
    model_catalog_json: path,
  });
}
