import type {
  ChatAttachmentDraft,
  MessageAttachment,
} from "@/shared/types/messages";

/**
 * A non-image attachment reaches the agent as its path in the prompt text.
 *
 * One per line and quoted: the Windows default user folder is
 * `C:\Users\First Last\…`, and space-separated bare paths made the model read
 * `C:\Users\First`, `Last\Documents\spec` and `v2.docx` as three files. A
 * double quote cannot occur in a Windows path, so quoting needs no escaping —
 * and a path that somehow contains one is left as it is rather than rewritten,
 * since its own line already separates it. The transcript still shows
 * `displayText` (without the paths).
 */
export function appendAttachmentPaths(
  text: string,
  attachments: ChatAttachmentDraft[] | undefined,
): string {
  const paths = (attachments ?? [])
    .map((attachment) => attachment.path)
    .filter((path): path is string => Boolean(path));

  if (paths.length === 0) {
    return text;
  }

  const block = paths
    .map((path) => (path.includes('"') ? path : `"${path}"`))
    .join("\n");
  return text ? `${text}\n\n${block}` : block;
}

export function buildMessageAttachments(
  attachments: ChatAttachmentDraft[] | undefined,
): MessageAttachment[] | undefined {
  const messageAttachments: MessageAttachment[] = [];

  for (const attachment of attachments ?? []) {
    if (attachment.kind === "directory") {
      messageAttachments.push({
        type: "directory",
        name: attachment.name,
        path: attachment.path,
      });
      continue;
    }

    messageAttachments.push({
      type: "file",
      name: attachment.name,
      ...(attachment.path ? { path: attachment.path } : {}),
      ...(attachment.kind === "image" || attachment.mimeType
        ? { mimeType: attachment.mimeType }
        : {}),
    });
  }

  return messageAttachments.length > 0 ? messageAttachments : undefined;
}

export function buildAcpImages(
  attachments: ChatAttachmentDraft[] | undefined,
): { base64: string; mimeType: string }[] | undefined {
  const images = (attachments ?? []).flatMap((attachment) =>
    attachment.kind === "image"
      ? [{ base64: attachment.base64, mimeType: attachment.mimeType }]
      : [],
  );

  return images.length > 0 ? images : undefined;
}
