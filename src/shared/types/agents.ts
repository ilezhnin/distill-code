// Provider types map to goose serve provider names.
// The provider list is dynamic, so this remains a plain string rather than
// a narrow union.
export type ProviderType = string;

// Avatar values are stored directly in ACP source properties as either
// credential-free http(s) URLs or app-managed refs like app-avatar:gloopy-1.
export type Avatar = string;

/**
 * A layer of the conductor graph an agent can be allowed to spawn.
 *
 * This is the same union as `RoleLayer` in the conductor feature's role
 * catalog; it is defined here because the persona schema (a shared type) may
 * not depend on a feature module. `roleCatalog.ts` aliases its `RoleLayer`
 * to this type so the union has exactly one owner.
 */
export type AgentSpawnLayer = "conductor" | "orchestrator" | "worker";

// Persona types (from sprout)
export interface Persona {
  id: string;
  displayName: string;
  avatar?: Avatar | null;
  systemPrompt: string;
  provider?: ProviderType;
  modelProviderId?: string;
  model?: string;
  /** Ranked model preference class id; overrides the single `model`. */
  modelRanking?: string;
  /**
   * Per-agent spawn ACL override from persona frontmatter: which conductor
   * graph layers a session running this persona may start. Absent means "use
   * the defaults of whatever layer the session runs on"; an empty array is a
   * real override meaning "may spawn nothing". Enforced in code by the
   * conductor feature's spawn ACL, not just stated in prompt text.
   */
  spawns?: AgentSpawnLayer[];
  /**
   * Per-agent named spawn allowlist from persona frontmatter
   * (`spawns_agents`): which agents, by name, a session running this
   * persona may start. Absent means "no name restriction — the layer ACL
   * alone decides"; an empty array is a real override meaning "may start
   * no agents by name". Deny-by-default once authored: a spawn naming an
   * agent outside the list, or naming no agent at all, is refused.
   */
  spawnsAgents?: string[];
  /** Contract card (`when_to_call`): when a caller should start this agent. */
  whenToCall?: string;
  /** Contract card (`required_input`): what a caller must include in the task. */
  requiredInput?: string;
  /** Contract card (`expected_output`): what this agent returns when done. */
  expectedOutput?: string;
  isBuiltin: boolean;
  writable: boolean;
  sourceDescription?: string;
  /** Optional share-card copy sourced from agent frontmatter. */
  goodFor?: string;
  vibes?: string;
  /**
   * Whether a conductor-graph orchestrator running this persona may write
   * operator memory (`memory_write` in persona frontmatter). Only a literal
   * boolean in the source counts; absent means "not granted" — the
   * orchestrator layer defaults to read-only memory.
   */
  memoryWrite?: boolean;
  sourceProperties?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

export interface CreatePersonaRequest {
  displayName: string;
  description?: string;
  avatar?: Avatar | null;
  systemPrompt: string;
  goodFor?: string;
  vibes?: string;
  provider?: ProviderType;
  modelProviderId?: string;
  model?: string;
  modelRanking?: string;
}

export interface UpdatePersonaRequest {
  displayName?: string;
  description?: string;
  avatar?: Avatar | null;
  systemPrompt?: string;
  provider?: ProviderType | null;
  modelProviderId?: string | null;
  model?: string | null;
  modelRanking?: string | null;
}

// Agent types
export type AgentStatus = "online" | "offline" | "starting" | "error";
export type AgentConnectionType = "builtin" | "acp";

export interface Agent {
  id: string;
  name: string;
  personaId?: string;
  persona?: Persona;
  provider: ProviderType;
  model: string;
  systemPrompt?: string;
  connectionType: AgentConnectionType;
  status: AgentStatus;
  isBuiltin: boolean;
  acpEndpoint?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAgentRequest {
  name: string;
  personaId?: string;
  provider: ProviderType;
  model: string;
  systemPrompt?: string;
  connectionType: AgentConnectionType;
  acpEndpoint?: string;
}

// Session, TokenState, and ChatState are defined in ./chat.ts
