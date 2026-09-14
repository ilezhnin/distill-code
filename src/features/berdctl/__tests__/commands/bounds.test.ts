import { describe, expect, it } from "vitest";
import { z } from "zod/v4";

import { buildApiSurfaceContract } from "@/features/berdctl/commands/contract";
import { TOOL_GROUPS } from "@/features/berdctl/commands/registry";
import {
  type AppCommand,
  defineCommand,
} from "@/features/berdctl/commands/types";

const createSessionSchema = TOOL_GROUPS.sessions.actions.create.schema;
const sendSessionSchema = TOOL_GROUPS.sessions.actions.send.schema;
const getSessionSchema = TOOL_GROUPS.sessions.actions.get.schema;
const listSessionsSchema = TOOL_GROUPS.sessions.actions.list.schema;
const renameSessionSchema = TOOL_GROUPS.sessions.actions.rename.schema;
const moveSessionSchema = TOOL_GROUPS.sessions.actions.move.schema;
const createAgentSchema = TOOL_GROUPS.agents.actions.create.schema;
const createSkillSchema = TOOL_GROUPS.skills.actions.create.schema;
const createProjectSchema = TOOL_GROUPS.projects.actions.create.schema;
const attachSessionFolderSchema = TOOL_GROUPS.folders.actions.attach.schema;

