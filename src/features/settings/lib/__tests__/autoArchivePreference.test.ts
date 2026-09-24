import { afterEach, describe, expect, it } from "vitest";
import {
  AUTO_ARCHIVE_CONSENT_STORAGE_KEY,
  AUTO_ARCHIVE_STORAGE_KEY,
  getAutoArchiveAfter,
} from "../autoArchivePreference";

describe("auto archive preference", () => {
  afterEach(() => {
    localStorage.clear();
  });

  it("defaults to never and rejects unconfirmed or invalid persisted values", () => {
    expect(getAutoArchiveAfter()).toBe("never");

    localStorage.setItem(AUTO_ARCHIVE_STORAGE_KEY, "14-days");
    expect(getAutoArchiveAfter()).toBe("never");

    localStorage.setItem(AUTO_ARCHIVE_CONSENT_STORAGE_KEY, "true");
    localStorage.setItem(AUTO_ARCHIVE_STORAGE_KEY, "tomorrow-ish");
    expect(getAutoArchiveAfter()).toBe("never");
  });
});
