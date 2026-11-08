/**
 * Tests for the archive check in update-cua-driver-lock.mjs. The script itself
 * downloads a release and is run by hand; reading a zip's entry names is pure
 * and is covered here. Wired into `pnpm test:scripts`.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { zipEntryNames } from "./update-cua-driver-lock.mjs";

/** A zip holding only a central directory and its end record. */
function centralDirectoryOnly(names, comment = "") {
  const records = names.map((name) => {
    const nameBytes = Buffer.from(name, "utf8");
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(nameBytes.length, 28);
    return Buffer.concat([record, nameBytes]);
  });
  const directory = Buffer.concat(records);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(0, 16);
  end.writeUInt16LE(Buffer.byteLength(comment), 20);
  return Buffer.concat([directory, end, Buffer.from(comment)]);
}

describe("zipEntryNames", () => {
  it("lists every entry in the central directory", () => {
    const names = [
      "release/cua-driver.exe",
      "release/LICENSE",
      "release/THIRD_PARTY_NOTICES.md",
    ];
    assert.deepEqual(
      zipEntryNames(centralDirectoryOnly(names, "built by test")),
      names,
    );
  });

  it("refuses bytes that are not a zip", () => {
    assert.throws(() => zipEntryNames(Buffer.from("not a zip")), /not a zip/);
  });

  it("refuses a damaged central directory", () => {
    const archive = centralDirectoryOnly(["a"]);
    archive.writeUInt32LE(0, 0);
    assert.throws(() => zipEntryNames(archive), /damaged/);
  });
});
