import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { Persona } from "@/shared/types/agents";

const mockGooseSourcesList = vi.fn();
const mockGooseSourcesCreate = vi.fn();
const mockGooseSourcesUpdate = vi.fn();
const mockGooseSourcesDelete = vi.fn();
const mockGooseSourcesExport = vi.fn();
const mockGooseSourcesImport = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@/shared/api/acpConnection", () => ({
  getClient: async () => ({
    host: {
      sourcesList: (...args: unknown[]) => mockGooseSourcesList(...args),
      sourcesCreate: (...args: unknown[]) => mockGooseSourcesCreate(...args),
      sourcesUpdate: (...args: unknown[]) => mockGooseSourcesUpdate(...args),
      sourcesDelete: (...args: unknown[]) => mockGooseSourcesDelete(...args),
      sourcesExport: (...args: unknown[]) => mockGooseSourcesExport(...args),
      sourcesImport: (...args: unknown[]) => mockGooseSourcesImport(...args),
    },
  }),
}));

const mockedInvoke = vi.mocked(invoke);

const agentSource = {
  type: "agent",
  name: "Scout",
  description: "Agent",
  content: "Research carefully.",
  path: "/Users/test/.agents/agents/scout.md",
  global: true,
  writable: true,
  properties: {
    provider: "openai",
    model: "gpt-4.1",
    avatar: "https://example.test/scout.png",
  },
} as const;

const loadedPersona: Persona = {
  id: agentSource.path,
  displayName: "Scout",
  avatar: "https://example.test/scout.png",
  systemPrompt: "Research carefully.",
  provider: "openai",
  model: "gpt-4.1",
  isBuiltin: false,
  writable: true,
  sourceDescription: "Agent",
  sourceProperties: {
    provider: "openai",
    model: "gpt-4.1",
    avatar: "https://example.test/scout.png",
  },
};

