/**
 * What a resumed wave step is handed from the session the app restart ended.
 *
 * A step whose executor died with the process used to come back as a fresh
 * session reading the original brief, whose premises — an editor it had
 * opened, a lock it held, a cache it had half built — were already stale, and
 * the operator steered it by hand. This module reads what the dead session
 * last said, and the status file it named if there was one, so the new
 * executor starts from where the old one stopped rather than from the plan.
 *
 * Everything here is best effort and never throws: a resume with nothing
 * attached is still a resume, said as such in the operator's notice.
 */

import { lastSessionMessages } from "@/shared/api/sessionSearch";
import { readTextFile } from "@/shared/api/system";

/** Cap on the previous session's last message, as quoted into the brief. */
export const MAX_RESUME_MESSAGE_CHARS = 6_000;

/** Cap on a status file's contents, as quoted into the brief. */
export const MAX_RESUME_STATUS_CHARS = 8_000;

/** How many of the previous session's messages are read to find its last words. */
const RESUME_MESSAGE_WINDOW = 8;

/** A path ending in STATUS.md, as a worker would write it in prose. */
const STATUS_FILE_PATTERN = /[^\s"'`()[\]<>,;]*STATUS\.md/i;

export interface WaveResumeContext {
  /** The previous executor's last assistant message, trimmed and capped. */
  lastMessage?: string;
  /** The status file that message named, when it named one that could be read. */
  statusFile?: { path: string; contents: string };
}

/** Test seam: the two reads this module makes. */
export interface WaveResumeIo {
  lastMessages: (
    sessionId: string,
    limit: number,
  ) => Promise<Array<{ role: string | null; text: string }>>;
  readText: (path: string) => Promise<string>;
}

const liveIo: WaveResumeIo = {
  lastMessages: (sessionId, limit) => lastSessionMessages(sessionId, limit),
  readText: async (path) => (await readTextFile(path)).contents,
};

let io: WaveResumeIo = liveIo;

export function setWaveResumeIoForTests(next: Partial<WaveResumeIo>): void {
  io = { ...liveIo, ...next };
}

export function resetWaveResumeIoForTests(): void {
  io = liveIo;
}

function cap(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length > limit
    ? `${trimmed.slice(0, limit)}\n[…truncated by the app]`
    : trimmed;
}

function isAbsolutePath(path: string): boolean {
  return (
    /^[A-Za-z]:[\\/]/.test(path) ||
    path.startsWith("/") ||
    path.startsWith("\\\\")
  );
}

/** The status file path a message names, resolved against the working folder. */
export function statusFilePathIn(
  text: string,
  workingDir: string | undefined,
): string | undefined {
  const match = STATUS_FILE_PATTERN.exec(text);
  if (!match) return undefined;
  const named = match[0].replace(/^[.\s]+(?=[^.])/, (prefix) =>
    prefix.trim().replace(/^\.(?=[\\/])/, "."),
  );
  if (isAbsolutePath(named)) return named;
  if (!workingDir) return undefined;
  const separator = workingDir.includes("\\") ? "\\" : "/";
  const relative = named.replace(/^\.[\\/]/, "");
  return `${workingDir.replace(/[\\/]+$/, "")}${separator}${relative}`;
}

/**
 * Reads what the previous executor left behind. Never throws; a read that
 * fails leaves its field absent.
 */
export async function loadWaveResumeContext(args: {
  previousSessionId: string;
  workingDir?: string;
}): Promise<WaveResumeContext> {
  const context: WaveResumeContext = {};
  let messages: Array<{ role: string | null; text: string }> = [];
  try {
    messages = await io.lastMessages(
      args.previousSessionId,
      RESUME_MESSAGE_WINDOW,
    );
  } catch {
    return context;
  }
  const last = [...messages]
    .reverse()
    .find((message) => message.role === "assistant" && message.text.trim());
  if (!last) return context;
  context.lastMessage = cap(last.text, MAX_RESUME_MESSAGE_CHARS);
  const statusPath = statusFilePathIn(last.text, args.workingDir);
  if (!statusPath) return context;
  try {
    const contents = await io.readText(statusPath);
    if (contents.trim()) {
      context.statusFile = {
        path: statusPath,
        contents: cap(contents, MAX_RESUME_STATUS_CHARS),
      };
    }
  } catch {
    // The file is named but not readable from here; the message still says
    // where it is, and the new executor can open it itself.
  }
  return context;
}
