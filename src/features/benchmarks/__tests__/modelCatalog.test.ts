import { describe, expect, it } from "vitest";
import {
  formatContext,
  formatPrice,
  latestCheckedAt,
  resolveCatalogEntry,
} from "../lib/modelCatalog";
import type { CatalogEntry } from "../types";
import { configuration } from "./fixtures";
import vendorSeeds from "./fixtures/catalog-seeds-2026-10-03.json";

function entry(overrides: Partial<CatalogEntry>): CatalogEntry {
  return {
    id: "entry",
    kind: "model",
    providerId: null,
    needle: "opus 5.5",
    displayName: "Claude Opus 5.5",
    vendor: "Anthropic",
    inputPerMillion: 4,
    outputPerMillion: 20,
    cacheReadPerMillion: 0.2,
    cacheWritePerMillion: 5,
    contextTokens: 1_000_000,
    effectiveFrom: 1_000,
    checkedAt: 1_000,
    source: "vendor page",
    createdAt: 1_000,
    ...overrides,
  };
}

describe("model catalog resolution", () => {
  const opus = { ...configuration, modelId: "opus" };

  it("matches the bridge name or the id, within the provider when one is named", () => {
    const entries = [entry({})];
    expect(resolveCatalogEntry(entries, opus, "Opus 5.5", 2_000)?.id).toBe(
      "entry",
    );
    expect(resolveCatalogEntry(entries, opus, null, 2_000)).toBeNull();
    expect(
      resolveCatalogEntry(
        [entry({ needle: "opus", providerId: "codex-acp" })],
        opus,
        null,
        2_000,
      ),
    ).toBeNull();
    expect(
      resolveCatalogEntry(
        [entry({ needle: "opus", providerId: "claude-acp" })],
        opus,
        null,
        2_000,
      )?.id,
    ).toBe("entry");
  });

  it("keeps the price that applied at measurement time", () => {
    const entries = [
      entry({ id: "old", effectiveFrom: 1_000, outputPerMillion: 20 }),
      entry({ id: "new", effectiveFrom: 5_000, outputPerMillion: 30 }),
    ];
    expect(resolveCatalogEntry(entries, opus, "Opus 5.5", 3_000)?.id).toBe(
      "old",
    );
    expect(resolveCatalogEntry(entries, opus, "Opus 5.5", 6_000)?.id).toBe(
      "new",
    );
    // A run older than every known price gets no price, not a guess.
    expect(resolveCatalogEntry(entries, opus, "Opus 5.5", 500)).toBeNull();
    // Without a measurement time the newest entry answers.
    expect(resolveCatalogEntry(entries, opus, "Opus 5.5", null)?.id).toBe(
      "new",
    );
  });

  it("formats prices, context sizes and the check date", () => {
    expect(formatPrice(entry({}))).toBe("$4 / $20");
    expect(
      formatPrice(entry({ inputPerMillion: 0.435, outputPerMillion: 0.87 })),
    ).toBe("$0.435 / $0.87");
    expect(formatPrice(entry({ outputPerMillion: null }))).toBeNull();
    // An estimate reads as one wherever the price is shown.
    expect(
      formatPrice(entry({ source: "estimate: priced as its sibling" })),
    ).toBe("~$4 / $20");
    expect(formatContext(1_000_000)).toBe("1M");
    expect(formatContext(1_050_000)).toBe("1.05M");
    expect(formatContext(500_000)).toBe("500K");
    expect(formatContext(null)).toBeNull();
    expect(
      latestCheckedAt([entry({ checkedAt: 10 }), entry({ checkedAt: 30 })]),
    ).toBe(30);
  });
});

describe("vendor seed sets", () => {
  // The rows the Rust catalog seeds; its test compares them field by field.
  const seeds = vendorSeeds as CatalogEntry[];

  it("each seed resolves only its models", () => {
    const cases: [string, string, string, string | null][] = [
      ["codex-acp", "gpt-6-astra", "GPT-6-Astra", "seed-openai-gpt-6-astra"],
      ["codex-acp", "gpt-6-sol", "GPT-6-Sol", "seed-openai-gpt-6-sol"],
      ["codex-acp", "gpt-6-luna", "GPT-6-Luna", "seed-openai-gpt-6-luna"],
      ["codex-acp", "gpt-6.1-sol", "GPT-6.1-Sol", "seed-openai-gpt-6-1-sol"],
      ["codex-acp", "gpt-5.6-sol", "GPT-5.6-Sol", "seed-openai-gpt-5-6-sol"],
      [
        "codex-acp",
        "gpt-5.6-terra",
        "GPT-5.6-Terra",
        "seed-openai-gpt-5-6-terra",
      ],
      ["codex-acp", "gpt-5.6-luna", "GPT-5.6-Luna", "seed-openai-gpt-5-6-luna"],
      ["codex-acp", "gpt-5.5", "GPT-5.5", "seed-openai-gpt-5-5"],
      ["grok-acp", "grok-4.7", "Grok 4.7", "seed-xai-grok-4-7"],
      [
        "grok-acp",
        "grok-4.7-build-fast",
        "Grok 4.7 Fast",
        "seed-xai-grok-4-7-build-fast",
      ],
      ["grok-acp", "grok-4.6", "Grok 4.6", "seed-xai-grok-4-6"],
      ["grok-acp", "grok-4.5", "Grok 4.5", "seed-xai-grok-4-5"],
      ["kimi-acp", "kimi-code/k3", "K3", "seed-moonshot-k3"],
      ["kimi-acp", "kimi-code/k3-256k", "K3-256k", "seed-moonshot-k3"],
      ["kimi-acp", "kimi-code/kimi-for-coding", "K2.8 Preview", null],
      [
        "kimi-acp",
        "kimi-code/kimi-for-coding-highspeed",
        "K2.7 Code Highspeed",
        "seed-moonshot-k2-7-code-highspeed",
      ],
      // A vendor's entry never prices another provider's row.
      ["grok-acp", "gpt-6-sol", "GPT-6-Sol", null],
      ["claude-acp", "kimi-code/k3", "K3", null],
    ];
    for (const [providerId, modelId, name, expected] of cases) {
      expect(
        resolveCatalogEntry(
          seeds,
          { ...configuration, providerId, modelId },
          name,
          null,
        )?.id ?? null,
        `${providerId} ${modelId}`,
      ).toBe(expected);
    }
    // The Fast row resolves to unknown prices, not Grok 4.7's.
    const fast = resolveCatalogEntry(
      seeds,
      {
        ...configuration,
        providerId: "grok-acp",
        modelId: "grok-4.7-build-fast",
      },
      "Grok 4.7 Fast",
      null,
    );
    expect(formatPrice(fast)).toBeNull();
  });
});
