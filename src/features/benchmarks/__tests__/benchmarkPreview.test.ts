import { describe, expect, it } from "vitest";
import {
  previewDocument,
  rubricCriteriaOf,
  weightedShare,
} from "../lib/benchmarkPreview";

describe("previewDocument", () => {
  it("wraps an SVG, also when a Markdown fence surrounds it, under a no-script policy", () => {
    const fenced =
      "```svg\n<svg xmlns='http://www.w3.org/2000/svg'><rect/></svg>\n```";
    const document = previewDocument(fenced, "svg");
    expect(document).toContain(
      "<svg xmlns='http://www.w3.org/2000/svg'><rect/></svg>",
    );
    expect(document).toContain("default-src 'none'");
    expect(document?.startsWith("<!doctype html>")).toBe(true);
  });

  it("drops an opening fence that was never closed", () => {
    const open =
      "```svg\n<svg xmlns='http://www.w3.org/2000/svg'><rect/></svg>";
    const document = previewDocument(open, "svg");
    expect(document).toContain("<body><svg xmlns=");
    expect(document).not.toContain("```");
  });

  it("injects the policy into an HTML document's head", () => {
    const page =
      "<!doctype html><html><head><title>x</title></head><body>hi</body></html>";
    const document = previewDocument(page, "html");
    expect(document?.indexOf("Content-Security-Policy")).toBeLessThan(
      document?.indexOf("<title>") ?? -1,
    );
  });

  it("renders nothing for prose or code", () => {
    expect(previewDocument("42", "text")).toBeNull();
    expect(previewDocument("fn main() {}", "rust")).toBeNull();
    expect(previewDocument(null, "svg")).toBeNull();
  });
});

describe("rubric criteria", () => {
  const criteria = rubricCriteriaOf({
    rubricCriteria: [
      { id: "adherence", label: "Prompt adherence", weight: 25 },
      { id: "aesthetics", label: "Aesthetics", weight: 25 },
      { id: "craft", label: "Craft", weight: 50 },
      { id: "", label: "Broken", weight: 10 },
      { id: "zero", label: "Zero", weight: 0 },
    ],
  });

  it("keeps only well-formed weighted criteria", () => {
    expect(criteria.map((criterion) => criterion.id)).toEqual([
      "adherence",
      "aesthetics",
      "craft",
    ]);
    expect(rubricCriteriaOf(null)).toEqual([]);
    expect(rubricCriteriaOf({ rubricCriteria: "x" })).toEqual([]);
  });

  it("weights the 0 to 10 scores into a share", () => {
    expect(
      weightedShare(criteria, { adherence: 10, aesthetics: 10, craft: 10 }),
    ).toBe(1);
    expect(
      weightedShare(criteria, { adherence: 10, aesthetics: 0, craft: 5 }),
    ).toBe(0.5);
    expect(weightedShare(criteria, {})).toBe(0);
    expect(weightedShare([], { adherence: 10 })).toBe(0);
  });
});
