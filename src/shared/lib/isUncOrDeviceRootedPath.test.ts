import { describe, expect, it } from "vitest";

import { isUncOrDeviceRootedPath } from "./isUncOrDeviceRootedPath";

describe("isUncOrDeviceRootedPath", () => {
  it.each([
    // A server and a share, in every separator spelling Win32 accepts.
    ["\\\\192.0.2.10\\share\\a.png"],
    ["//192.0.2.10/share/a.png"],
    ["/\\192.0.2.10\\share\\a.png"],
    ["\\/192.0.2.10/share/a.png"],
    ["///192.0.2.10/share/a.png"],
    ["\\\\server"],
    ["//"],
    ["  \\\\server\\share\\STATUS.md  "],
    // The separators percent-encoded, as a markdown pipeline leaves them.
    ["%5C%5Cserver%5Cshare%5Ca.png"],
    ["%5c%5cserver%5cshare%5ca.png"],
    ["%2F%2Fserver%2Fshare%2Fa.png"],
    ["/%5Cserver%5Cshare%5Ca.png"],
    // One malformed escape further on must not hide the encoded root.
    ["%5C%5Cserver%5Cshare%5Cbad%ZZ.png"],
    // The device namespaces, which reach a server through `UNC`.
    ["\\\\?\\UNC\\server\\share\\a.png"],
    ["//?/UNC/server/share/a.png"],
    ["\\\\.\\UNC\\server\\share\\a.png"],
    ["\\\\.\\pipe\\example"],
    ["\\\\?\\C:\\Users\\example\\a.png"],
    ["\\??\\UNC\\server\\share\\a.png"],
    ["%5C%3F%3F%5CUNC%5Cserver%5Cshare%5Ca.png"],
    // A `file:` URL with a server in it, or one that converts to such a path.
    ["file://server/share/a.png"],
    ["FILE://SERVER/share/a.png"],
    ["file:////server/share/a.png"],
    ["file:///\\\\server\\share\\a.png"],
    // A `file:` URL the converter refuses names no local path either.
    ["file://server:445/share/a.png"],
    ["file://user@server/share/a.png"],
    ["file:///%5C%5Cserver/share/a.png"],
    ["file:\\\\server\\share\\a.png"],
  ])("refuses %s", (path) => {
    expect(isUncOrDeviceRootedPath(path)).toBe(true);
  });

  it.each([
    ["C:\\Users\\example\\a.png"],
    ["C:/Users/example/a.png"],
    ["c:\\work\\STATUS.md"],
    // Doubled separators after the root are not a server name.
    ["C:\\\\server\\share\\a.png"],
    ["/tmp//server/a.png"],
    ["/tmp/a.png"],
    ["\\tmp\\a.png"],
    ["/?/a.png"],
    // Relative to the session folder.
    ["images/1.jpg"],
    ["./STATUS.md"],
    ["..\\notes\\STATUS.md"],
    ["STATUS.md"],
    ["notes\\\\server\\STATUS.md"],
    ["C:notes\\STATUS.md"],
    // Encoded twice: nothing decodes it twice, so it stays a plain name.
    ["%255C%255Cserver%255Cshare"],
    ["file:///C:/Users/example/a.png"],
    ["file:///tmp/a.png"],
    ["file://localhost/tmp/a.png"],
    ["file:/tmp/a.png"],
    [""],
  ])("lets %s through", (path) => {
    expect(isUncOrDeviceRootedPath(path)).toBe(false);
  });
});
