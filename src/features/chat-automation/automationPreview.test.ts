import { expect, it, vi } from "vitest";
import { goalPrompt } from "./commands";
import { loopPrompt } from "./loopCommands";
import { messageSnippet } from "@/features/chat/lib/messageSnippet";
import { getSessionTitleFromDraft } from "@/features/chat/lib/sessionTitle";
import { searchSessionsViaTranscripts } from "@/shared/api/sessionSearch";

const transcript = vi.hoisted(() => vi.fn());
vi.mock("@/shared/api/acpApi", () => ({ readSessionTranscript: transcript }));

it.each([
  ["goal", goalPrompt("Inspect the draft")],
  ["loop", loopPrompt("Inspect the draft", true)],
])("keeps %s protocol out of titles, live and reloaded previews, and search", async (kind, prompt) => {
  const tag = `flock-${kind}-state`;
  const opening = `\`\`\`${tag}`;
  const reply = `All fixed.\n${opening}\n{"note":"two tests left"}\n\`\`\``;
  expect(getSessionTitleFromDraft(prompt)).toBe("Inspect the draft");
  expect(messageSnippet(prompt)).toBe("Inspect the draft");
  expect(messageSnippet(reply)).toBe("All fixed.");
  expect(messageSnippet(reply.replace(/\s+/g, " "))).toBe("All fixed.");
  expect(messageSnippet(reply.slice(0, -8))).toBe("All fixed.");
  expect(messageSnippet(opening)).toBeNull();
  expect(messageSnippet(reply.slice(0, reply.indexOf("-state")))).toBe(
    "All fixed.",
  );
  const instructions = prompt.slice(prompt.indexOf("End your reply"));
  expect(
    getSessionTitleFromDraft(prompt.replace(/\s+/g, " ").slice(0, 80)),
  ).toBe("Inspect the draft");
  transcript.mockResolvedValue({
    messages: [
      { id: "a", role: "user", text: prompt },
      { id: "b", role: "assistant", text: reply },
      {
        id: "c",
        role: "user",
        text: `Prior handoff\n\n${instructions}Public task`,
      },
      { id: "d", role: "user", text: `Prior handoff${prompt}` },
    ],
  });
  const search = async (query: string) =>
    (await searchSessionsViaTranscripts(query, [{ id: "chat", stamp: "1" }]))
      .results;
  expect(await search("Inspect")).toMatchObject([
    { snippet: "Inspect the draft" },
  ]);
  expect(await search("fixed")).toMatchObject([{ snippet: "All fixed." }]);
  expect(await search(tag)).toEqual([]);
  expect(await search("Public task")).toMatchObject([
    { snippet: "Public task" },
  ]);
});
