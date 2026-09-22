import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The provenance rule in `sessionExecutionTarget.ts` cannot be checked by the
 * function it guards: it sees an id, not where the id came from. These lists
 * are where that is stated instead. A module that starts minting a target, or
 * naming a chat's run-settings intent, fails here until it is added with the
 * reason its values are allowed — (a) the harness' own inventory, (b) the
 * operator's explicit choice, (c) the harness' report of what is running — or
 * why it only carries values someone else chose.
 */

const ROOT = process.cwd();
const TARGET_MODULE = "src/features/chat/lib/sessionExecutionTarget.ts";

const TARGET_MINTERS: Record<string, string> = {
  "src/app/AppShell.tsx":
    "(b) the composer's choice, or a stored preference checked against the inventory (a)",
  "src/features/agents/lib/personaExecutionTarget.ts":
    "(b) the persona author's model, checked against the inventory (a)",
  "src/features/agents/lib/rankedPersonaTarget.ts":
    "(a) a ranking's pick among the models the inventory lists",
  "src/features/distillctl/commands/impl/createSession.ts":
    "(b) distillctl's explicit model_id",
  "src/features/chat/hooks/useChatSessionController.ts":
    "(b) the composer's model and persona picks",
  "src/features/chat/hooks/useResolvedAgentModelPicker.ts":
    "(b) the picker's selection, resolved against the inventory (a)",
  "src/features/chat/lib/hostExecutionTarget.ts":
    "(c) the provider and model the host reports for a session",
  "src/features/chat/lib/rejectedCreationModel.ts":
    "(c) the model the host opened a session on when it refused the one asked for",
  "src/features/chat/lib/rejectedModelRecovery.ts":
    "names no model: drops the one the harness refused",
  "src/features/chat/lib/sessionTargetCoordinator.ts":
    "(c) the model a response acknowledged; otherwise re-normalizes its caller's target",
  "src/features/chat/lib/sessionTargetReducer.ts":
    "re-normalizes targets it is handed",
  "src/features/chat/stores/chatSessionStore.ts":
    "re-normalizes its caller's target; (c) the model a create answer names",
  "src/features/conductor/spawnOrchestrator.ts":
    "re-normalizes the wave step's resolved target or its parent's",
  "src/features/conductor/waveStepTarget.ts":
    "(a) a step model matched against the inventory, or a ranking's pick",
  "src/shared/ui/GlobalComposerPill.tsx": "(b) the global composer's choice",
};

const RUN_SETTINGS_INTENT: Record<string, string> = {
  "src/app/AppShell.tsx":
    "(b) the composer's effort and fast mode, and an agent's saved ones",
  "src/features/chat/hooks/useChatSessionController.ts":
    "(b) the effort and fast controls, and a persona's ranked values",
  "src/features/chat/lib/newChat.ts":
    "reads it to reuse only a draft with the same intent",
  "src/features/chat/lib/queuedSessionSend.ts":
    "reads it at dispatch; never writes it",
  "src/features/chat/lib/runSettingsReconciler.ts":
    "reads it and writes only what the current model offers",
  "src/features/chat/lib/sessionTargetCoordinator.ts":
    "reads it to plan the writes after a model apply",
  "src/features/chat/stores/chatSessionStore.ts":
    "records what a creation was asked for and keeps it across model changes",
  "src/features/chat/stores/queuePersistence.ts":
    "copies it onto a queued message as a record",
  "src/features/conductor/spawnOrchestrator.ts":
    "(b) a wave step's own fields, else its ranking's",
  "src/features/sessions/hooks/useForkSession.ts":
    "(c) what the host stored for the fork, else the source's intent",
};

function productionSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "__tests__" ? [] : productionSources(path);
    }
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)
      ? [relative(ROOT, path).replaceAll("\\", "/")]
      : [];
  });
}

function modulesMatching(pattern: RegExp): string[] {
  return productionSources(resolve(ROOT, "src"))
    .filter((file) => pattern.test(readFileSync(resolve(ROOT, file), "utf8")))
    .sort();
}

describe("session execution target provenance", () => {
  it("mints a session execution target only in the modules that state their provenance", () => {
    const minters = modulesMatching(
      /\b(normalizeSessionExecutionTarget|targetFromAgentModelSelection|materializeSessionExecutionModel)\(/,
    ).filter((file) => file !== TARGET_MODULE);

    expect(minters).toEqual(Object.keys(TARGET_MINTERS).sort());
  });

  it("names a chat's run-settings intent only in the modules that state where it comes from", () => {
    expect(modulesMatching(/\bdesiredRunSettings\b/)).toEqual(
      Object.keys(RUN_SETTINGS_INTENT).sort(),
    );
  });
});
