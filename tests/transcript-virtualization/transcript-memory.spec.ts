import { execFileSync } from "node:child_process";
import { expect, test, type CDPSession, type Page } from "@playwright/test";
import {
  buildTranscriptFixture,
  type TranscriptHarnessOperation,
} from "../../src/features/chat/transcript/testing/transcriptFixtures";
import { LOCAL_TRANSCRIPT_RENDERER_URL } from "./harness/localRendererBridge";
import { loadTranscriptRenderer } from "./harness/rendererHarness";

const rendererUrl =
  process.env.TRANSCRIPT_VIRTUALIZATION_RENDERER_URL ??
  LOCAL_TRANSCRIPT_RENDERER_URL;

interface TranscriptHarnessWindow extends Window {
  __TRANSCRIPT_VIRTUALIZATION_HARNESS__?: {
    applyOperation?: (
      operation: TranscriptHarnessOperation,
    ) => void | Promise<void>;
  };
}

interface MemorySnapshot {
  label: string;
  heapUsedMb: number;
  measureCount: number;
  measureDetailMb: number;
  rendererPrivateMb: number | null;
}

// React's dev build used to leave ~37 `performance.measure` entries per chunk
// in the buffer, each with a copy of the streamed text (issue: the WebView2
// renderer of the dev app died of OOM every few hours).
const CHUNK_COUNT = Number(process.env.TRANSCRIPT_MEMORY_CHUNKS ?? 200);
const CHUNK_TEXT =
  "Streaming memory probe sentence with `inline code`, **bold** words and a [link](https://example.com). ";

function toMb(bytes: number) {
  return Math.round((bytes / 2 ** 20) * 10) / 10;
}

async function rendererPrivateMb(page: Page): Promise<number | null> {
  if (process.platform !== "win32") return null;
  const browser = page.context().browser();
  if (!browser) return null;
  const session = await browser.newBrowserCDPSession();
  try {
    const info = (await session.send("SystemInfo.getProcessInfo")) as {
      processInfo: { type: string; id: number }[];
    };
    const ids = info.processInfo
      .filter((process) => process.type === "renderer")
      .map((process) => process.id);
    if (ids.length === 0) return null;
    const output = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `(Get-Process -Id ${ids.join(",")} | Measure-Object PrivateMemorySize64 -Sum).Sum`,
      ],
      { encoding: "utf8" },
    );
    return toMb(Number(output.trim()));
  } finally {
    await session.detach();
  }
}

async function snapshot(
  page: Page,
  cdp: CDPSession,
  label: string,
): Promise<MemorySnapshot> {
  await cdp.send("HeapProfiler.collectGarbage");
  const heap = (await cdp.send("Runtime.getHeapUsage")) as {
    usedSize: number;
  };
  const measures = await page.evaluate(() => {
    const entries = performance.getEntriesByType("measure");
    let detailChars = 0;
    for (const entry of entries) {
      const detail = (entry as PerformanceMeasure).detail;
      if (detail != null) detailChars += JSON.stringify(detail).length;
    }
    return { count: entries.length, detailChars };
  });
  return {
    label,
    heapUsedMb: toMb(heap.usedSize),
    measureCount: measures.count,
    // UTF-16 in the serialized detail: two bytes per character.
    measureDetailMb: toMb(measures.detailChars * 2),
    rendererPrivateMb: await rendererPrivateMb(page),
  };
}

// Set TRANSCRIPT_MEMORY_HEAP_SNAPSHOT to a path prefix to keep heap snapshots
// of both phases for a retainer diff.
async function writeHeapSnapshot(cdp: CDPSession, label: string) {
  const prefix = process.env.TRANSCRIPT_MEMORY_HEAP_SNAPSHOT;
  if (!prefix) return;
  const { createWriteStream } = await import("node:fs");
  const out = createWriteStream(`${prefix}.${label}.heapsnapshot`);
  const onChunk = ({ chunk }: { chunk: string }) => out.write(chunk);
  cdp.on("HeapProfiler.addHeapSnapshotChunk", onChunk);
  await cdp.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
  cdp.off("HeapProfiler.addHeapSnapshotChunk", onChunk);
  await new Promise<void>((resolve) => out.end(resolve));
}

test("streaming keeps renderer memory bounded", async ({ page }, testInfo) => {
  test.setTimeout(600_000);
  const fixture = buildTranscriptFixture("streaming-scrollback-long-markdown");
  const session = fixture.sessions[0];
  const messageId = session.streamingMessageId;
  if (!messageId) throw new Error("fixture has no streaming message");

  await loadTranscriptRenderer(page, {
    fixture,
    rendererMode: "virtual",
    rendererUrl,
  });
  const cdp = await page.context().newCDPSession(page);
  const snapshots: MemorySnapshot[] = [];
  snapshots.push(await snapshot(page, cdp, "loaded"));
  await writeHeapSnapshot(cdp, "loaded");

  const chunks = Array.from(
    { length: CHUNK_COUNT },
    (_, index) =>
      `${CHUNK_TEXT}${index % 12 === 11 ? `\n\n## Section ${index}\n\n` : ""}`,
  );
  const operation: TranscriptHarnessOperation = {
    kind: "appendStreamingText",
    atMs: 0,
    sessionId: session.sessionId,
    messageId,
    chunks,
    chunkIntervalMs: 0,
  };
  await page.evaluate(async (nextOperation) => {
    await (
      window as TranscriptHarnessWindow
    ).__TRANSCRIPT_VIRTUALIZATION_HARNESS__?.applyOperation?.(nextOperation);
  }, operation);
  snapshots.push(await snapshot(page, cdp, "streamed"));
  await writeHeapSnapshot(cdp, "streamed");

  await testInfo.attach("memory.json", {
    body: JSON.stringify(snapshots, null, 2),
    contentType: "application/json",
  });
  console.log(`[transcript-memory] ${JSON.stringify(snapshots)}`);

  const [loaded, streamed] = snapshots;
  expect(streamed.measureCount).toBeLessThan(100);
  // What stays is the rendered message itself: ~40 KB of DOM and fibers per
  // chunk of this rich markdown.
  expect(streamed.heapUsedMb - loaded.heapUsedMb).toBeLessThan(32);
});
