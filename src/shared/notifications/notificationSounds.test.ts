import { describe, expect, it } from "vitest";
import {
  DEFAULT_NOTIFICATION_SOUND,
  NOTIFICATION_SOUNDS,
  SILENT_NOTIFICATION_SOUND,
  getNotificationSoundResource,
  isNotificationSoundId,
  normalizeNotificationSoundId,
} from "./notificationSounds";

// The former product name is spelled in two halves so a mechanical rename of
// the product cannot rewrite this expectation together with the alias it
// guards: a sweep that rewrites the legacy prefix in the module must fail here.
const PREVIOUS_SOUND_ID_PREFIX = `${["dis", "till"].join("")}-sounds-`;

describe("notification sound ids", () => {
  it("names every bundled sound after the renamed file", () => {
    for (const sound of NOTIFICATION_SOUNDS) {
      expect(sound.id).toMatch(/^flock-sounds-\d\.mp3$/);
      expect(sound.resource).toBe(sound.id);
      expect(getNotificationSoundResource(sound.id)).toBe(sound.id);
    }
    expect(isNotificationSoundId(DEFAULT_NOTIFICATION_SOUND)).toBe(true);
    expect(getNotificationSoundResource(SILENT_NOTIFICATION_SOUND)).toBe(
      undefined,
    );
  });

  it("keeps current ids and silence as saved", () => {
    expect(normalizeNotificationSoundId(SILENT_NOTIFICATION_SOUND)).toBe(
      SILENT_NOTIFICATION_SOUND,
    );
    for (const sound of NOTIFICATION_SOUNDS) {
      expect(normalizeNotificationSoundId(sound.id)).toBe(sound.id);
    }
  });

  it("reads the sound ids the previous product saved as the renamed files", () => {
    for (const sound of NOTIFICATION_SOUNDS) {
      const number = sound.id.slice("flock-sounds-".length);
      expect(
        normalizeNotificationSoundId(`${PREVIOUS_SOUND_ID_PREFIX}${number}`),
      ).toBe(sound.id);
    }
    expect(
      normalizeNotificationSoundId(`${PREVIOUS_SOUND_ID_PREFIX}0.mp3`),
    ).toBe("flock-sounds-0.mp3");
  });

  it("falls back to the default sound for ids that name no bundled file", () => {
    expect(
      normalizeNotificationSoundId(`${PREVIOUS_SOUND_ID_PREFIX}9.mp3`),
    ).toBe(DEFAULT_NOTIFICATION_SOUND);
    expect(normalizeNotificationSoundId("flock-sounds-9.mp3")).toBe(
      DEFAULT_NOTIFICATION_SOUND,
    );
    expect(normalizeNotificationSoundId("goose-sounds-4.mp3")).toBe(
      DEFAULT_NOTIFICATION_SOUND,
    );
    expect(normalizeNotificationSoundId(undefined)).toBe(
      DEFAULT_NOTIFICATION_SOUND,
    );
    expect(normalizeNotificationSoundId(4)).toBe(DEFAULT_NOTIFICATION_SOUND);
  });
});
