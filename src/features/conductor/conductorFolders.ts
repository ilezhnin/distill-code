/**
 * Where the conductor loop may look on the strength of what a model wrote.
 *
 * The loop checks the files an executor's report names and, after a restart,
 * reads the status file a dead executor's last message named. Both paths are
 * model text, and the app used to hand them to the filesystem as written: a
 * report naming `\\host\share\x` made the app itself connect to that host
 * and offer the operator's credentials, on every digest and with no click,
 * and a status path could name any file on the disk. The loop's business is
 * the chat's own folder and the folders attached to it, so a path is
 * resolved against them first, lexically, and one that is rooted at a
 * server or a device, or lands outside all of them, is never asked about.
 * It stays what it was: text in the report or the message.
 */

import { getIncludedWorkspaceAttachments } from "@/features/chat/lib/workspaceAttachments";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { isUncOrDeviceRootedPath } from "@/shared/lib/isUncOrDeviceRootedPath";
import { isPathWithin } from "@/shared/lib/pathIdentity";

/** The folders attached to a chat, beside its working folder. */
export function attachedFoldersOf(sessionId: string): string[] {
  const session = useChatSessionStore.getState().getSession(sessionId);
  return getIncludedWorkspaceAttachments(session).map(
    (attachment) => attachment.path,
  );
}

/**
 * Whether `resolved`, what the loop made of the path a model wrote as
 * `reported`, may be handed to a native call.
 *
 * The server test is on `reported`, the spelling that came from outside: a
 * relative path joined to a folder the operator keeps on a share is theirs
 * to have chosen. Containment is lexical — `..` is resolved before it is
 * judged, and nothing is probed to judge it.
 */
export function isInsideConductorFolders(
  reported: string,
  resolved: string,
  folders: readonly (string | null | undefined)[],
): boolean {
  if (isUncOrDeviceRootedPath(reported)) return false;
  return folders.some(
    (folder) => Boolean(folder?.trim()) && isPathWithin(folder, resolved),
  );
}
