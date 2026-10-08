import { beforeEach, expect, it, vi } from "vitest";
import {
  claimOwnedTaskIntent,
  MAX_OWNED_TASK_PROMPT_BYTES,
  MAX_NATIVE_TASK_PROMPT_BYTES,
  ownedTaskIntentState,
  pendingOwnedTaskIntent,
  releaseOwnedTaskIntent,
  retainOwnedTaskIntent,
  type PendingOwnedTaskIntent,
  type PendingOwnedTaskIntentV2,
} from "./ownedTaskIntent";

const key = "distill.pendingOwnedTaskIntent.v1";
const intent: PendingOwnedTaskIntent = {
  kind: "chat",
  request: {
    requestKey: "fictional-request",
    surface: "chat",
    contextId: "fictional-context",
    promotionId: "fictional-promotion",
    acknowledgedCertificateHash: "fictional-certificate",
    prompt: "  Preserve fictional task bytes.\n",
    hardCandidateKey: "fictional-exact-pin",
    repository: {
      path: "E:/Fictional Project",
      commit: "fictional-commit",
      tree: "fictional-tree",
    },
    entry: null,
    waveMode: null,
  },
};
beforeEach(() => {
  localStorage.clear();
});

const nativeIntent: PendingOwnedTaskIntentV2 = {
  kind: "chat",
  request: {
    schemaVersion: 2,
    requestKey: "native-fictional-request",
    surface: "chat",
    contextId: "native-fictional-context",
    mode: {
      contextId: "native-fictional-context",
      artifactHash: "native-fictional-mode",
    },
    roleSourceId: "native-fictional-source",
    workClassId: "debug",
    prompt: "  Preserve native fictional task bytes.\n",
    hardCandidateKey: "native-exact-pin",
    entry: null,
    stepBudgetSeconds: 17,
  },
};
it("retains native v2 intent and consent references without converting the saved v1 wire format", () => {
  retainOwnedTaskIntent(nativeIntent);
  expect(pendingOwnedTaskIntent()).toEqual(nativeIntent);
  expect(() =>
    retainOwnedTaskIntent({
      ...nativeIntent,
      request: { ...nativeIntent.request, hardCandidateKey: null },
    }),
  ).toThrow("Recover the saved");
  releaseOwnedTaskIntent(nativeIntent);
  retainOwnedTaskIntent(intent);
  expect(JSON.parse(localStorage.getItem(key) ?? "null")).toEqual(intent);
  expect(localStorage.getItem(key)).not.toContain("schemaVersion");
});
it("preserves native consent acknowledgement and rejects renderer authority fields", () => {
  const mode: PendingOwnedTaskIntentV2 = {
    kind: "mode",
    request: {
      schemaVersion: 2,
      contextId: "fictional-conductor",
      surface: "wave",
      executionProfile: "protected_repository",
      repository: {
        path: "E:/Fictional Project",
        commit: "fictional-commit",
        tree: "fictional-tree",
      },
      limits: { timeoutSeconds: 17, maxTurns: 1, maxArtifactBytes: 1024 },
      roles: [
        { sourcePath: "E:/Fictional Agents/helper.md", workClassId: "debug" },
      ],
      providerIds: ["claude-acp"],
      acknowledgedContractHash: "fictional-consent-hash",
    },
  };
  retainOwnedTaskIntent(mode);
  expect(pendingOwnedTaskIntent()).toEqual(mode);
  releaseOwnedTaskIntent(mode);
  const raw = JSON.stringify({
    ...nativeIntent,
    request: {
      ...nativeIntent.request,
      promotionId: "forged-promotion",
      rolePrompt: "forged-role",
      permissions: { network: true },
    },
  });
  localStorage.setItem(key, raw);
  expect(ownedTaskIntentState().error).not.toBeNull();
  expect(localStorage.getItem(key)).toBe(raw);
});
it("enforces the native v2 UTF-8 bound independently from the unchanged v1 bound", () => {
  const exact: PendingOwnedTaskIntentV2 = {
    ...nativeIntent,
    request: {
      ...nativeIntent.request,
      prompt: "🌱".repeat(MAX_NATIVE_TASK_PROMPT_BYTES / 4),
    },
  };
  retainOwnedTaskIntent(exact);
  expect(pendingOwnedTaskIntent()).toEqual(exact);
  releaseOwnedTaskIntent(exact);
  expect(() =>
    retainOwnedTaskIntent({
      ...exact,
      request: { ...exact.request, prompt: `${exact.request.prompt}é` },
    }),
  ).toThrow("131072 UTF-8 bytes");
  expect(localStorage.getItem(key)).toBeNull();
});

