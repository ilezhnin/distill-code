import { describe, expect, it } from "vitest";
import { collectSettledExports } from "./exportSession";

describe("collectSettledExports", () => {
  it("keeps the readable chats when one export rejects", async () => {
    const { items, failures } = await collectSettledExports(
      ["a", "broken", "c"],
      async (id) => {
        if (id === "broken") throw new Error("session not found");
        return id;
      },
    );

    expect(items).toEqual(["a", "c"]);
    expect(failures).toHaveLength(1);
    expect((failures[0] as Error).message).toBe("session not found");
  });

  it("reports every failure when nothing could be exported", async () => {
    const { items, failures } = await collectSettledExports(
      ["a", "b"],
      async () => {
        throw new Error("host down");
      },
    );

    expect(items).toEqual([]);
    expect(failures).toHaveLength(2);
  });
});
