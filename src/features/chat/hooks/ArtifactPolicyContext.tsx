import { openPath } from "@tauri-apps/plugin-opener";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type {
  Message,
  ToolCallLocation,
  ToolKind,
} from "@/shared/types/messages";
import { pathExists } from "@/shared/api/system";
import { useResolvedArtifactRoot } from "@/shared/artifacts/useResolvedArtifactRoot";
import { revealInFileManager } from "@/shared/lib/fileManager";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import { useArtifactViewerStore } from "@/features/chat/stores/artifactViewerStore";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import {
  artifactBasename,
  isViewableArtifact,
} from "@/features/chat/lib/artifactViewerTypes";
import {
  isWithinBase,
  isWithinWorkRoots,
} from "@/features/chat/lib/artifactAutoOpenPolicy";
import {
  fileUrlToPath,
  toComparablePath,
  toIdentityKey,
} from "@/shared/lib/pathIdentity";

export interface ArtifactLinkCandidate {
  resolvedPath: string;
  rawPath: string;
  /**
   * True when `resolvedPath` is contained within the session working
   * directory (i.e. not an absolute path or `..`-escape that lands outside
   * the cwd). Consumers that want cwd-scoped behavior (e.g. inline local
   * Markdown images) must check this; it is `false` when there is no session
   * cwd to scope against.
   */
  isWithinSessionCwd: boolean;
  line?: number | null;
}

export interface SessionArtifact {
  resolvedPath: string;
  displayPath: string;
  filename: string;
  directoryPath: string;
  resolvedDirectoryPath: string;
  versionCount: number;
  lastTouchedAt: number;
  kind: "file" | "folder" | "path";
  toolName: string | null;
  toolKind?: ToolKind;
  line?: number | null;
}

export interface ArtifactPolicyContextValue {
  resolveMarkdownHref: (href: string) => ArtifactLinkCandidate | null;
  pathExists: (path: string) => Promise<boolean>;
  openResolvedPath: (path: string) => Promise<void>;
  /**
   * Primary "open this file" action for UI surfaces: viewable files
   * (markdown, images) open in the in-app viewer; everything else opens
   * externally. Resolves the path against the session cwd first.
   */
  openInApp: (path: string, filename?: string) => Promise<void>;
}

const DEFAULT_ACTIONS_CONTEXT_VALUE: ArtifactPolicyContextValue = {
  resolveMarkdownHref: () => null,
  pathExists: async () => false,
  openResolvedPath: async () => {},
  openInApp: async () => {},
};

const EMPTY_SESSION_ARTIFACTS: readonly SessionArtifact[] = [];

const ArtifactActionsContext = createContext<ArtifactPolicyContextValue>(
  DEFAULT_ACTIONS_CONTEXT_VALUE,
);

const ArtifactListContext = createContext<readonly SessionArtifact[]>(
  EMPTY_SESSION_ARTIFACTS,
);

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").trim();
}

function normalizeComparablePath(path: string): string {
  return toIdentityKey(path.trim());
}

function parentDir(path: string): string {
  const lastSlash = path.lastIndexOf("/");
  if (lastSlash <= 0) return "/";
  return path.slice(0, lastSlash + 1);
}

