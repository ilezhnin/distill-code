import type { Persona } from "@/shared/types/agents";

export type RoleLayer = "conductor" | "orchestrator" | "worker";
export type RoleStage = "pre" | "prod" | "verify" | "release" | "post";

export interface RoleDefinition {
  id: string;
  displayName: string;
  layers: readonly RoleLayer[];
  stage: RoleStage;
  keywords: readonly string[];
}

export const DEFAULT_CONDUCTOR_ROLE_ID = "producer";
export const DEFAULT_ORCHESTRATOR_ROLE_ID = "planner";
export const DEFAULT_WORKER_ROLE_ID = "brigade";

export const ROLE_CATALOG: readonly RoleDefinition[] = [
  {
    id: "producer",
    displayName: "Producer",
    layers: ["conductor", "orchestrator"],
    stage: "pre",
    keywords: [
      "coordinate",
      "queue",
      "wave",
      "milestone",
      "triage",
      "schedule",
      "scope",
      "producer",
    ],
  },
  {
    id: "planner",
    displayName: "Planner",
    layers: ["conductor", "orchestrator"],
    stage: "pre",
    keywords: [
      "plan",
      "planner",
      "work order",
      "milestone",
      "cards",
      "zones",
      "batch",
      "roadmap",
    ],
  },
  {
    id: "integrator",
    displayName: "Integrator",
    layers: ["orchestrator", "worker"],
    stage: "prod",
    keywords: [
      "integrate",
      "integrator",
      "merge",
      "compile",
      "seams",
      "join",
      "combine",
    ],
  },
  {
    id: "architect",
    displayName: "Architect",
    layers: ["orchestrator", "worker"],
    stage: "pre",
    keywords: [
      "architect",
      "architecture",
      "adr",
      "module",
      "boundary",
      "ownership",
      "api",
    ],
  },
  {
    id: "brigade",
    displayName: "Brigade",
    layers: ["worker"],
    stage: "prod",
    keywords: [
      "implement",
      "implementation",
      "code",
      "patch",
      "fix",
      "build",
      "refactor",
      "write tests",
      "brigade",
    ],
  },
  {
    id: "unity-explorer",
    displayName: "Unity Explorer",
    layers: ["worker"],
    stage: "pre",
    keywords: [
      "unity-explorer",
      "orient",
      "map the unity",
      "asmdef",
      "projectversion",
      "unfamiliar unity",
    ],
  },
  {
    id: "unity-worker",
    displayName: "Unity Worker",
    layers: ["worker"],
    stage: "prod",
    keywords: [
      "unity-worker",
      "unity",
      "monobehaviour",
      "scriptableobject",
      "serializefield",
      "prefab",
      "csharp",
      "c#",
      "gameobject",
    ],
  },
  {
    id: "unity-reviewer",
    displayName: "Unity Reviewer",
    layers: ["worker"],
    stage: "verify",
    keywords: [
      "unity-reviewer",
      "unity review",
      "review this unity",
      "serialization",
      "formerlyserializedas",
    ],
  },
  {
    id: "unity-test-runner",
    displayName: "Test Runner",
    layers: ["worker"],
    stage: "verify",
    keywords: [
      "unity-test-runner",
      "editmode",
      "playmode",
      "run tests",
      "batchmode",
      "unity validate",
    ],
  },
  {
    id: "asset-scout",
    displayName: "Asset Scout",
    layers: ["worker"],
    stage: "pre",
    keywords: [
      "asset-scout",
      "source assets",
      "license",
      "cc0",
      "provenance",
      "find sprites",
    ],
  },
  {
    id: "unity-asset-integrator",
    displayName: "Asset Integrator",
    layers: ["worker"],
    stage: "prod",
    keywords: [
      "unity-asset-integrator",
      "import assets",
      "addressables",
      "assetdatabase",
      "guid",
    ],
  },
  {
    id: "context-builder",
    displayName: "Context Builder",
    layers: ["worker"],
    stage: "pre",
    keywords: ["context-builder", "handoff", "context brief", "cross session"],
  },
  {
    id: "pr-submitter",
    displayName: "Submitter",
    layers: ["worker"],
    stage: "release",
    keywords: [
      "pr-submitter",
      "pull request",
      "merge request",
      "open a pr",
      "commit and push",
    ],
  },
  {
    id: "scout",
    displayName: "Scout",
    layers: ["worker"],
    stage: "pre",
    keywords: [
      "scout",
      "verify claim",
      "primary source",
      "fact check",
      "refute",
      "confirm",
    ],
  },
  {
    id: "researcher",
    displayName: "Researcher",
    layers: ["worker"],
    stage: "pre",
    keywords: [
      "research",
      "literature",
      "survey",
      "competitor",
      "options",
      "brief",
    ],
  },
  {
    id: "oracle",
    displayName: "Oracle",
    layers: ["worker"],
    stage: "pre",
    keywords: [
      "oracle",
      "consistency",
      "drift",
      "contradiction",
      "decisions",
      "assumptions",
    ],
  },
  {
    id: "designer",
    displayName: "Designer",
    layers: ["worker"],
    stage: "pre",
    keywords: [
      "designer",
      "design",
      "mechanic",
      "balance",
      "rules",
      "core loop",
      "gdd",
      "game design",
    ],
  },
  {
    id: "ux",
    displayName: "UX",
    layers: ["worker"],
    stage: "pre",
    keywords: ["ux", "ui", "screen", "flow", "dialog", "layout", "interaction"],
  },
  {
    id: "artist",
    displayName: "Artist",
    layers: ["worker"],
    stage: "prod",
    keywords: [
      "artist",
      "sprite",
      "pixel",
      "asset",
      "icon",
      "tile",
      "art",
      "illustration",
    ],
  },
  {
    id: "audio",
    displayName: "Audio",
    layers: ["worker"],
    stage: "prod",
    keywords: ["audio", "sound", "music", "sfx", "mix"],
  },
  {
    id: "writer",
    displayName: "Writer",
    layers: ["worker"],
    stage: "prod",
    keywords: [
      "writer",
      "docs",
      "readme",
      "copy",
      "changelog",
      "prose",
      "documentation",
    ],
  },
  {
    id: "localizer",
    displayName: "Localizer",
    layers: ["worker"],
    stage: "release",
    keywords: [
      "localizer",
      "translate",
      "i18n",
      "locale",
      "localization",
      "glossary",
    ],
  },
  {
    id: "marketer",
    displayName: "Marketer",
    layers: ["worker"],
    stage: "post",
    keywords: [
      "marketer",
      "marketing",
      "launch",
      "campaign",
      "store copy",
      "announcement",
    ],
  },
  {
    id: "devops",
    displayName: "DevOps",
    layers: ["worker"],
    stage: "release",
    keywords: [
      "devops",
      "ci",
      "release",
      "package",
      "version",
      "tag",
      "pipeline",
      "player build",
      "il2cpp",
    ],
  },
  {
    id: "perf",
    displayName: "Perf",
    layers: ["worker"],
    stage: "verify",
    keywords: ["perf", "performance", "fps", "profile", "budget", "allocation"],
  },
  {
    id: "security",
    displayName: "Security",
    layers: ["worker"],
    stage: "verify",
    keywords: [
      "security",
      "sandbox",
      "trust",
      "exploit",
      "isolation",
      "untrusted",
    ],
  },
  {
    id: "qa",
    displayName: "QA",
    layers: ["worker"],
    stage: "verify",
    keywords: [
      "qa",
      "test plan",
      "regression",
      "checklist",
      "test cases",
      "quality",
    ],
  },
  {
    id: "acceptor",
    displayName: "Acceptor",
    layers: ["worker"],
    stage: "verify",
    keywords: [
      "acceptor",
      "acceptance",
      "criterion",
      "negative control",
      "personally verify",
    ],
  },
  {
    id: "adversary",
    displayName: "Adversary",
    layers: ["worker"],
    stage: "verify",
    keywords: [
      "adversary",
      "adversarial",
      "review",
      "hunt defects",
      "residual",
    ],
  },
  {
    id: "playtester",
    displayName: "Playtester",
    layers: ["worker"],
    stage: "post",
    keywords: ["playtester", "playtest", "feel", "play", "scenario"],
  },
] as const;

