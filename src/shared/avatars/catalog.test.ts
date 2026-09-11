import { describe, expect, it } from "vitest";
import {
  isAgentAvatarRef,
  isAppAvatarRef,
  isUserAvatarRef,
  parseAvatarRef,
} from "./catalog";

describe("avatar refs", () => {
  it("still recognises persisted app-avatar references by syntax", () => {
    expect(parseAvatarRef(" app-avatar:gloopy-99 ")).toBe("gloopy-99");
    expect(isAppAvatarRef("app-avatar:unknown-but-safe")).toBe(true);
    expect(parseAvatarRef("app-avatar:../gloopy-1")).toBeUndefined();
  });

  it("tells user and agent avatar references apart", () => {
    expect(isUserAvatarRef("user-avatar:gloopie-1")).toBe(true);
    expect(isUserAvatarRef("agent-avatar:scout")).toBe(false);
    expect(isAgentAvatarRef("agent-avatar:scout")).toBe(true);
    expect(isAgentAvatarRef("agent-avatar:../scout")).toBe(false);
  });
});
