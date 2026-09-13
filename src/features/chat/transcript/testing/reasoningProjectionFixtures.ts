import type {
  Message,
  MessageContent,
  ToolRequestContent,
  ToolResponseContent,
} from "@/shared/types/messages";
import type {
  TranscriptItemDescriptor,
  TranscriptProjectionSnapshot,
} from "../projection/transcriptItemTypes";

/**
 * Deterministic transcripts for the reasoning de-duplication projection.
 *
 * The projection collapses repeated reasoning bodies and drops thoughts a
 * provider re-emits; the transcript engine has no other unit coverage for the
 * shapes below, so the fixture is projected once and compared field by field
 * against `reasoningProjectionFixture.expected.json`.
 */

const FIXTURE_BASE_TIME = Date.UTC(2026, 5, 4, 10, 0, 0);

const SENTENCES = [
  "I need to resolve conflicts by including both the HEAD new tests and our own.",
  "I should remove any markers that are causing confusion before editing.",
  "Maybe I'll use Python to replace the conflict block with both halves.",
  "It's important to be precise about the changes I make in this file.",
  "It sounds straightforward, but I want to ensure nothing gets overlooked!",
  "The URL crate can adjust query pairs safely without a secret in scope.",
  "Let me compare the current branch status before deleting anything here.",
  "A destructive command needs a dry run first so I can inspect its effect.",
];

function sentence(index: number): string {
  return SENTENCES[index % SENTENCES.length] ?? "";
}

/** A paragraph of `lineCount` sentence-lines, distinct per `seed`. */
function paragraph(seed: number, lineCount: number): string {
  return Array.from(
    { length: lineCount },
    (_, line) => `${sentence(seed + line)} (p${seed} l${line})`,
  ).join("\n");
}

/** `paragraphCount` blank-line separated paragraphs. */
function paragraphs(
  seed: number,
  paragraphCount: number,
  linesPerParagraph = 3,
): string {
  return Array.from({ length: paragraphCount }, (_, index) =>
    paragraph(seed * 100 + index, linesPerParagraph),
  ).join("\n\n");
}

function thinking(text: string): MessageContent {
  return { type: "thinking", text };
}

function reasoning(text: string): MessageContent {
  return { type: "reasoning", text };
}

function text(value: string): MessageContent {
  return { type: "text", text: value };
}

function toolRequest(id: string, status = "completed"): ToolRequestContent {
  return {
    type: "toolRequest",
    id,
    name: "read_file",
    toolName: "read_file",
    arguments: { path: `/repo/${id}.ts` },
    status: status as ToolRequestContent["status"],
    toolKind: "read",
    locations: [],
  };
}

function toolResponse(id: string): ToolResponseContent {
  return {
    type: "toolResponse",
    id,
    name: "read_file",
    result: `contents of ${id}`,
    isError: false,
  };
}

let fixtureClock = 0;

function nextCreated(): number {
  fixtureClock += 1;
  return FIXTURE_BASE_TIME + fixtureClock * 1_000;
}

function assistant(id: string, content: MessageContent[]): Message {
  return {
    id,
    role: "assistant",
    created: nextCreated(),
    content,
    metadata: { userVisible: true, completionStatus: "completed" },
  };
}

function user(id: string, content: MessageContent[]): Message {
  return {
    id,
    role: "user",
    created: nextCreated(),
    content,
    metadata: { userVisible: true },
  };
}

/**
 * Every duplicated-reasoning shape the projection is expected to handle: exact
 * repeats, glued titles, repeated headers, whitespace-only differences, bodies
 * repeated more than twice, titles with regex metacharacters, hash headings,
 * sections, and cross-message re-emission through tool responses.
 */