function basenameOf(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function hasExtension(path: string): boolean {
  const name = basenameOf(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1;
}

function inferPathKind(path: string): SessionArtifact["kind"] {
  const normalized = normalizePath(path);
  if (normalized.endsWith("/")) return "folder";
  if (hasExtension(normalized)) return "file";
  return "path";
}

/**
 * Extensions whose default "open" verb on Windows executes the file instead
 * of displaying it: programs, scripts (and the script hosts' variants),
 * shortcuts, installers, registry merges, control-panel applets and the
 * other ShellExecute-runs-it families. A link or chip that lands on one of
 * these is revealed in the file manager rather than opened, because the
 * click was made to *read* something the agent named, and an agent-written
 * file carries no mark-of-the-web to trigger SmartScreen.
 */
const EXECUTABLE_OPEN_EXTENSIONS: ReadonlySet<string> = new Set([
  "exe",
  "com",
  "bat",
  "cmd",
  "lnk",
  "hta",
  "js",
  "jse",
  "vbs",
  "vbe",
  "wsf",
  "wsh",
  "ps1",
  "psm1",
  "msi",
  "msp",
  "scr",
  "reg",
  "url",
  "cpl",
  "inf",
  "pif",
  "application",
  "gadget",
]);

/**
 * True when opening `path` with its default handler would run it rather than
 * show it. Win32 drops trailing dots and spaces from a name before looking
 * it up, so `tool.exe.` is `tool.exe`; the extension is read the same way.
 */
export function isExecutableOpenTarget(path: string): boolean {
  const name = basenameOf(normalizePath(path)).replace(/[. ]+$/, "");
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return false;
  return EXECUTABLE_OPEN_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

// "C:/x", "C:\x" and — once the markdown renderer has percent-encoded the
// backslash — "C:%5Cx" all start like a one-letter URL scheme, but they are
// Windows drive paths and must resolve like any other local path.
const WINDOWS_DRIVE_HREF = /^[a-zA-Z]:(?:[\\/]|%5c|%2f)/i;

function hasBlockedMarkdownScheme(href: string): boolean {
  if (WINDOWS_DRIVE_HREF.test(href)) {
    return false;
  }
  if (!/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(href)) {
    return false;
  }

  return !href.toLowerCase().startsWith("file:");
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(path);
}

function resolveRelativeToBase(base: string, relativePath: string): string {
  const normalizedBase = toComparablePath(base);
  const normalizedRelative = normalizePath(relativePath).replace(/^\.\/+/, "");
  if (!normalizedRelative || normalizedRelative === ".") return normalizedBase;

  const stack = normalizedBase.split("/").filter(Boolean);
  const hasWindowsDriveRoot = /^[a-zA-Z]:$/.test(stack[0] ?? "");
  const hasUncRoot = normalizedBase.startsWith("//") && stack.length >= 2;
  const minimumSegments = hasUncRoot ? 2 : hasWindowsDriveRoot ? 1 : 0;
  for (const segment of normalizedRelative.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (stack.length > minimumSegments) stack.pop();
      continue;
    }
    stack.push(segment);
  }

  const resolved = stack.join("/");
  if (hasWindowsDriveRoot) return resolved;
  return hasUncRoot ? `//${resolved}` : `/${resolved}`;
}

// Markdown image/link destinations percent-encode characters that are not
// allowed raw in a URL destination — most commonly spaces (`%20`). Filesystem
// checks (`path_exists`) and `convertFileSrc` both expect a real, decoded path
// (the latter re-encodes internally, so a pre-encoded path would double-encode).
// Decode once here so every consumer works with the true path. Guarded because
// `decodeURIComponent` throws on malformed `%` sequences.
function decodePathIfEncoded(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

function resolvePath(path: string, sessionCwd: string | null): string {
  const trimmed = path.trim();
  const fromFileUrl = fileUrlToPath(trimmed);
  if (fromFileUrl !== null) {
    return fromFileUrl;
  }
  if (/^file:/i.test(trimmed)) {
    return "";
  }

  // Decode before normalizing so a percent-encoded backslash (%5C) becomes a
  // separator like a raw one does.
  const normalized = normalizePath(decodePathIfEncoded(path));
  if (!normalized) return "";

  if (isAbsolutePath(normalized)) {
    return normalized;
  }

  return sessionCwd
    ? resolveRelativeToBase(sessionCwd, normalized)
    : normalized;
}

function isNonEmptyLocation(
  location: ToolCallLocation,
): location is ToolCallLocation & { path: string } {
  return typeof location.path === "string" && location.path.trim().length > 0;
}

export function collectSessionArtifacts(
  messages: readonly Message[],
  cwd: string | null,
): SessionArtifact[] {
  const artifactMap = new Map<string, SessionArtifact>();

  for (const message of messages) {
    if (message.role !== "assistant") continue;
    if (message.metadata?.userVisible === false) continue;

    for (const block of message.content) {
      if (block.type !== "toolRequest") continue;
      const locations = block.locations?.filter(isNonEmptyLocation) ?? [];

      for (const location of locations) {
        const resolvedPath = resolvePath(location.path, cwd);
        const key = normalizeComparablePath(resolvedPath);
        if (!key) continue;

        const existing = artifactMap.get(key);
        if (existing) {
          existing.versionCount += 1;
          if (message.created > existing.lastTouchedAt) {
            existing.lastTouchedAt = message.created;
            existing.toolName = block.toolName ?? block.name;
            existing.toolKind = block.toolKind;
            existing.line = location.line;
          }
          continue;
        }

        artifactMap.set(key, {
          resolvedPath,
          displayPath: resolvedPath,
          filename: basenameOf(resolvedPath),
          directoryPath: parentDir(resolvedPath),
          resolvedDirectoryPath: parentDir(resolvedPath),
          versionCount: 1,
          lastTouchedAt: message.created,
          kind: inferPathKind(resolvedPath),
          toolName: block.toolName ?? block.name,
          toolKind: block.toolKind,
          line: location.line,
        });
      }
    }
  }

  return Array.from(artifactMap.values()).sort(
    (a, b) => b.lastTouchedAt - a.lastTouchedAt,
  );
}

function getArtifactSignature(
  messages: readonly Message[],
  cwd: string | null,
): string {
  const parts = ["cwd", cwd ?? ""];

  for (const message of messages) {
    if (message.role !== "assistant") continue;
    // Mirror collectSessionArtifacts: hidden messages never contribute an
    // artifact, so they must not contribute to the signature either —
    // otherwise a hidden tool call would invalidate the cache and publish a
    // new (identical) list, defeating the stability optimization.
    if (message.metadata?.userVisible === false) continue;

    const toolRequestParts = [];
    for (const block of message.content) {
      if (block.type !== "toolRequest") continue;
      const locations = block.locations?.filter(isNonEmptyLocation) ?? [];
      if (locations.length === 0) continue;
      toolRequestParts.push([
        block.toolName ?? block.name,
        block.toolKind ?? null,
        locations.map((location) => [
          normalizePath(location.path),
          location.line ?? null,
        ]),
      ]);
    }

    if (toolRequestParts.length === 0) continue;

    parts.push(JSON.stringify([message.created, toolRequestParts]));
  }

  return parts.join("\n");
}

interface PendingOpenConfirmation {
  path: string;
  resolve: (confirmed: boolean) => void;
}

export function ArtifactPolicyProvider({
  messages,
  sessionCwd,
  sessionId,
  children,
}: {
  messages: Message[];
  sessionCwd: string | null;
  sessionId?: string | null;
  children: ReactNode;
}) {
  const { t } = useTranslation("chat");
  const openInViewer = useArtifactViewerStore((s) => s.open);
  const normalizedSessionCwd = useMemo(
    () => sessionCwd?.trim() || null,
    [sessionCwd],
  );
  // Places the user has deliberately pointed this chat at. A local target
  // inside one of them opens straight away; anything else is confirmed
  // first, because the path came from agent output (a markdown link, a tool
  // location) rather than from the user.
  const artifactRoot = useResolvedArtifactRoot();
  const workspaceAttachments = useChatSessionStore((state) =>
    sessionId
      ? state.sessions.find((session) => session.id === sessionId)
          ?.workspaceAttachments
      : undefined,
  );
  const trustedOpenRoots = useMemo(
    () => [
      normalizedSessionCwd,
      artifactRoot,
      ...(workspaceAttachments ?? []).map((attachment) => attachment.path),
    ],
    [normalizedSessionCwd, artifactRoot, workspaceAttachments],
  );
  const [pendingOpen, setPendingOpen] =
    useState<PendingOpenConfirmation | null>(null);
  const pendingOpenRef = useRef<PendingOpenConfirmation | null>(null);
  const artifactCacheRef = useRef<{
    artifacts: SessionArtifact[];
    signature: string;
  } | null>(null);
  const lastOpenAtByPathRef = useRef(new Map<string, number>());

  // Recompute the content signature only when the message list or cwd changes,
  // then recollect artifacts only when that signature changes — keeping the
  // artifact array's identity stable across streaming text chunks that don't
  // touch any tool-call locations. cwd is part of the signature, so a cwd
  // change invalidates the cache on its own.
  const artifactSignature = useMemo(
    () => getArtifactSignature(messages, normalizedSessionCwd),
    [messages, normalizedSessionCwd],
  );
  if (
    !artifactCacheRef.current ||
    artifactCacheRef.current.signature !== artifactSignature
  ) {
    artifactCacheRef.current = {
      artifacts: collectSessionArtifacts(messages, normalizedSessionCwd),
      signature: artifactSignature,
    };
  }
  const artifacts = artifactCacheRef.current.artifacts;

  const resolveMarkdownHref = useCallback(
    (href: string): ArtifactLinkCandidate | null => {
      const trimmed = href.trim();
      if (!trimmed || trimmed.startsWith("#")) return null;
      if (hasBlockedMarkdownScheme(trimmed)) return null;

      if (/^file:/i.test(trimmed)) {
        const resolvedPath = resolvePath(trimmed, normalizedSessionCwd);
        if (!resolvedPath) return null;
        return {
          rawPath: trimmed,
          resolvedPath,
          isWithinSessionCwd: isWithinBase(normalizedSessionCwd, resolvedPath),
        };
      }

      const withoutHash = trimmed.split("#")[0];
      const withoutQuery = withoutHash.split("?")[0];
      if (!withoutQuery) return null;

      const resolvedPath = resolvePath(withoutQuery, normalizedSessionCwd);
      if (!resolvedPath) return null;
      return {
        rawPath: withoutQuery,
        resolvedPath,
        isWithinSessionCwd: isWithinBase(normalizedSessionCwd, resolvedPath),
      };
    },
    [normalizedSessionCwd],
  );

  const resolveOpenTarget = useCallback(
    async (path: string): Promise<string | null> => {
      const resolvedPath = resolvePath(path, normalizedSessionCwd);
      if (await pathExists(resolvedPath)) {
        return resolvedPath;
      }

      return null;
    },
    [normalizedSessionCwd],
  );

  const checkPathExists = useCallback(
    async (path: string) => (await resolveOpenTarget(path)) !== null,
    [resolveOpenTarget],
  );

  const settlePendingOpen = useCallback((confirmed: boolean) => {
    const pending = pendingOpenRef.current;
    pendingOpenRef.current = null;
    setPendingOpen(null);
    pending?.resolve(confirmed);
  }, []);

  const confirmOpenOutsideRoots = useCallback(
    (path: string) =>
      new Promise<boolean>((resolve) => {
        // A second request while one is still waiting supersedes it; the
        // earlier caller sees a cancel rather than hanging forever.
        pendingOpenRef.current?.resolve(false);
        const pending = { path, resolve };
        pendingOpenRef.current = pending;
        setPendingOpen(pending);
      }),
    [],
  );

  /**
   * Every external open funnels through here — markdown links, artifact
   * chips, the files list, tool-card locations and `openInApp`'s fallback —
   * so the gate lives here rather than in any one caller:
   *
   * 1. Anything Windows would *run* rather than show is revealed in the file
   *    manager instead, with a notice saying so.
   * 2. A target outside the session cwd, the attached workspaces and the
   *    artifact root asks first, the way an external URL does.
   */
  const openResolvedPath = useCallback(
    async (path: string) => {
      const resolvedTarget = await resolveOpenTarget(path);
      if (!resolvedTarget) {
        throw new Error(t("tools.fileNotFound", { path }));
      }

      const key = resolvedTarget.trim().toLowerCase();
      const now = Date.now();
      const lastOpenAt = lastOpenAtByPathRef.current.get(key) ?? 0;
      if (now - lastOpenAt < 1200) {
        return;
      }
      lastOpenAtByPathRef.current.set(key, now);

      if (isExecutableOpenTarget(resolvedTarget)) {
        await revealInFileManager(resolvedTarget);
        toast.message(
          t("openPath.revealedInsteadOfRun", {
            name: basenameOf(resolvedTarget),
          }),
        );
        return;
      }

      if (!isWithinWorkRoots(trustedOpenRoots, resolvedTarget)) {
        const confirmed = await confirmOpenOutsideRoots(resolvedTarget);
        if (!confirmed) return;
      }

      await openPath(resolvedTarget);
    },
    [resolveOpenTarget, trustedOpenRoots, confirmOpenOutsideRoots, t],
  );

  const openInApp = useCallback(
    async (path: string, filename?: string) => {
      const resolvedTarget = await resolveOpenTarget(path);
      // Viewable + resolvable + we know the session: open in the viewer.
      if (resolvedTarget && sessionId && isViewableArtifact(resolvedTarget)) {
        openInViewer(sessionId, {
          resolvedPath: resolvedTarget,
          filename: filename ?? artifactBasename(resolvedTarget),
        });
        return;
      }
      // Otherwise fall back to opening externally (also handles not-found).
      await openResolvedPath(path);
    },
    [resolveOpenTarget, sessionId, openInViewer, openResolvedPath],
  );

  const actionsValue = useMemo<ArtifactPolicyContextValue>(
    () => ({
      resolveMarkdownHref,
      pathExists: checkPathExists,
      openResolvedPath,
      openInApp,
    }),
    [checkPathExists, openResolvedPath, openInApp, resolveMarkdownHref],
  );

  return (
    <ArtifactActionsContext.Provider value={actionsValue}>
      <ArtifactListContext.Provider value={artifacts}>
        {children}
      </ArtifactListContext.Provider>
      <ConfirmDialog
        open={pendingOpen !== null}
        onOpenChange={(open) => {
          if (!open) settlePendingOpen(false);
        }}
        title={t("openPath.confirmTitle")}
        description={
          <span className="break-all font-mono">{pendingOpen?.path ?? ""}</span>
        }
        cancelLabel={t("openPath.confirmCancel")}
        confirmLabel={t("openPath.confirmOpen")}
        destructive={false}
        onConfirm={() => settlePendingOpen(true)}
      />
    </ArtifactActionsContext.Provider>
  );
}

export function useArtifactActionsContext(): ArtifactPolicyContextValue {
  return useContext(ArtifactActionsContext);
}

export function useSessionArtifacts(): readonly SessionArtifact[] {
  return useContext(ArtifactListContext);
}