// Strict-mode (unknown-key rejection) for EVERY action schema is covered in
// commands.test.ts, derived from TOOL_GROUPS so new actions cannot skip it.
// These bounds assertions read the colocated command modules through the
// registry, so a moved schema cannot silently lose its guardrails.
describe("berdctl command schema bounds", () => {
  // Invariant 3: bounds live in zod, clap only mirrors them. The only other
  // limit on a wire string is axum's 2 MiB body cap, which is not a product
  // bound — without a max, one call can persist a ~1.9 MB session title or
  // persona system prompt. Read through the generated contract so the same
  // introspection the CLI is built from is what gets asserted, and so a new
  // command cannot land unbounded.
  it("declares a max on every string field of every action", () => {
    const api = buildApiSurfaceContract();
    const unbounded: string[] = [];
    for (const [group, groupSpec] of Object.entries(api.groups)) {
      for (const [action, actionSpec] of Object.entries(groupSpec.actions)) {
        for (const field of actionSpec.fields) {
          if (field.kind !== "string" || field.values) continue;
          if (field.max === undefined) {
            unbounded.push(`${group}.${action}.${field.name}`);
          }
        }
      }
    }
    expect(unbounded).toEqual([]);
  });

  // String arrays carry their bounds only in the JSON Schema projection (the
  // flat field model has no element/count slots), so assert them there:
  // every array needs both an element length cap and an element count cap.
  it("declares element and count caps on every string array", () => {
    const api = buildApiSurfaceContract();
    const missing: string[] = [];
    for (const [group, groupSpec] of Object.entries(api.groups)) {
      for (const [action, actionSpec] of Object.entries(groupSpec.actions)) {
        const properties = (actionSpec.schema.properties ?? {}) as Record<
          string,
          { type?: string; maxItems?: number; items?: { maxLength?: number } }
        >;
        for (const field of actionSpec.fields) {
          if (field.kind !== "string_array") continue;
          const property = properties[field.name];
          const where = `${group}.${action}.${field.name}`;
          if (property?.maxItems === undefined)
            missing.push(`${where} maxItems`);
          if (property?.items?.maxLength === undefined) {
            missing.push(`${where} items.maxLength`);
          }
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("rejects free text past its cap", () => {
    // Spot-check one field per bound class, so the exhaustive assertions above
    // cannot pass with a max that is declared but not enforced.
    expect(
      renameSessionSchema.safeParse({
        session_id: "s1",
        title: "a".repeat(201),
      }).success,
    ).toBe(false);
    expect(
      createAgentSchema.safeParse({
        name: "reviewer",
        system_prompt: "a".repeat(256 * 1024 + 1),
      }).success,
    ).toBe(false);
    expect(
      attachSessionFolderSchema.safeParse({
        session_id: "s1",
        path: `C:\\${"a".repeat(4096)}`,
      }).success,
    ).toBe(false);
    expect(
      listSessionsSchema.safeParse({ query: "a".repeat(501) }).success,
    ).toBe(false);
    expect(
      createProjectSchema.safeParse({
        name: "p",
        working_dir: Array.from({ length: 33 }, () => "C:\\src"),
      }).success,
    ).toBe(false);
    expect(
      createProjectSchema.safeParse({
        name: "p",
        working_dir: [`C:\\${"a".repeat(4096)}`],
      }).success,
    ).toBe(false);
    expect(
      getSessionSchema.safeParse({ session_id: "s".repeat(201) }).success,
    ).toBe(false);
  });

  it("sessions.create requires prompt and accepts harness selection", () => {
    expect(createSessionSchema.safeParse({}).success).toBe(false);
    expect(
      createSessionSchema.safeParse({
        prompt: "hi",
        harness_id: "codex-acp",
        project_id: "p1",
        agent_id: "a1",
        model_id: "m1",
      }).success,
    ).toBe(true);
  });

  it("sessions.create bounds the effort and takes fast mode as a boolean", () => {
    const base = { prompt: "hi", model_id: "gpt-5.6-sol" };
    expect(
      createSessionSchema.safeParse({ ...base, effort: "a".repeat(201) })
        .success,
    ).toBe(false);
    expect(
      createSessionSchema.safeParse({ ...base, effort: "   " }).success,
    ).toBe(false);
    expect(
      createSessionSchema.safeParse({ ...base, fast_mode: "on" }).success,
    ).toBe(false);
    expect(
      createSessionSchema.safeParse({
        ...base,
        effort: "xhigh",
        fast_mode: true,
      }).success,
    ).toBe(true);
  });

  it("sessions.send bounds prompt and defaults if_running to refuse", () => {
    expect(sendSessionSchema.safeParse({ session_id: "s1" }).success).toBe(
      false,
    );
    expect(
      sendSessionSchema.safeParse({ session_id: "s1", prompt: "" }).success,
    ).toBe(false);
    expect(
      sendSessionSchema.safeParse({
        session_id: "s1",
        prompt: "hi",
        if_running: "later",
      }).success,
    ).toBe(false);
    expect(
      sendSessionSchema.safeParse({
        session_id: "s1",
        prompt: "hi",
        startup_name: "   ",
      }).success,
    ).toBe(false);
    expect(
      sendSessionSchema.parse({
        session_id: "s1",
        prompt: "hi",
        startup_name: " feature ",
      }).startup_name,
    ).toBe("feature");
    expect(
      sendSessionSchema.parse({ session_id: "s1", prompt: "hi" }).if_running,
    ).toBe("refuse");
    expect(
      sendSessionSchema.safeParse({
        session_id: "s1",
        prompt: "hi",
        if_running: "queue",
      }).success,
    ).toBe(true);
  });

  it("sessions.get bounds messages and defaults to metadata only", () => {
    expect(
      getSessionSchema.safeParse({ session_id: "s1", messages: -1 }).success,
    ).toBe(false);
    expect(
      getSessionSchema.safeParse({ session_id: "s1", messages: 51 }).success,
    ).toBe(false);
    expect(getSessionSchema.parse({ session_id: "s1" }).messages).toBe(0);
    expect(
      getSessionSchema.parse({ session_id: "s1", messages: 50 }).messages,
    ).toBe(50);
  });

  it("sessions.list enforces limit bounds and defaults to 20", () => {
    expect(listSessionsSchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(listSessionsSchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(listSessionsSchema.safeParse({ limit: 1.5 }).success).toBe(false);
    expect(listSessionsSchema.safeParse({ limit: 1 }).success).toBe(true);
    expect(listSessionsSchema.safeParse({ limit: 100 }).success).toBe(true);

    const parsed = listSessionsSchema.parse({});
    expect(parsed.limit).toBe(20);
  });

  it("sessions.rename rejects an empty title", () => {
    expect(
      renameSessionSchema.safeParse({ session_id: "s1", title: "" }).success,
    ).toBe(false);
  });

  it("sessions.move requires a destination project id", () => {
    expect(
      moveSessionSchema.safeParse({ session_id: "s1", project_id: null })
        .success,
    ).toBe(false);
    expect(moveSessionSchema.safeParse({ session_id: "s1" }).success).toBe(
      false,
    );
    expect(
      moveSessionSchema.safeParse({ session_id: "s1", project_id: "p1" })
        .success,
    ).toBe(true);
  });

  it("agents.create requires a provider for a model", () => {
    const base = { name: "reviewer", system_prompt: "review code" };
    expect(
      createAgentSchema.safeParse({ ...base, model: "gpt-5.6" }).success,
    ).toBe(false);
    expect(
      createAgentSchema.safeParse({
        ...base,
        provider: "codex-acp",
        model: "gpt-5.6",
      }).success,
    ).toBe(true);
  });

  it("defineCommand stays assignable to AppCommand when fields have defaults", async () => {
    // Compile-time check: input/output divergence from .default() must not
    // break `schema: ZodType<In, unknown>`, and defineCommand must infer
    // `args` from the schema without manual annotations.
    const command = defineCommand({
      effect: "read",
      visibility: "none",
      destructive: false,
      summary: "List sessions",
      description: "List sessions",
      helpFooter: "Example: list",
      schema: z
        .object({ limit: z.number().int().min(1).max(100).default(20) })
        .strict(),
      execute: async (args) => ({ count: args.limit }),
    });
    const asAppCommand: AppCommand<{ limit: number }, { count: number }> =
      command;

    const parsed = asAppCommand.schema.parse({});
    await expect(asAppCommand.execute(parsed, {})).resolves.toEqual({
      count: 20,
    });
  });

  it("skills.create requires non-empty name, description, and content", () => {
    expect(
      createSkillSchema.safeParse({ name: "", description: "d", content: "c" })
        .success,
    ).toBe(false);
    expect(
      createSkillSchema.safeParse({ name: "n", description: "", content: "c" })
        .success,
    ).toBe(false);
    expect(
      createSkillSchema.safeParse({ name: "n", description: "d", content: "" })
        .success,
    ).toBe(false);
  });
});