export function buildDuplicatedReasoningFixture(): Message[] {
  fixtureClock = 0;
  // Every message gets its own body so cross-message de-duplication only
  // fires where the fixture intends it to.
  const bodies = Array.from({ length: 20 }, (_, index) =>
    paragraphs(index + 1, 2),
  );
  const bodyAt = (index: number): string => bodies[index] ?? "";
  const title = "Resolving conflicts in tests";
  const regexTitle = "Fixing (tests) [v2] a+b*c?";
  const messages: Message[] = [];

  messages.push(user("u-1", [text("please fix the conflicts")]));

  // Titled body repeated twice after a blank line.
  messages.push(
    assistant("a-titled-repeat", [
      thinking(`**${title}**\n\n${bodyAt(0)}\n\n${bodyAt(0)}`),
      toolRequest("t-1"),
    ]),
  );
  messages.push(user("tr-1", [toolResponse("t-1")]));

  // Glued title at the boundary, then the same thought re-emitted standalone.
  messages.push(
    assistant("a-glued-title", [
      thinking(`**${title}**\n\n${bodyAt(1)}${title}\n\n${bodyAt(1)}`),
      thinking(bodyAt(1)),
      toolRequest("t-2"),
    ]),
  );
  messages.push(user("tr-2", [toolResponse("t-2")]));

  // Untitled body repeated twice, separated by a CRLF blank line with spaces.
  messages.push(
    assistant("a-untitled-repeat", [
      thinking(`${bodyAt(2)}\r\n \r\n${bodyAt(2)}`),
      toolRequest("t-3"),
    ]),
  );
  messages.push(user("tr-3", [toolResponse("t-3")]));

  // Repeated three times: no even split, so nothing collapses.
  messages.push(
    assistant("a-triple", [
      thinking(`${bodyAt(3)}\n\n${bodyAt(3)}\n\n${bodyAt(3)}`),
      toolRequest("t-4"),
    ]),
  );
  messages.push(user("tr-4", [toolResponse("t-4")]));

  // Repeated four times collapses to two copies; the following single copy
  // and double copy are compared against that displayed block's signature.
  messages.push(
    assistant("a-quadruple", [
      thinking(
        `**${title}**\n\n${bodyAt(4)}\n\n${bodyAt(4)}\n\n${bodyAt(4)}\n\n${bodyAt(4)}`,
      ),
      toolRequest("t-5"),
      thinking(`**${title}**\n\n${bodyAt(4)}`),
      toolRequest("t-6"),
      thinking(`**${title}**\n\n${bodyAt(4)}\n\n${bodyAt(4)}`),
      toolRequest("t-7"),
    ]),
  );
  messages.push(user("tr-5", [toolResponse("t-5"), toolResponse("t-6")]));

  // Second copy re-wrapped: canonical text is equal, raw text is not.
  const rewrapped = bodyAt(5).replace(/\n/g, " \n\t ").replace(/ {2}/g, "   ");
  messages.push(
    assistant("a-rewrapped", [
      thinking(`${bodyAt(5)}\n\n\n${rewrapped}`),
      toolRequest("t-8"),
    ]),
  );
  messages.push(user("tr-8", [toolResponse("t-8")]));

  // The right half starts with its own bold header.
  messages.push(
    assistant("a-repeated-header", [
      thinking(`**${title}**\n\n${bodyAt(6)}\n\n**${title}**\n\n${bodyAt(6)}`),
      toolRequest("t-9"),
    ]),
  );
  messages.push(user("tr-9", [toolResponse("t-9")]));

  // Hash heading form, and a heading repeated inside the body.
  messages.push(
    assistant("a-hash-heading", [
      reasoning(`## ${title}\n\n${bodyAt(7)}\n\n## ${title}\n\n${bodyAt(7)}`),
      reasoning(`# ${regexTitle}\n\n${bodyAt(8)}\n\n${bodyAt(8)}`),
      toolRequest("t-10"),
    ]),
  );
  messages.push(user("tr-10", [toolResponse("t-10")]));

  // Titles with regex metacharacters, glued at both boundaries.
  messages.push(
    assistant("a-regex-title", [
      thinking(
        `**${regexTitle}**\n\n${regexTitle}${bodyAt(9)}\n\n${bodyAt(9)}${regexTitle}`,
      ),
      toolRequest("t-11"),
    ]),
  );
  messages.push(user("tr-11", [toolResponse("t-11")]));

  // Title occurrences mid-text that are not duplicates.
  messages.push(
    assistant("a-mid-title", [
      thinking(
        `**${title}**\n\n${paragraph(31, 2)} ${title} ${paragraph(32, 2)}\n\n${paragraph(33, 3)}`,
      ),
      toolRequest("t-12"),
    ]),
  );
  messages.push(user("tr-12", [toolResponse("t-12")]));

  // Multi-section block with one section repeated later, then re-emitted as a
  // standalone section on the next message.
  const sectionA = `**Inspecting code issues**\n\n${paragraph(41, 3)}`;
  const sectionB = `**Refining URL handling**\n\n${paragraph(42, 3)}`;
  messages.push(
    assistant("a-sections", [
      thinking(`${sectionA}\n${sectionB}\n${sectionA}`),
      toolRequest("t-13"),
      thinking(sectionB),
      toolRequest("t-14"),
    ]),
  );
  messages.push(user("tr-13", [toolResponse("t-13"), toolResponse("t-14")]));
  messages.push(
    assistant("a-section-reemitted", [
      thinking(sectionB),
      toolRequest("t-15"),
      text("Done with the sections."),
    ]),
  );

  // Cross-message re-emission: the leading thought repeats the previous turn's
  // displayed thought, through a tool response, and is dropped.
  const leading = `**Planning**\n\n${paragraph(51, 4)}`;
  messages.push(
    assistant("a-leading-1", [thinking(leading), toolRequest("t-16")]),
  );
  messages.push(user("tr-16", [toolResponse("t-16")]));
  messages.push(
    assistant("a-leading-2", [
      thinking(leading),
      thinking(`**Next**\n\n${paragraph(52, 4)}`),
      toolRequest("t-17"),
    ]),
  );
  messages.push(user("tr-17", [toolResponse("t-17")]));
  // A message that is nothing but the duplicate collapses away entirely.
  messages.push(assistant("a-leading-only", [thinking(leading)]));
  // A user prompt resets the displayed set, so the same thought shows again.
  messages.push(user("u-2", [text("continue")]));
  messages.push(
    assistant("a-leading-3", [
      thinking(leading),
      toolRequest("t-18"),
      text("Final answer after the plan."),
    ]),
  );

  // Short bodies below the duplicate threshold never collapse.
  messages.push(
    assistant("a-short", [
      thinking("**Tiny**\n\nshort thought\n\nshort thought"),
      thinking("short thought\n\nshort thought"),
      toolRequest("t-19"),
    ]),
  );
  messages.push(user("tr-19", [toolResponse("t-19")]));

  // Unicode whitespace around the split and a redacted block in the run.
  messages.push(
    assistant("a-unicode-ws", [
      thinking(`${bodyAt(10)} \n \n ${bodyAt(10)}\u3000`),
      { type: "redactedThinking" },
      thinking(`${bodyAt(11)}\n\n${bodyAt(11)}`),
      toolRequest("t-20"),
    ]),
  );
  messages.push(user("tr-20", [toolResponse("t-20")]));

  // Whole body equals the title twice (title-only halves are not bodies), and
  // a body where the title sits between and after the copies.
  messages.push(
    assistant("a-title-only", [
      thinking(`**${title}**\n\n${title}\n\n${title}`),
      thinking(
        `**${title}**\n\n${bodyAt(12)}\n\n${title}\n\n${bodyAt(12)}\n\n${title}`,
      ),
      toolRequest("t-21"),
    ]),
  );
  messages.push(user("tr-21", [toolResponse("t-21")]));

  // Uneven paragraph counts on each side of the true split, and a near-miss
  // where the second copy differs by one character.
  messages.push(
    assistant("a-uneven", [
      thinking(
        `**${title}**\n\n${paragraph(71, 1)}\n\n${paragraph(72, 3)}\n\n${paragraph(71, 1)}\n\n${paragraph(72, 3)}`,
      ),
      thinking(`${bodyAt(13)}\n\n${bodyAt(13)}x`),
      thinking(`${bodyAt(14)}\n\n${bodyAt(14).slice(0, -1)}`),
      toolRequest("t-24"),
    ]),
  );
  messages.push(user("tr-24", [toolResponse("t-24")]));

  // Trailing reasoning after the final answer, with the answer text repeated
  // in the thought (text blocks are never de-duplicated).
  messages.push(
    assistant("a-trailing", [
      thinking(`**Summary**\n\n${paragraph(61, 4)}`),
      toolRequest("t-22"),
      text(`Answer: ${sentence(1)}`),
      thinking(`**Summary**\n\n${paragraph(61, 4)}`),
      thinking(`**Later**\n\n${paragraph(62, 2)}\n\n${paragraph(62, 2)}`),
    ]),
  );

  // A streaming turn keeps its trailing reasoning inside active work.
  messages.push(user("u-3", [text("and now?")]));
  messages.push({
    id: "a-streaming",
    role: "assistant",
    created: nextCreated(),
    content: [
      thinking(`**${title}**\n\n${bodyAt(15)}\n\n${bodyAt(15)}`),
      toolRequest("t-23", "in_progress"),
      thinking(`${bodyAt(16)}\n\n${bodyAt(16)}`),
      text("partial ans"),
    ],
    metadata: { userVisible: true, completionStatus: "inProgress" },
  });

  return messages;
}

