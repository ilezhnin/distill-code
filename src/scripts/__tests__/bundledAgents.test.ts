// @vitest-environment node

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("bundled agents", () => {
  it("includes distro in the desktop bundle", () => {
    const config = JSON.parse(
      readFileSync(
        new URL("../../../src-tauri/tauri.conf.json", import.meta.url),
        "utf8",
      ),
    );
    expect(config.bundle.resources["../distro"]).toBe("distro");
  });
});
