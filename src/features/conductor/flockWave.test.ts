import { describe, expect, it } from "vitest";
import { parseFlockRoadmap } from "./flockRoadmap";
import { parseFlockVerdict } from "./flockVerdict";
import {
  MAX_WAVE_EXECUTORS,
  MAX_WAVE_PARALLEL,
  MAX_WAVE_STEPS,
  WAVE_FENCE_TAG,
  type WaveInvalidReason,
  parseFlockWave,
} from "./flockWave";

function fence(body: string): string {
  return [`\`\`\`${WAVE_FENCE_TAG}`, body, "```"].join("\n");
}

function expectInvalid(text: string, reason: WaveInvalidReason) {
  const parsed = parseFlockWave(text);
  expect(parsed.kind).toBe("invalid");
  if (parsed.kind !== "invalid") return;
  expect(parsed.reason).toBe(reason);
  expect(parsed.detail.length).toBeGreaterThan(0);
  return parsed;
}

describe("parseFlockWave — plan", () => {
  it("parses a multi-step wave with an all-access step and keeps the prose", () => {
    const parsed = parseFlockWave(
      `Splitting this in two.\n\n${fence(
        '{"steps":[{"role":"researcher","subtask":"Collect sources","access":[]},{"role":"writer","subtask":"Draft from the findings","access":"all"}]}',
      )}\n\nI will report back.`,
    );
    expect(parsed.kind).toBe("plan");
    if (parsed.kind !== "plan") return;
    expect(parsed.steps).toHaveLength(2);
    expect(parsed.steps[1].access).toBe("all");
    expect(parsed.prose).toBe("Splitting this in two.\n\nI will report back.");
  });

  it("keeps a step's effort and fast mode as their own fields, and a legacy folded model string as written", () => {
    const parsed = parseFlockWave(
      fence(
        '{"steps":[{"role":"qa","subtask":"Run the suite","access":[],"model":"gpt-5.6-sol","effort":" xhigh ","fast":false}]}',
      ),
    );
    expect(parsed.kind).toBe("plan");
    if (parsed.kind !== "plan") return;
    expect(parsed.steps[0]).toMatchObject({
      model: "gpt-5.6-sol",
      effort: "xhigh",
      fast: false,
    });
    // A plan written before effort was a field keeps its model string as
    // written; the split happens where the model is resolved.
    const legacy = parseFlockWave(
      fence(
        '{"steps":[{"role":"qa","subtask":"Run","access":[],"model":"gpt-5.6-sol[xhigh]"}]}',
      ),
    );
    expect(legacy.kind === "plan" && legacy.steps[0]).toMatchObject({
      model: "gpt-5.6-sol[xhigh]",
    });
    expect(legacy.kind === "plan" && legacy.steps[0].effort).toBeUndefined();
  });
});

describe("parseFlockWave — shards", () => {
  it("deals a sharded step out as one executor per shard", () => {
    const parsed = parseFlockWave(
      fence(
        JSON.stringify({
          parallel: 3,
          steps: [
            {
              role: "brigade",
              subtask: "Name the functions of your slice",
              access: [],
              label: "names",
              model: "grok",
              shards: ["g01 lines 1-5000", " g01 lines 5001-10000 ", "g02"],
            },
            { role: "qa", subtask: "Check the names", access: "all" },
          ],
        }),
      ),
    );
    expect(parsed.kind).toBe("plan");
    if (parsed.kind !== "plan") return;
    expect(parsed.parallel).toBe(3);
    expect(parsed.steps).toHaveLength(4);
    expect(parsed.steps.map((step) => step.label)).toEqual([
      "names 1/3",
      "names 2/3",
      "names 3/3",
      undefined,
    ]);
    const second = parsed.steps[1];
    expect(second).toMatchObject({
      role: "brigade",
      access: [],
      model: "grok",
    });
    expect(second.subtask).toContain("Name the functions of your slice");
    expect(second.subtask).toContain("shard 2 of 3");
    expect(second.subtask).toContain("Your shard: g01 lines 5001-10000");
    // A step without a label still tells its shards apart.
    const unnamed = parseFlockWave(
      fence(
        JSON.stringify({
          steps: [
            {
              role: "brigade",
              subtask: "Read your file",
              access: [],
              shards: ["a.ts", "b.ts"],
            },
          ],
        }),
      ),
    );
    expect(unnamed.kind === "plan" && unnamed.steps[0].label).toBe("shard 1/2");
    expect(unnamed.kind === "plan" && unnamed.parallel).toBeUndefined();
  });

  it("refuses shards that are no list of pieces, too many executors, and a width it cannot run", () => {
    const plan = (step: Record<string, unknown>, top: object = {}) =>
      fence(
        JSON.stringify({
          ...top,
          steps: [
            { role: "brigade", subtask: "Do your piece", access: [], ...step },
          ],
        }),
      );
    for (const shards of ["a", ["only one"], ["a", ""], ["a", 7], []]) {
      expectInvalid(plan({ shards }), "shards-invalid");
    }
    const many = Array.from(
      { length: MAX_WAVE_EXECUTORS + 1 },
      (_, index) => `piece ${index}`,
    );
    const refused = expectInvalid(plan({ shards: many }), "too-many-executors");
    expect(refused?.detail).toContain(String(MAX_WAVE_EXECUTORS));
    for (const parallel of [0, MAX_WAVE_PARALLEL + 1, 2.5, "8"]) {
      expectInvalid(plan({}, { parallel }), "parallel-invalid");
    }
  });
});