export const DUPLICATED_REASONING_FIXTURE_STREAMING_ID = "a-streaming";

export interface SyntheticReasoningTranscriptOptions {
  turns: number;
  paragraphsPerThought: number;
  linesPerParagraph?: number;
}

/**
 * The audit's benchmark shape: user/assistant pairs where every assistant turn
 * is one titled thinking block of `paragraphsPerThought` paragraphs, one tool
 * call, its response, and a short answer. Half the thoughts repeat their body
 * once so the de-duplication path is exercised on every turn.
 */
export function buildSyntheticReasoningTranscript({
  turns,
  paragraphsPerThought,
  linesPerParagraph = 2,
}: SyntheticReasoningTranscriptOptions): Message[] {
  fixtureClock = 0;
  const messages: Message[] = [];
  for (let turn = 0; turn < turns; turn += 1) {
    messages.push(user(`u-${turn}`, [text(`question ${turn}`)]));
    const thoughtBody = paragraphs(
      turn + 1,
      paragraphsPerThought,
      linesPerParagraph,
    );
    const thoughtText =
      turn % 2 === 0
        ? `**Thinking about step ${turn}**\n\n${thoughtBody}`
        : `**Thinking about step ${turn}**\n\n${thoughtBody}\n\n${thoughtBody}`;
    messages.push(
      assistant(`a-${turn}`, [
        thinking(thoughtText),
        toolRequest(`tool-${turn}`),
      ]),
    );
    messages.push(user(`tr-${turn}`, [toolResponse(`tool-${turn}`)]));
    messages.push(
      assistant(`a-${turn}-answer`, [
        thinking(thoughtText),
        text(`answer ${turn}: ${sentence(turn)}`),
      ]),
    );
  }
  return messages;
}

