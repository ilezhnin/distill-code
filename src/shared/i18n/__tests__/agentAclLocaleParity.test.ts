import { describe, expect, it } from "vitest";
import enAgents from "../locales/en/agents.json";
import esAgents from "../locales/es/agents.json";

/**
 * Parity check for the agent permission strings.
 *
 * Same scope as the other focused parity tests here: the locales carry
 * pre-existing gaps that a blanket en↔es gate would fail on, so this pins
 * the keys this feature owns. It matters more than usual for these: the
 * secondary lines are assembled from several keys at once — a role name, a
 * layer name, a default — and one missing Spanish key does not read as a
 * missing translation, it reads as a permission sentence with an English
 * key sitting in the middle of it.
 */

const PLACEHOLDER_PATTERN = /\{\{\s*([^}\s]+)\s*\}\}/g;

function placeholdersOf(value: string): string[] {
  return [...value.matchAll(PLACEHOLDER_PATTERN)]
    .map((match) => match[1])
    .sort();
}

function flatten(value: unknown, prefix = ""): Record<string, string> {
  if (typeof value === "string") {
    return { [prefix]: value };
  }
  if (!value || typeof value !== "object") {
    return {};
  }
  return Object.entries(value as Record<string, unknown>).reduce<
    Record<string, string>
  >((flat, [key, child]) => {
    return Object.assign(
      flat,
      flatten(child, prefix ? `${prefix}.${key}` : key),
    );
  }, {});
}

const en = flatten(enAgents.acl);
const es = flatten(esAgents.acl);

describe("agent ACL locale parity", () => {
  it("exists in both locales with the same keys", () => {
    expect(Object.keys(en).length).toBeGreaterThan(0);
    expect(Object.keys(es).sort()).toEqual(Object.keys(en).sort());
  });

  it("keeps interpolation placeholders intact across locales", () => {
    for (const key of Object.keys(en)) {
      expect(
        placeholdersOf(es[key] ?? ""),
        `placeholders for "${key}"`,
      ).toEqual(placeholdersOf(en[key]));
    }
  });

  it("covers every layer the ACL can name", () => {
    // The sentences are generated per layer, so a layer without copy would
    // print a raw key into an operator-facing permission line.
    for (const layer of ["conductor", "orchestrator", "worker"]) {
      expect(en[`layer.${layer}`]).toBeTruthy();
      expect(en[`layerInline.${layer}`]).toBeTruthy();
    }
    for (const role of ["conductor", "orchestrator", "worker", "plain-chat"]) {
      expect(en[`role.${role}`]).toBeTruthy();
    }
    for (const value of ["allowed", "denied", "grant-required"]) {
      expect(en[`memoryWrite.default.${value}`]).toBeTruthy();
    }
  });
});
