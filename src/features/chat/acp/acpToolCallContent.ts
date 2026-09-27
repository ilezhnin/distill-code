import {
  getReplayBuffer,
  type getBufferedMessage,
} from "@/features/chat/hooks/replayBuffer";
import { readImageAttachment } from "@/shared/api/system";
import type { ImageContent } from "@/shared/types/messages";
import { isRecord } from "@/shared/lib/isRecord";
import {
  fileUrlToPath,
  isFileUrl,
  toIdentityKey,
} from "@/shared/lib/pathIdentity";

const IMAGE_PATH_EXTENSION_RE = /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i;

/** File references gain bytes before they enter the transcript. */
type ToolResultImage = Omit<ImageContent, "data"> & { data?: string };

export function findReplayMessageWithToolCall(
  sessionId: string,
  toolCallId: string,
): ReturnType<typeof getBufferedMessage> {
  const buffer = getReplayBuffer(sessionId);
  if (!buffer) {
    return undefined;
  }
  for (let index = buffer.length - 1; index >= 0; index -= 1) {
    const message = buffer[index];
    if (
      message.content.some(
        (content) =>
          content.type === "toolRequest" && content.id === toolCallId,
      )
    ) {
      return message;
    }
  }
  return undefined;
}

export function extractToolResultText(update: {
  // biome-ignore lint/suspicious/noExplicitAny: ACP SDK ToolCallContent type is complex
  content?: Array<any> | null;
  rawOutput?: unknown;
}): string {
  if (update.content && update.content.length > 0) {
    const texts: string[] = [];
    for (const item of update.content) {
      if (item.type === "content" && item.content?.type === "text") {
        texts.push(item.content.text);
      }
    }
    if (texts.length) return texts.join("\n");
  }
  if (update.rawOutput !== undefined && update.rawOutput !== null) {
    return typeof update.rawOutput === "string"
      ? update.rawOutput
      : JSON.stringify(update.rawOutput);
  }
  return "";
}

function mimeTypeFromImagePath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "bmp":
      return "image/bmp";
    case "svg":
      return "image/svg+xml";
    case "avif":
      return "image/avif";
    default:
      return "image/png";
  }
}

function isAbsoluteLocalPath(path: string): boolean {
  if (/^[A-Za-z]:[\\/]/.test(path)) return true;
  return path.startsWith("/") && !path.startsWith("//");
}

function imagePathFromUnknown(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (IMAGE_PATH_EXTENSION_RE.test(trimmed) && isAbsoluteLocalPath(trimmed)) {
      return trimmed;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  const path = typeof value.path === "string" ? value.path.trim() : "";
  if (
    path.length > 0 &&
    IMAGE_PATH_EXTENSION_RE.test(path) &&
    isAbsoluteLocalPath(path)
  ) {
    return path;
  }
  return null;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function localPathFromImage(image: Pick<ImageContent, "uri">): string | null {
  const uri = typeof image.uri === "string" ? image.uri.trim() : "";
  if (!uri) return null;
  if (isFileUrl(uri)) return fileUrlToPath(uri);
  if (isAbsoluteLocalPath(uri) && IMAGE_PATH_EXTENSION_RE.test(uri)) {
    return uri;
  }
  return null;
}

/**
 * ACP image blocks plus image files named by the tool (Grok `image_gen`
 * returns JSON `{ path, filename }` in `rawOutput` / text, not an image
 * ContentBlock). Relative and UNC paths are ignored.
 */
export function extractToolResultImages(update: {
  // biome-ignore lint/suspicious/noExplicitAny: ACP SDK ToolCallContent type is complex
  content?: Array<any> | null;
  rawOutput?: unknown;
}): ToolResultImage[] {
  const images: ToolResultImage[] = [];
  const seenPaths = new Set<string>();

  const addPath = (path: string | null) => {
    if (!path) return;
    const key = toIdentityKey(path);
    if (seenPaths.has(key)) return;
    seenPaths.add(key);
    images.push({
      type: "image",
      mimeType: mimeTypeFromImagePath(path),
      uri: path,
    });
  };

  if (update.content && update.content.length > 0) {
    for (const item of update.content) {
      // ACP tool results wrap each block as { type: "content", content: <ContentBlock> }.
      // An image-producing MCP (e.g. imagegenerator) emits an image ContentBlock here;
      // pull it out so it renders inline instead of being dropped (text-only before).
      if (item?.type === "content" && item.content?.type === "image") {
        const { data, mimeType, uri, annotations } = item.content;
        images.push({
          type: "image",
          data,
          mimeType,
          ...(uri !== undefined ? { uri } : {}),
          ...(annotations !== undefined ? { annotations } : {}),
        });
        const fromBlock =
          localPathFromImage({ uri }) ??
          imagePathFromUnknown(typeof uri === "string" ? uri : null);
        if (fromBlock) seenPaths.add(toIdentityKey(fromBlock));
        continue;
      }
      if (item?.type === "content" && item.content?.type === "text") {
        addPath(imagePathFromUnknown(parseJsonObject(item.content.text ?? "")));
      }
    }
  }

  addPath(imagePathFromUnknown(update.rawOutput));
  return images;
}

/**
 * Inline bytes for any extracted image that only has a local path/`file:` URI
 * so the transcript can render it. Distill's webview cannot load raw `file:`
 * URIs, and tool-written files often sit outside the chat cwd.
 */
export async function hydrateToolResultImages(
  images: ToolResultImage[],
): Promise<ImageContent[]> {
  const hydrated: ImageContent[] = [];
  for (const image of images) {
    if (typeof image.data === "string" && image.data.length > 0) {
      hydrated.push({ ...image, data: image.data });
      continue;
    }
    const path = localPathFromImage(image);
    if (!path) continue;
    try {
      const payload = await readImageAttachment(path);
      if (!payload.base64) continue;
      hydrated.push({
        ...image,
        data: payload.base64,
        mimeType:
          payload.mimeType.length > 0 ? payload.mimeType : image.mimeType,
      });
    } catch {
      // The tool named a file we cannot read; skip rather than leave a
      // broken inline image in the transcript.
    }
  }
  return hydrated;
}

export async function loadToolResultImages(update: {
  // biome-ignore lint/suspicious/noExplicitAny: ACP SDK ToolCallContent type is complex
  content?: Array<any> | null;
  rawOutput?: unknown;
}): Promise<ImageContent[]> {
  return hydrateToolResultImages(extractToolResultImages(update));
}

export function extractToolStructuredContent(update: {
  rawOutput?: unknown;
  _meta?: Record<string, unknown> | null;
}): unknown | undefined {
  if (Object.hasOwn(update, "rawOutput")) {
    return update.rawOutput;
  }

  const exit = update._meta?.terminal_exit;
  if (isRecord(exit)) return { ...exit };

  return undefined;
}