it("preserves task bytes and exact pin durably and never overwrites a competing accepted intent", () => {
  retainOwnedTaskIntent(intent);
  expect(pendingOwnedTaskIntent()).toEqual(intent);
  const competing = {
    ...intent,
    request: {
      ...intent.request,
      requestKey: "competing-request",
      hardCandidateKey: null,
    },
  };
  expect(() => retainOwnedTaskIntent(competing)).toThrow("Recover the saved");
  expect(() => releaseOwnedTaskIntent(competing)).toThrow(
    "changed during recovery",
  );
  expect(pendingOwnedTaskIntent()).toEqual(intent);
});

it("allows only one renderer operation without discarding the durable request when its operation finishes", () => {
  const finish = claimOwnedTaskIntent(intent);
  expect(ownedTaskIntentState().busy).toBe(true);
  expect(claimOwnedTaskIntent(intent)).toBeNull();
  finish?.();
  expect(ownedTaskIntentState().busy).toBe(false);
  expect(pendingOwnedTaskIntent()).toEqual(intent);
  releaseOwnedTaskIntent(intent);
  expect(pendingOwnedTaskIntent()).toBeNull();
});

it.each([
  "",
  "{",
  JSON.stringify({ kind: "chat", request: { contextId: "fictional-context" } }),
  JSON.stringify({
    ...intent,
    request: { ...intent.request, surface: "wave" },
  }),
])("retains invalid saved evidence and refuses new admission (%s)", (raw) => {
  localStorage.setItem(key, raw);
  expect(ownedTaskIntentState().error).not.toBeNull();
  expect(() => claimOwnedTaskIntent(intent)).toThrow("needs inspection");
  expect(localStorage.getItem(key)).toBe(raw);
  expect(ownedTaskIntentState().busy).toBe(false);
});

it("does not hold a false operation lease when persistence fails before any native work", () => {
  const write = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementationOnce(() => {
      throw new Error("Local persistence unavailable");
    });
  expect(() => claimOwnedTaskIntent(intent)).toThrow(
    "Local persistence unavailable",
  );
  expect(ownedTaskIntentState().busy).toBe(false);
  expect(pendingOwnedTaskIntent()).toBeNull();
  write.mockRestore();
});

it("refuses oversized UTF-8 admission before persistence but preserves a readable legacy request for explicit editing", () => {
  const legacy = {
    ...intent,
    request: {
      ...intent.request,
      prompt: `${"🌱".repeat(MAX_OWNED_TASK_PROMPT_BYTES / 4)}é`,
    },
  };
  expect(() => claimOwnedTaskIntent(legacy)).toThrow("UTF-8 bytes");
  expect(localStorage.getItem(key)).toBeNull();
  expect(ownedTaskIntentState().busy).toBe(false);
  const raw = JSON.stringify(legacy);
  localStorage.setItem(key, raw);
  expect(ownedTaskIntentState().error).toBeNull();
  expect(pendingOwnedTaskIntent()).toEqual(legacy);
  expect(() => claimOwnedTaskIntent(legacy)).toThrow("UTF-8 bytes");
  expect(localStorage.getItem(key)).toBe(raw);
  expect(ownedTaskIntentState().busy).toBe(false);
  releaseOwnedTaskIntent(legacy);
  expect(pendingOwnedTaskIntent()).toBeNull();
});
