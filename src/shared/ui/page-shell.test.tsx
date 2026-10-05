import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SettingsPane } from "./SettingsPage";
import {
  PAGE_GUTTER_CLASS,
  PAGE_SCROLL_CLASS,
  PANEL_PAGE_GUTTER_CLASS,
  PageShell,
} from "./page-shell";
import { SettingsRow } from "./settings-row";

const CONTENT_WIDTHS = [undefined, "narrow", "default", "full"] as const;

const READING_WIDTH = {
  narrow: "max-w-3xl",
  default: "max-w-5xl",
  full: "max-w-none",
} as const;

function classesOf(element: Element | null) {
  expect(element).not.toBeNull();
  return (element?.getAttribute("class") ?? "").split(/\s+/);
}

// The page gutter is one distance on every page: whatever reading width a page
// asks for, the content starts on the gutter and is never re-centered.
describe("PageShell page gutter", () => {
  it.each(
    CONTENT_WIDTHS,
  )("keeps contentWidth=%s on the page gutter", (contentWidth) => {
    render(
      <PageShell contentWidth={contentWidth}>
        <p>Page body</p>
      </PageShell>,
    );

    const column = screen.getByText("Page body").parentElement;
    const frame = column?.parentElement ?? null;
    const scroller = frame?.parentElement ?? null;
    const frameClasses = classesOf(frame);
    const columnClasses = classesOf(column);

    expect(frame).toHaveAttribute("data-page-gutter");
    for (const gutterClass of PAGE_GUTTER_CLASS.split(" ")) {
      expect(frameClasses).toContain(gutterClass);
    }
    // No own inline padding, no centering, no width cap on the frame.
    expect(
      frameClasses.filter(
        (name) =>
          name === "mx-auto" ||
          name.startsWith("max-w-") ||
          /^px-\d/.test(name),
      ),
    ).toEqual([]);

    // The reading width caps the column only, and the column is not
    // centered inside the gutters.
    expect(columnClasses).toContain(READING_WIDTH[contentWidth ?? "default"]);
    expect(columnClasses).not.toContain("mx-auto");

    // The trailing gutter gives back a scrollbar track the scroller
    // always reserves.
    for (const scrollClass of PAGE_SCROLL_CLASS.split(" ")) {
      expect(classesOf(scroller)).toContain(scrollClass);
    }
  });

  it("puts Settings content on the page gutter line inside its card", () => {
    render(
      <SettingsPane>
        <p>Settings body</p>
      </SettingsPane>,
    );

    const content = screen.getByText("Settings body").parentElement;
    const contentClasses = classesOf(content);
    for (const gutterClass of PANEL_PAGE_GUTTER_CLASS.split(" ")) {
      expect(contentClasses).toContain(gutterClass);
    }
    expect(contentClasses).not.toContain("mx-auto");
    expect(contentClasses.some((name) => name.startsWith("max-w-"))).toBe(
      false,
    );
  });
});

describe("settings rows on the page gutters", () => {
  it.each([
    "default",
    "compact",
  ] as const)("gives a %s settings row no inline padding of its own", (density) => {
    render(
      <SettingsRow
        label="Theme"
        density={density}
        action={<span>Control</span>}
      />,
    );

    const row = screen.getByText("Theme").closest("[data-slot=settings-row]");
    expect(
      classesOf(row).filter((name) => /^(p[xlr]|m[xlr])-/.test(name)),
    ).toEqual([]);
  });
});

describe("page gutter token", () => {
  const css = readFileSync(
    resolve(process.cwd(), "src/shared/styles/globals.css"),
    "utf8",
  );

  it("steps 24px, 48px from 1024px and 72px from 1280px", () => {
    // One unconditional declaration:
    // clamp(min, round(down, <slope>vw - <offset>rem, <step>rem), max).
    const match = css.match(
      /--app-page-gutter: clamp\(([\d.]+)rem, round\(down, ([\d.]+)vw - ([\d.]+)rem, ([\d.]+)rem\), ([\d.]+)rem\);/,
    );
    expect(match).not.toBeNull();
    const [min, slope, offset, step, max] = (match ?? [])
      .slice(1)
      .map((value) => Number(value));
    // Evaluate it the way CSS does, with 1rem = 16px.
    const gutterAt = (windowWidth: number) =>
      Math.min(
        max * 16,
        Math.max(
          min * 16,
          Math.floor(
            ((slope / 100) * windowWidth - offset * 16) / (step * 16),
          ) *
            step *
            16,
        ),
      );

    expect(
      [700, 900, 1023, 1024, 1279, 1280, 1425, 2560].map(gutterAt),
    ).toEqual([24, 24, 24, 48, 48, 72, 72, 72]);
  });

  it("exposes the gutter utilities PageShell and the panels use", () => {
    for (const token of [
      "--spacing-app-page-gutter:",
      "--spacing-app-page-gutter-end:",
      "--spacing-app-panel-page-gutter:",
      "--spacing-app-panel-page-gutter-end:",
    ]) {
      expect(css).toContain(token);
    }
  });
});
