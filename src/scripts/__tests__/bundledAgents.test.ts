// @vitest-environment node

import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateBundledAgentFile } from "../../../scripts/validate-bundled-agents";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("bundled agents", () => {
  it("always includes the valid public starter set", () => {
    const tauriConfig = JSON.parse(
      readFileSync(resolve(repoRoot, "src-tauri/tauri.conf.json"), "utf8"),
    );
    const agentDirectory = resolve(repoRoot, "distro/agents");
    const agentFiles = readdirSync(agentDirectory)
      .filter((name) => name.endsWith(".md"))
      .sort();

    expect(tauriConfig.bundle.resources["../distro"]).toBe("distro");
    expect(agentFiles).toEqual(
      expect.arrayContaining([
        "agt-builder.md",
        "berdy.md",
        "choosey.md",
        "copycat.md",
        "pushback.md",
        "tinker.md",
        "wildcard.md",
      ]),
    );
    for (const fileName of agentFiles) {
      expect(
        validateBundledAgentFile(resolve(agentDirectory, fileName)),
      ).toEqual([]);
    }
  });

  it("keeps handwritten spawn-policy prose out of the bundled agents", () => {
    // The spawn rule is generated into the system prompt from the effective
    // spawn ACL (src/features/conductor/spawnAcl.ts) and enforced in code; a
    // handwritten copy in an agent file would be a second source of truth
    // that drifts the moment the ACL or its wording changes.
    const agentDirectory = resolve(repoRoot, "distro/agents");
    for (const fileName of readdirSync(agentDirectory)) {
      if (!fileName.endsWith(".md")) continue;
      const body = readFileSync(resolve(agentDirectory, fileName), "utf8");
      expect
        .soft(body, `${fileName} hardcodes spawn-policy prose`)
        .not.toMatch(/do not spawn chats yourself/i);
      expect
        .soft(body, `${fileName} hardcodes spawn-policy prose`)
        .not.toMatch(/Distill starts other agents from the Agents catalog/i);
    }
  });
});