describe("agents API", () => {
  beforeEach(() => {
    mockGooseSourcesList.mockReset();
    mockGooseSourcesCreate.mockReset();
    mockGooseSourcesUpdate.mockReset();
    mockGooseSourcesDelete.mockReset();
    mockGooseSourcesExport.mockReset();
    mockGooseSourcesImport.mockReset();
    mockedInvoke.mockReset();
  });

  it("drops unsafe avatar properties from listed personas", async () => {
    mockGooseSourcesList.mockResolvedValue({
      sources: [
        {
          ...agentSource,
          properties: {
            avatar: "data:image/png;base64,aWNvbg==",
          },
        },
      ],
    });

    const { listPersonas } = await import("../agents");
    const result = await listPersonas();

    expect(result[0].avatar).toBeNull();
  });

  it("defaults omitted writable to read-only", async () => {
    mockGooseSourcesList.mockResolvedValue({
      sources: [{ ...agentSource, writable: undefined }],
    });

    const { listPersonas } = await import("../agents");
    const result = await listPersonas();

    expect(result[0]).toEqual(
      expect.objectContaining({
        isBuiltin: true,
        writable: false,
      }),
    );
  });

  it("updates personas by merging modeled fields with unknown properties", async () => {
    mockGooseSourcesUpdate.mockResolvedValue({
      source: {
        ...agentSource,
        name: "Scout Prime",
        content: "Updated prompt.",
      },
    });

    const { updatePersona } = await import("../agents");
    await updatePersona(
      {
        ...loadedPersona,
        sourceProperties: {
          provider: "openai",
          model: "gpt-4.1",
          avatar: "https://example.test/scout.png",
          color: "blue",
        },
      },
      {
        displayName: "Scout Prime",
        systemPrompt: "Updated prompt.",
        provider: "anthropic",
      },
    );

    expect(mockGooseSourcesList).not.toHaveBeenCalled();
    expect(mockGooseSourcesUpdate).toHaveBeenCalledWith({
      type: "agent",
      path: agentSource.path,
      name: "Scout Prime",
      description: "Agent",
      content: "Updated prompt.",
      properties: {
        provider: "anthropic",
        model: "gpt-4.1",
        avatar: "https://example.test/scout.png",
        color: "blue",
      },
    });
  });

  it("clears modeled properties while preserving unknown source properties", async () => {
    mockGooseSourcesUpdate.mockResolvedValue({
      source: {
        ...agentSource,
        properties: {
          provider: null,
          model: null,
          avatar: null,
          color: "blue",
        },
      },
    });

    const { updatePersona } = await import("../agents");
    await updatePersona(
      {
        ...loadedPersona,
        sourceDescription: "",
        sourceProperties: {
          provider: "openai",
          model: "gpt-4.1",
          avatar: "data:image/png;base64,aWNvbg==",
          color: "blue",
        },
      },
      {
        avatar: null,
        provider: null,
        model: null,
      },
    );

    expect(mockGooseSourcesList).not.toHaveBeenCalled();
    expect(mockGooseSourcesUpdate).toHaveBeenCalledWith({
      type: "agent",
      path: agentSource.path,
      name: "Scout",
      // The persona's existing sourceDescription is an empty string here,
      // which was never a real, user-authored description to begin with,
      // so it falls back to the placeholder rather than being sent through
      // verbatim.
      description: "Agent",
      content: "Research carefully.",
      properties: {
        provider: null,
        model: null,
        avatar: null,
        color: "blue",
      },
    });
  });

  it("migrates only target properties from the freshest source", async () => {
    const latestSource = {
      ...agentSource,
      name: "Scout Renamed",
      content: "New instructions.",
      properties: {
        ...agentSource.properties,
        color: "green",
      },
    };
    mockGooseSourcesList.mockResolvedValue({ sources: [latestSource] });
    mockGooseSourcesUpdate.mockResolvedValue({
      source: {
        ...latestSource,
        properties: {
          ...latestSource.properties,
          provider: "goose",
          modelProviderId: "databricks_v2",
          model: "goose-gpt-5-5",
        },
      },
    });

    const { migratePersonaTargetIfUnchanged } = await import("../agents");
    await migratePersonaTargetIfUnchanged(
      {
        id: agentSource.path,
        provider: "openai",
        model: "gpt-4.1",
      },
      {
        provider: "goose",
        modelProviderId: "databricks_v2",
        model: "goose-gpt-5-5",
      },
    );

    expect(mockGooseSourcesUpdate).toHaveBeenCalledWith({
      type: "agent",
      path: agentSource.path,
      name: "Scout Renamed",
      description: "Agent",
      content: "New instructions.",
      properties: {
        provider: "goose",
        modelProviderId: "databricks_v2",
        model: "goose-gpt-5-5",
        avatar: "https://example.test/scout.png",
        color: "green",
      },
    });
  });

  it("skips target migration when the target changed after inspection", async () => {
    mockGooseSourcesList.mockResolvedValue({
      sources: [
        {
          ...agentSource,
          properties: {
            ...agentSource.properties,
            provider: "anthropic",
            model: "claude-new",
          },
        },
      ],
    });

    const { migratePersonaTargetIfUnchanged } = await import("../agents");
    const result = await migratePersonaTargetIfUnchanged(
      {
        id: agentSource.path,
        provider: "openai",
        model: "gpt-4.1",
      },
      {
        provider: "goose",
        modelProviderId: "databricks_v2",
        model: "goose-gpt-5-5",
      },
    );

    expect(result).toBeNull();
    expect(mockGooseSourcesUpdate).not.toHaveBeenCalled();
  });

  it("updates persona sources from the exact markdown file when listing omits them", async () => {
    const sourcePath = "/Users/test/.agents/agents/untitled-agent-1.md";
    mockGooseSourcesList.mockResolvedValue({ sources: [] });
    mockedInvoke.mockResolvedValue({
      fileName: "untitled-agent-1.md",
      fileContents:
        "---\nname: Constructive Critic\ndescription: Challenges assumptions.\ndraft: true\nbuilderSessionId: sess-1\n---\n\nPush back constructively.",
    });
    mockGooseSourcesUpdate.mockResolvedValue({
      source: {
        ...agentSource,
        path: sourcePath,
        name: "Constructive Critic",
        description: "Challenges assumptions.",
        content: "Push back with examples.",
        properties: {
          draft: true,
          builderSessionId: "sess-1",
          model: "gpt-4.1",
        },
      },
    });

    const { updatePersonaSource } = await import("../agents");
    await updatePersonaSource(sourcePath, {
      content: "Push back with examples.",
      properties: { model: "gpt-4.1" },
    });

    expect(mockedInvoke).toHaveBeenCalledWith("read_agent_source_file", {
      sourcePath,
    });
    expect(mockGooseSourcesUpdate).toHaveBeenCalledWith({
      type: "agent",
      path: sourcePath,
      name: "Constructive Critic",
      description: "Challenges assumptions.",
      content: "Push back with examples.",
      properties: {
        draft: true,
        builderSessionId: "sess-1",
        model: "gpt-4.1",
      },
    });
  });

  it("exports direct share-card metadata for round trips", async () => {
    mockGooseSourcesList.mockResolvedValue({
      sources: [
        {
          ...agentSource,
          properties: {
            ...agentSource.properties,
            good_for: "finding answers",
            vibes: "curious, thorough",
          },
        },
      ],
    });

    const { exportPersona } = await import("../agents");
    const result = await exportPersona(agentSource.path);

    expect(result.contents).toContain("good_for: finding answers\n");
    expect(result.contents).toContain("vibes: curious, thorough\n");
  });

  it("exports spawns_agents and the contract card for round trips", async () => {
    mockGooseSourcesList.mockResolvedValue({
      sources: [
        {
          ...agentSource,
          properties: {
            ...agentSource.properties,
            spawns_agents: ["scout"],
            when_to_call: "a factual claim needs verifying",
          },
        },
      ],
    });

    const { exportPersona } = await import("../agents");
    const result = await exportPersona(agentSource.path);

    expect(result.contents).toContain("spawns_agents:\n  - scout\n");
    expect(result.contents).toContain(
      "when_to_call: a factual claim needs verifying\n",
    );
  });

  it("drops a non-boolean memory_write value instead of coercing a grant", async () => {
    mockGooseSourcesList.mockResolvedValue({
      sources: [
        {
          ...agentSource,
          properties: {
            ...agentSource.properties,
            // The dangerous shapes: YAML "truthy" strings and numbers.
            memory_write: "true",
          },
        },
        {
          ...agentSource,
          path: "/Users/test/.agents/agents/scout-2.md",
          properties: {
            ...agentSource.properties,
            memory_write: 1,
          },
        },
      ],
    });

    const { listPersonas } = await import("../agents");
    const result = await listPersonas();

    expect(result[0].memoryWrite).toBeUndefined();
    expect(result[1].memoryWrite).toBeUndefined();
  });

  it("keeps a cleared memory_write cleared on an imported persona", async () => {
    // The editor clears an override by writing the property as null. An
    // imported persona also keeps its original frontmatter verbatim under
    // sprout.frontmatter, and reading THAT as the fallback would hand the
    // grant straight back — a clear the operator saw would not be a clear.
    mockGooseSourcesList.mockResolvedValue({
      sources: [
        {
          ...agentSource,
          properties: {
            ...agentSource.properties,
            memory_write: null,
            sprout: { frontmatter: { memory_write: true } },
          },
        },
      ],
    });

    const { listPersonas } = await import("../agents");
    const result = await listPersonas();

    expect(result[0].memoryWrite).toBeUndefined();

    const { exportPersona } = await import("../agents");
    const exported = await exportPersona(agentSource.path);
    expect(exported.contents).not.toContain("memory_write");
  });

  it("keeps a cleared spawns override cleared on an imported persona", async () => {
    mockGooseSourcesList.mockResolvedValue({
      sources: [
        {
          ...agentSource,
          properties: {
            ...agentSource.properties,
            spawns: null,
            sprout: { frontmatter: { spawns: ["worker"] } },
          },
        },
      ],
    });

    const { listPersonas } = await import("../agents");
    const result = await listPersonas();

    // Cleared means unset, not "spawns nothing": the persona is back on its
    // layer's default, which is what an absent key has always meant.
    expect(result[0].spawns).toBeUndefined();
    expect("spawns" in (result[0] ?? {})).toBe(false);
  });

  it("round-trips effort and fast_mode through portable persona markdown", async () => {
    mockGooseSourcesList.mockResolvedValue({
      sources: [
        {
          ...agentSource,
          properties: {
            ...agentSource.properties,
            model: "claude-opus-5",
            effort: "xhigh",
            fast_mode: true,
          },
        },
      ],
    });
    mockGooseSourcesCreate.mockResolvedValue({ source: agentSource });

    const { exportPersona, importPersonas } = await import("../agents");
    const exported = await exportPersona(agentSource.path);
    expect(exported.contents).toContain("effort: xhigh");
    expect(exported.contents).toContain("fast_mode: true");

    await importPersonas(exported.contents, "scout.persona.md");

    const request = mockGooseSourcesCreate.mock.calls[0][0] as {
      properties: Record<string, unknown>;
    };
    expect(request.properties).toMatchObject({
      model: "claude-opus-5",
      effort: "xhigh",
      fast_mode: true,
    });
  });

  it("reads a legacy folded model as its base id plus effort without writing the file", async () => {
    mockGooseSourcesList.mockResolvedValue({
      sources: [
        {
          ...agentSource,
          properties: {
            ...agentSource.properties,
            provider: "codex-acp",
            model: "gpt-5.6-sol[xhigh]",
          },
        },
      ],
    });

    const { listPersonas } = await import("../agents");
    const [persona] = await listPersonas();

    expect(persona?.model).toBe("gpt-5.6-sol");
    expect(persona?.effort).toBe("xhigh");
    expect(persona?.sourceProperties?.model).toBe("gpt-5.6-sol[xhigh]");
    expect(mockGooseSourcesUpdate).not.toHaveBeenCalled();
    expect(mockGooseSourcesCreate).not.toHaveBeenCalled();
  });

  it("does not expose remote avatar URLs in pre-consent previews", async () => {
    const { previewPersonaImport } = await import("../agents");
    const remoteAvatar = "https://attacker.example/track.png";

    const markdown = previewPersonaImport(
      `---\nname: scout\ndisplay_name: Scout\navatar: ${remoteAvatar}\n---\n\nResearch carefully.`,
      "scout.md",
    );
    const legacyJson = previewPersonaImport(
      JSON.stringify({
        version: 1,
        displayName: "Scout",
        systemPrompt: "Research carefully.",
        avatar: { type: "url", value: remoteAvatar },
      }),
      "scout.json",
    );

    expect(markdown.avatar).toBeUndefined();
    expect(legacyJson.avatar).toBeUndefined();
  });

  it("imports Sprout persona markdown through ACP source create", async () => {
    mockGooseSourcesCreate.mockResolvedValue({ source: agentSource });

    const { importPersonas } = await import("../agents");
    const raw = `---
name: scout
display_name: "Scout"
description: "Agent"
model: "openai:gpt-4.1"
avatar: "https://example.test/scout.png"
subscribe:
  - "#agents"
tags: [research, support]
tools:
  web: true
---

Research carefully.
`;

    const result = await importPersonas(raw, "scout.persona.md");

    expect(mockGooseSourcesCreate).toHaveBeenCalledWith({
      type: "agent",
      name: "Scout",
      description: "Agent",
      content: "Research carefully.",
      target: { scope: "global" },
      properties: {
        provider: "openai",
        modelProviderId: null,
        model: "gpt-4.1",
        avatar: "https://example.test/scout.png",
        sprout: {
          name: "scout",
          frontmatter: {
            subscribe: ["#agents"],
            tags: ["research", "support"],
            tools: {
              web: true,
            },
          },
        },
      },
    });
    expect(mockGooseSourcesImport).not.toHaveBeenCalled();
    expect(result).toHaveLength(1);
  });

  it("preserves model ids with colons when importing persona markdown", async () => {
    mockGooseSourcesCreate.mockResolvedValue({ source: agentSource });

    const { importPersonas } = await import("../agents");
    const raw = `---
name: scout
model: bedrock:anthropic.claude:v1
---

Research carefully.
`;

    await importPersonas(raw, "scout.persona.md");

    expect(mockGooseSourcesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        properties: {
          provider: "bedrock",
          modelProviderId: null,
          model: "anthropic.claude:v1",
          sprout: {
            name: "scout",
          },
        },
      }),
    );
  });

  it("imports native agent JSON through ACP source import", async () => {
    mockGooseSourcesImport.mockResolvedValue({ sources: [agentSource] });

    const { importPersonas } = await import("../agents");
    const raw = JSON.stringify({
      version: 1,
      type: "agent",
      name: "Scout",
      description: "Agent",
      content: "Research carefully.",
    });

    await importPersonas(raw, "scout.agent.json");

    expect(mockGooseSourcesImport).toHaveBeenCalledWith({
      data: raw,
      target: { scope: "global" },
    });
    expect(mockGooseSourcesCreate).not.toHaveBeenCalled();
  });

  it("strips unsafe native agent JSON avatar values before ACP import", async () => {
    mockGooseSourcesImport.mockResolvedValue({
      sources: [
        {
          ...agentSource,
          properties: {
            color: "blue",
          },
        },
      ],
    });

    const { importPersonas } = await import("../agents");
    const raw = JSON.stringify({
      version: 1,
      type: "agent",
      name: "Scout",
      description: "Agent",
      content: "Research carefully.",
      avatar: "file:///tmp/scout.png",
      properties: {
        color: "blue",
        avatar: "data:image/png;base64,aWNvbg==",
      },
      metadata: {
        avatar: "javascript:alert(1)",
        tone: "direct",
      },
    });

    const [persona] = await importPersonas(raw, "scout.agent.json");
    const importRequest = mockGooseSourcesImport.mock.calls[0]?.[0] as {
      data: string;
    };
    const importedPayload = JSON.parse(importRequest.data);

    expect(importedPayload.avatar).toBeUndefined();
    expect(importedPayload.properties).toEqual({ color: "blue" });
    expect(importedPayload.metadata).toEqual({ tone: "direct" });
    expect(mockGooseSourcesUpdate).not.toHaveBeenCalled();
    expect(persona.avatar).toBeNull();
  });

  it("validates legacy persona import fields before importing", async () => {
    const { importPersonas } = await import("../agents");
    const raw = JSON.stringify({
      version: 2,
      displayName: "Scout",
      systemPrompt: "Research carefully.",
    });

    await expect(importPersonas(raw, "scout.persona.json")).rejects.toThrow(
      "Unsupported persona format version 2",
    );
    expect(mockGooseSourcesCreate).not.toHaveBeenCalled();
    expect(mockGooseSourcesImport).not.toHaveBeenCalled();
  });

  it("keeps the empty spawns override distinct from no override", async () => {
    mockGooseSourcesList.mockResolvedValue({
      sources: [
        {
          ...agentSource,
          properties: { ...agentSource.properties, spawns: [] },
        },
      ],
    });

    const { listPersonas } = await import("../agents");
    const result = await listPersonas();

    // [] means "may spawn nothing"; a missing field means "layer default".
    expect(result[0]?.spawns).toEqual([]);
    expect("spawns" in (result[0] ?? {})).toBe(true);
  });

  it("drops a garbled spawns override instead of half-honouring it", async () => {
    mockGooseSourcesList.mockResolvedValue({
      sources: [
        {
          ...agentSource,
          properties: {
            ...agentSource.properties,
            spawns: ["worker", "supervisor"],
          },
        },
      ],
    });

    const { listPersonas } = await import("../agents");
    const result = await listPersonas();

    expect(result[0]?.spawns).toBeUndefined();
  });
});