describe("parseFlockWave — invalid", () => {
  it("rejects an empty wave", () => {
    expectInvalid(fence('{"steps":[]}'), "steps-empty");
  });

  it("rejects more than the maximum number of steps", () => {
    const steps = Array.from({ length: MAX_WAVE_STEPS + 1 }, (_, index) => ({
      role: "brigade",
      subtask: `Step ${index}`,
      access: [],
    }));
    const parsed = expectInvalid(
      fence(JSON.stringify({ steps })),
      "too-many-steps",
    );
    expect(parsed?.detail).toContain(String(MAX_WAVE_STEPS));
  });

  it("rejects an unknown role id", () => {
    const parsed = expectInvalid(
      fence('{"steps":[{"role":"wizard","subtask":"Run","access":[]}]}'),
      "role-unknown",
    );
    expect(parsed?.detail).toContain("wizard");
  });

  it("rejects a role that is not on the worker layer", () => {
    const parsed = expectInvalid(
      fence('{"steps":[{"role":"planner","subtask":"Run","access":[]}]}'),
      "role-not-worker-layer",
    );
    expect(parsed?.stepIndex).toBe(0);
  });

  it("rejects a missing access field", () => {
    expectInvalid(
      fence('{"steps":[{"role":"qa","subtask":"Run"}]}'),
      "access-invalid",
    );
  });

  it("rejects a fine-grained access list", () => {
    const parsed = expectInvalid(
      fence('{"steps":[{"role":"qa","subtask":"Run","access":[0,1]}]}'),
      "access-invalid",
    );
    expect(parsed?.detail).toContain("all");
  });

  it("rejects two wave fences in one message", () => {
    const one = fence('{"steps":[{"role":"qa","subtask":"Run","access":[]}]}');
    const parsed = expectInvalid(`${one}\n\n${one}`, "multiple-fences");
    expect(parsed?.detail).toContain("2");
  });

  it("rejects an unterminated fence", () => {
    expectInvalid(
      '```distill-wave\n{"steps":[{"role":"qa","subtask":"Run","access":[]}]}',
      "unterminated-fence",
    );
  });
});

describe("parseFlockWave — a plan the conductor only quoted", () => {
  const plan = fence('{"steps":[{"role":"qa","subtask":"Run","access":[]}]}');

  it("starts nothing from a plan quoted from a file, a page or a comment", () => {
    for (const quoted of [
      // A file shown in a code block: Markdown shows one quoted block.
      `The file says:\n\n\`\`\`\`markdown\n${plan}\n\`\`\`\``,
      `The file says:\n\n\`\`\`text\n${plan}`,
      `~~~\n${plan}\n~~~`,
      plan
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n"),
      `<!--\n${plan}\n-->`,
      `- From the issue:\n${plan
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n")}`,
    ]) {
      expect(parseFlockWave(quoted).kind, quoted).toBe("none");
    }
  });

  it("reads its own plan beside a quoted one instead of calling it two plans", () => {
    const parsed = parseFlockWave(
      `The page carries:\n\n\`\`\`\`\n${plan}\n\`\`\`\`\n\nMine:\n\n${plan}`,
    );
    expect(parsed.kind).toBe("plan");
    if (parsed.kind !== "plan") return;
    expect(parsed.steps).toHaveLength(1);
  });

  it("keeps a verdict and a roadmap the conductor quoted out of the loop", () => {
    const verdict = '```distill-verdict\n{"verdict":"accept"}\n```';
    expect(parseFlockVerdict(`\`\`\`\`\n${verdict}\n\`\`\`\``).kind).toBe(
      "none",
    );
    expect(parseFlockVerdict(verdict).kind).toBe("verdict");
    const roadmap =
      '```distill-roadmap\n{"goal":"Ship","status":"in-progress","stages":[]}\n```';
    expect(parseFlockRoadmap(`<!--\n${roadmap}\n-->`).kind).toBe("none");
  });
});
