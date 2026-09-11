import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const LOCALES_DIR = resolve(process.cwd(), "src/shared/i18n/locales");
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

function flattenKeys(value: unknown, prefix = ""): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [prefix];
  }
  return Object.entries(value).flatMap(([key, child]) =>
    flattenKeys(child, prefix ? `${prefix}.${key}` : key),
  );
}

function namespaceKeys(locale: string, file: string): Set<string> {
  const parsed: unknown = JSON.parse(
    readFileSync(resolve(LOCALES_DIR, locale, file), "utf8"),
  );
  return new Set(
    flattenKeys(parsed).map((key) => key.replace(PLURAL_SUFFIX, "")),
  );
}

function namespaceFiles(locale: string): string[] {
  const files = readdirSync(resolve(LOCALES_DIR, locale));
  return files.filter((file) => file.endsWith(".json")).sort();
}

describe("locale key parity", () => {
  const namespaces = namespaceFiles("en");

  it("ships the same namespaces in every locale", () => {
    expect(namespaceFiles("es")).toEqual(namespaces);
  });

  it.each(namespaces)("%s has the same keys in en and es", (file) => {
    const en = namespaceKeys("en", file);
    const es = namespaceKeys("es", file);
    expect([...en].filter((key) => !es.has(key))).toEqual([]);
    expect([...es].filter((key) => !en.has(key))).toEqual([]);
  });
});