export const SYNTHETIC_STREAMING_MESSAGE_ID = "a-streaming";

/** A streaming assistant turn whose thought grows by one line per frame. */
export function buildStreamingTurn(frame: number): Message {
  const lines = Array.from(
    { length: 4 + frame },
    (_, index) => `${sentence(index)} (stream l${index})`,
  );
  const chunks: string[] = [];
  for (let index = 0; index < lines.length; index += 3) {
    chunks.push(lines.slice(index, index + 3).join("\n"));
  }
  return {
    id: SYNTHETIC_STREAMING_MESSAGE_ID,
    role: "assistant",
    created: FIXTURE_BASE_TIME + 10_000_000,
    content: [
      thinking(`**Streaming thought**\n\n${chunks.join("\n\n")}`),
      toolRequest("tool-streaming", "in_progress"),
    ],
    metadata: { userVisible: true, completionStatus: "inProgress" },
  };
}

/**
 * The parts of a projected item that carry its rendered meaning, in a plain
 * JSON shape that survives a snapshot file.
 */
export type ProjectedItemDigest = Record<string, unknown>;

function digestContent(content: readonly MessageContent[]): unknown[] {
  return content.map((block) => {
    switch (block.type) {
      case "text":
      case "thinking":
      case "reasoning":
        return { type: block.type, text: block.text };
      case "toolRequest":
        return { type: block.type, id: block.id, status: block.status };
      case "toolResponse":
        return { type: block.type, id: block.id };
      default:
        return { type: block.type };
    }
  });
}

export function digestProjectedItem(
  item: TranscriptItemDescriptor,
): ProjectedItemDigest {
  const identity = {
    itemId: item.itemId,
    kind: item.kind,
    rowId: item.rowId,
    renderRevision: item.renderRevision,
    heightRevision: item.heightRevision,
    estimatedHeight: item.estimatedHeight,
  };
  if (item.kind === "date-separator") {
    return { ...identity, payload: { ...item.payload } };
  }
  const base = {
    ...identity,
    anchorPriority: item.anchorPriority,
    measurementPolicy: item.measurementPolicy,
    layoutPendingPolicy: item.layoutPendingPolicy,
    keepAlivePriority: item.keepAlivePriority,
    measurementSafetyReasons: [...item.measurementSafetyReasons],
    capabilities: { ...item.capabilities },
  };
  switch (item.kind) {
    case "message":
      return {
        ...base,
        messageId: item.messageId,
        syntheticMessageId: item.message.id,
        responseStartMessageId: item.responseStartMessageId ?? null,
        blockIds: [...item.blockIds],
        searchableText: item.searchableText,
        isStreaming: item.isStreaming,
        visibleContent: digestContent(item.visibleContent),
        messageContent: digestContent(item.message.content),
      };
    case "assistant-content-fragment":
      return {
        ...base,
        messageId: item.messageId,
        blockIds: [...item.blockIds],
        searchableText: item.searchableText,
        fragment: {
          ...item.fragment,
          content: digestContent(item.fragment.content),
        },
      };
    case "agent-work":
      return {
        ...base,
        messageId: item.messageId,
        workMessageId: item.message.id,
        workId: item.workId,
        isActiveWork: item.isActiveWork,
        hasFinalAnswer: item.hasFinalAnswer,
        hostsTurnFooters: item.hostsTurnFooters,
        thoughtCount: item.thoughtCount,
        toolCount: item.toolCount,
        textCount: item.textCount,
        hasSubagentLinkage: item.subagentLinkage !== undefined,
        content: digestContent(item.content),
      };
    default:
      return assertNever(item);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled transcript item: ${JSON.stringify(value)}`);
}

export function digestProjection(
  snapshot: TranscriptProjectionSnapshot,
): ProjectedItemDigest[] {
  return snapshot.items.map(digestProjectedItem);
}

/** FNV-1a over the JSON form, for fixtures too large to store readably. */
export function digestHash(digests: readonly ProjectedItemDigest[]): string {
  const serialized = JSON.stringify(digests);
  let hash = 0x811c9dc5;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${hash.toString(16).padStart(8, "0")}:${serialized.length}`;
}
