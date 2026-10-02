import { describe, expect, it } from "vitest";
import {
  formatContext,
  formatPrice,
  latestCheckedAt,
  resolveCatalogEntry,
} from "../lib/modelCatalog";
import type { CatalogEntry } from "../types";
import { configuration } from "./fixtures";

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
    expect(formatContext(1_000_000)).toBe("1M");
    expect(formatContext(1_050_000)).toBe("1.05M");
    expect(formatContext(500_000)).toBe("500K");
    expect(formatContext(null)).toBeNull();
    expect(
      latestCheckedAt([entry({ checkedAt: 10 }), entry({ checkedAt: 30 })]),
    ).toBe(30);
  });
});
