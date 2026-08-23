import { describe, expect, it } from "vitest";
import { clampWidgetSizeForInstance, widgetSizeForInstance } from "./catalog";
import type { WidgetInstance } from "./types";

const baseClock: WidgetInstance = { id: "c1", type: "clock", x: 0, y: 0, z: 1 };

function photoInstance(state: Record<string, unknown>): WidgetInstance {
  return { id: "photo-1", type: "photo", x: 0, y: 0, z: 1, state };
}

describe("photo size profiles", () => {
  // PhotoWidget and its aspect-ratio-aware profile retired with the old Home
  // canvas. The catalog keeps a plain, freely resizable box, so the shape and
  // aspectRatio a stored instance still carries no longer steer its size.
  it("ignores the retired shape and aspect-ratio state", () => {
    expect(
      widgetSizeForInstance(
        photoInstance({ shape: "original", aspectRatio: 2.5 }),
      ),
    ).toEqual({ width: 280, height: 210 });
    expect(
      widgetSizeForInstance(
        photoInstance({ shape: "original", aspectRatio: 0.4 }),
      ),
    ).toEqual({ width: 280, height: 210 });
  });

  it("resizes freely inside its bounds", () => {
    const photo = photoInstance({ shape: "original", aspectRatio: 2.5 });

    expect(
      clampWidgetSizeForInstance(photo, { width: 500, height: 500 }),
    ).toEqual({ width: 500, height: 500 });
    expect(
      clampWidgetSizeForInstance(photo, { width: 999, height: 12 }),
    ).toEqual({ width: 720, height: 168 });
  });
});

describe("onboarding tour size profiles", () => {
  it("shrinks the frame to the avatar after the welcome bubble is dismissed", () => {
    const dismissedTour: WidgetInstance = {
      id: "tour-1",
      type: "onboardingTour",
      x: 0,
      y: 0,
      z: 1,
      width: 448,
      height: 180,
      state: { welcomeDismissed: true },
    };

    expect(widgetSizeForInstance(dismissedTour)).toEqual({
      width: 160,
      height: 160,
    });
  });
});

describe("clock size profiles", () => {
  it("uses the analog (square) profile by default", () => {
    expect(widgetSizeForInstance(baseClock)).toEqual({
      width: 156,
      height: 156,
    });
  });

  it("uses the digital (landscape) profile when mode is digital", () => {
    const digital = { ...baseClock, state: { mode: "digital" } };
    expect(widgetSizeForInstance(digital)).toEqual({
      width: 224,
      height: 88,
    });
  });

  it("clamps a digital resize to digital bounds and aspect ratio", () => {
    const digital = { ...baseClock, state: { mode: "digital" } };
    const clamped = clampWidgetSizeForInstance(digital, {
      width: 999,
      height: 999,
    });
    expect(clamped.width).toBe(396);
    expect(clamped.height).toBeCloseTo(155.57, 2); // 396 * 88/224
  });

  it("clamps an analog resize to the square aspect ratio", () => {
    const clamped = clampWidgetSizeForInstance(baseClock, {
      width: 300,
      height: 999,
    });
    expect(clamped.width).toBe(300);
    expect(clamped.height).toBe(300);
  });
});