export function roleById(roleId: string): RoleDefinition | undefined {
  return ROLE_CATALOG.find((role) => role.id === roleId);
}

export function rolesForLayer(layer: RoleLayer): RoleDefinition[] {
  return ROLE_CATALOG.filter((role) => role.layers.includes(layer));
}

export function fileStemFromPersonaId(personaId: string): string {
  const base =
    personaId.replace(/\\/g, "/").split("/").pop()?.trim() ?? personaId.trim();
  return base.replace(/\.md$/i, "").toLowerCase();
}

function metadataBundledSource(persona: Persona): string | undefined {
  const metadata = persona.sourceProperties?.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return undefined;
  }
  const source = (metadata as { berdBundledSource?: unknown })
    .berdBundledSource;
  return typeof source === "string" && source.trim()
    ? source.trim()
    : undefined;
}

export function resolvePersonaForRole(
  roleId: string,
  personas: readonly Persona[],
): Persona | undefined {
  const needle = roleId.trim().toLowerCase();
  if (!needle) return undefined;
  const role = roleById(needle);
  const bySource = personas.find(
    (persona) => metadataBundledSource(persona)?.toLowerCase() === needle,
  );
  if (bySource) return bySource;
  const byStem = personas.find(
    (persona) => fileStemFromPersonaId(persona.id) === needle,
  );
  if (byStem) return byStem;
  const displayName = role?.displayName.toLowerCase() ?? needle;
  return personas.find(
    (persona) => persona.displayName.trim().toLowerCase() === displayName,
  );
}

export function resolveDefaultConductorPersona(
  personas: readonly Persona[],
): Persona | undefined {
  return (
    resolvePersonaForRole(DEFAULT_CONDUCTOR_ROLE_ID, personas) ??
    resolvePersonaForRole(DEFAULT_ORCHESTRATOR_ROLE_ID, personas) ??
    personas.find((persona) =>
      Boolean(metadataBundledSource(persona) || persona.isBuiltin),
    ) ??
    personas[0]
  );
}
