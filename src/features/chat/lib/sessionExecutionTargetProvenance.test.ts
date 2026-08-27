import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isModelExecutionTarget,
  normalizeSessionExecutionTarget,
} from "./sessionExecutionTarget";

/**
 * The provenance invariant behind the codex-acp P0, in executable form.
 *
 * A concrete `modelId` on a session is not advisory: goose forwards it to the
 * harness as `session/set_config_option("model", <id>)` from inside
 * `stream()`, on the send path. An id the harness does not serve therefore
 * fails EVERY send with "Failed to set ACP model option: Invalid params", and
 * the chat cannot be repaired from inside itself. Both halves of this suite
 * exist because that failure was reached twice by two different routes — a
 * persona's saved model, and a ranking run against a stale inventory.
 */

const MINTING_FUNCTIONS = [
  "normalizeSessionExecutionTarget",
  "targetFromAgentModelSelection",
  "materializeSessionExecutionModel",
] as const;

/**
 * Every module allowed to put a target on a session, each with the clause of
 * the provenance rule (see `sessionExecutionTarget.ts`) that lets it name a
 * concrete model:
 *
 *   (a) the id is confirmed by the harness' own authoritative inventory,
 *   (b) the operator named it explicitly, or
 *   (c) the harness itself reported it as what the session already runs,
 *   (-) the module never originates an id — it re-normalizes or strips one.
 *
 * This list is the point of the test. It cannot check that a module honours
 * its clause; it forces a NEW minting site to be read against the rule and
 * classified before it can ship, which is the step both P0 regressions
 * skipped.
 */
const ALLOWED_MINTING_MODULES: Record<string, string> = {
  // (b) The composer's model pill — the operator's own choice, and the one
  // place the rule exists to keep usable when everything else declines.
  "src/shared/ui/GlobalComposerPill.tsx": "b",
  "src/features/chat/hooks/useResolvedAgentModelPicker.ts": "b",
  "src/features/chat/hooks/useChatSessionController.ts": "b",
  // (b) berdctl's explicit `model_id` argument is an operator instruction
  // arriving over a different wire.
  "src/features/berdctl/commands/impl/createSession.ts": "b",

  // (a) Persona resolution. 4394d13 put `requireInstalledModel` on the
  // session-establishing callers; 2255d3f made the inventory those read
  // authority-checked rather than merely cached.
  "src/features/agents/lib/personaExecutionTarget.ts": "a",
  "src/features/agents/lib/rankedPersonaTarget.ts": "a",
  // (a) A wave child is spawned on a real session and dies the same death,
  // so its live model read is gated the same way.
  "src/features/conductor/waveStepTarget.ts": "a",

  // (c) The goose-serve boundary canonicalizes what goose reports the session
  // is running; the snapshot path in the coordinator materializes the same.
  "src/features/chat/lib/gooseServeExecutionTarget.ts": "c",
  "src/features/chat/lib/sessionTargetCoordinator.ts": "c",

  // (-) Re-normalizers: they canonicalize a target another module already
  // minted, or fall back to a bare harness id. They introduce no new id.
  "src/features/chat/stores/chatSessionStore.ts": "-",
  "src/features/chat/lib/sessionTargetReducer.ts": "-",
  "src/features/conductor/spawnOrchestrator.ts": "-",
  "src/app/AppShell.tsx": "-",
  // (-) Recovery strips the model pin after the harness refused it; it is the
  // rule's escape hatch, and only ever removes an id.
  "src/features/chat/lib/rejectedModelRecovery.ts": "-",
};

function sourceFilesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "__tests__") {
      continue;
    }
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...sourceFilesUnder(full));
      continue;
    }
    if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) {
      continue;
    }
    found.push(full);
  }
  return found;
}

describe("session execution target provenance", () => {
  it("keeps target minting to modules classified against the rule", () => {
    const root = resolve(process.cwd(), "src");
    const minting = sourceFilesUnder(root)
      .filter((file) => {
        // The gate itself defines the functions; it is not a caller.
        if (file.endsWith(`lib${sep}sessionExecutionTarget.ts`)) {
          return false;
        }
        const source = readFileSync(file, "utf8");
        return MINTING_FUNCTIONS.some((fn) => source.includes(fn));
      })
      .map((file) => relative(process.cwd(), file).split(sep).join("/"))
      .sort();

    // Not a subset check on purpose: a module that stops minting should be
    // struck from the list, so the list keeps describing the real graph.
    expect(minting).toEqual(Object.keys(ALLOWED_MINTING_MODULES).sort());
  });

  it("classifies every allowed module as (a), (b), (c) or a re-normalizer", () => {
    for (const [modulePath, clause] of Object.entries(
      ALLOWED_MINTING_MODULES,
    )) {
      expect(["a", "b", "c", "-"], `${modulePath} states no clause`).toContain(
        clause,
      );
    }
  });

  it("has a representable safe target for 'no id may be named'", () => {
    // The whole rule depends on this being expressible: when nothing confirms
    // an id, the caller omits it and the session runs on the harness' current
    // model. If this ever produced a model target instead, every "decline to
    // name a model" branch would silently become a substitution.
    const target = normalizeSessionExecutionTarget({
      harnessId: "goose",
      modelProviderId: "openai",
      modelId: null,
    });
    expect(isModelExecutionTarget(target)).toBe(false);
    expect(target.modelId).toBeUndefined();
    expect(target.modelProviderId).toBe("openai");
  });

  it("drops only the model when a pinned id is withdrawn", () => {
    // What recovery does after the harness refuses an id: the provider was
    // never the thing rejected, so the operator keeps that much of the choice.
    const pinned = normalizeSessionExecutionTarget({
      harnessId: "goose",
      modelProviderId: "openai",
      modelId: "gpt-5.6-sol[ultra]",
      modelName: "GPT-5.6 Sol (Ultra)",
    });
    expect(isModelExecutionTarget(pinned)).toBe(true);

    const unpinned = normalizeSessionExecutionTarget({
      harnessId: pinned.harnessId,
      modelProviderId: pinned.modelProviderId,
    });
    expect(isModelExecutionTarget(unpinned)).toBe(false);
    expect(unpinned.harnessId).toBe("goose");
    expect(unpinned.modelProviderId).toBe("openai");
  });

  it("refuses a model id with no provider to attribute it to", () => {
    // An id with no provider cannot be checked against any inventory, so it
    // can never satisfy clause (a) — the gate rejects it outright rather than
    // letting it reach the harness unverifiable.
    expect(() =>
      normalizeSessionExecutionTarget({
        harnessId: "goose",
        modelId: "gpt-5.6-sol[ultra]",
      }),
    ).toThrow(/model provider id/i);
  });
});
