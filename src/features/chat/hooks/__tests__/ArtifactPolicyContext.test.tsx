import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { openPath } from "@tauri-apps/plugin-opener";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@/shared/types/messages";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import {
  ArtifactPolicyProvider,
  collectSessionArtifacts,
  getArtifactSignature,
  useArtifactActionsContext,
  useSessionArtifacts,
} from "../ArtifactPolicyContext";

const mockPathExists = vi.fn<(path: string) => Promise<boolean>>();

vi.mock("@/shared/api/system", () => ({
  pathExists: (path: string) => mockPathExists(path),
}));

function ArtifactsProbe() {
  const artifacts = useSessionArtifacts();

  return (
    <div>
      <span data-testid="artifact-paths">
        {artifacts.map((artifact) => artifact.resolvedPath).join(",")}
      </span>
      <span data-testid="artifact-count">{String(artifacts.length)}</span>
    </div>
  );
}

function ArtifactListProbe() {
  const artifacts = useSessionArtifacts();

  return (
    <div>
      <span data-testid="artifact-list-paths">
        {artifacts.map((artifact) => artifact.resolvedPath).join(",")}
      </span>
      <span data-testid="artifact-list-count">{String(artifacts.length)}</span>
    </div>
  );
}

const WINDOWS_SESSION_CWD = "C:\\Users\\me\\repo";

function LinkProbe({ href }: { href: string }) {
  const { resolveMarkdownHref } = useArtifactActionsContext();
  const candidate = resolveMarkdownHref(href);

  return (
    <div>
      <span data-testid="link-has-candidate">{String(candidate !== null)}</span>
      <span data-testid="link-path">{candidate?.resolvedPath ?? ""}</span>
      <span data-testid="link-within-cwd">
        {String(candidate?.isWithinSessionCwd ?? false)}
      </span>
    </div>
  );
}

describe("ArtifactPolicyContext", () => {
  it("updates path resolution and artifacts when the session cwd changes", () => {
    const messages: Message[] = [
      {
        id: "assistant-1",
        role: "assistant",
        created: 1,
        content: [
          {
            type: "toolRequest",
            id: "tool-1",
            name: "write_file",
            arguments: {},
            status: "completed",
            locations: [{ path: "output/report.md" }],
          },
        ],
      },
    ];

    const { rerender } = render(
      <ArtifactPolicyProvider messages={messages} sessionCwd="/Users/test/old">
        <LinkProbe href="docs/readme.md" />
        <ArtifactListProbe />
      </ArtifactPolicyProvider>,
    );

    expect(screen.getByTestId("link-path")).toHaveTextContent(
      "/Users/test/old/docs/readme.md",
    );
    expect(screen.getByTestId("artifact-list-paths")).toHaveTextContent(
      "/Users/test/old/output/report.md",
    );

    rerender(
      <ArtifactPolicyProvider messages={messages} sessionCwd="/Users/test/new">
        <LinkProbe href="docs/readme.md" />
        <ArtifactListProbe />
      </ArtifactPolicyProvider>,
    );

    expect(screen.getByTestId("link-path")).toHaveTextContent(
      "/Users/test/new/docs/readme.md",
    );
    expect(screen.getByTestId("artifact-list-paths")).toHaveTextContent(
      "/Users/test/new/output/report.md",
    );
  });

  it("merges duplicate artifact paths and keeps the latest metadata", () => {
    const artifacts = collectSessionArtifacts(
      [
        {
          id: "assistant-1",
          role: "assistant",
          created: 1,
          content: [
            {
              type: "toolRequest",
              id: "tool-1",
              name: "read_file",
              arguments: {},
              status: "completed",
              toolKind: "read",
              locations: [{ path: "output/report.md", line: 3 }],
            },
          ],
        },
        {
          id: "assistant-2",
          role: "assistant",
          created: 2,
          content: [
            {
              type: "toolRequest",
              id: "tool-2",
              name: "write_file",
              arguments: {},
              status: "completed",
              toolKind: "edit",
              locations: [{ path: "/work/output/report.md", line: 9 }],
            },
          ],
        },
      ],
      "/work",
    );

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      resolvedPath: "/work/output/report.md",
      versionCount: 2,
      lastTouchedAt: 2,
      toolName: "write_file",
      toolKind: "edit",
      line: 9,
    });
  });

  it("uses reported ACP tool locations as session artifacts", () => {
    const messages: Message[] = [
      {
        id: "assistant-1",
        role: "assistant",
        created: Date.now(),
        content: [
          {
            type: "toolRequest",
            id: "tool-1",
            name: "read_file",
            arguments: {},
            status: "completed",
            toolKind: "read",
            locations: [{ path: "/Users/test/project-a/notes.md" }],
          },
          {
            type: "toolResponse",
            id: "tool-1",
            name: "read_file",
            result: "Read notes",
            isError: false,
          },
        ],
      },
    ];

    render(
      <ArtifactPolicyProvider
        messages={messages}
        sessionCwd="/Users/test/project-a"
      >
        <ArtifactsProbe />
      </ArtifactPolicyProvider>,
    );

    expect(screen.getByTestId("artifact-count")).toHaveTextContent("1");
    expect(screen.getByTestId("artifact-paths")).toHaveTextContent(
      "/Users/test/project-a/notes.md",
    );
  });

  it("does not filter reported locations outside allowed roots", () => {
    const messages: Message[] = [
      {
        id: "assistant-1",
        role: "assistant",
        created: Date.now(),
        content: [
          {
            type: "toolRequest",
            id: "tool-1",
            name: "write_file",
            arguments: {},
            status: "completed",
            toolKind: "edit",
            locations: [{ path: "/tmp/outside.md" }],
          },
        ],
      },
    ];

    render(
      <ArtifactPolicyProvider
        messages={messages}
        sessionCwd="/Users/test/project-a"
      >
        <ArtifactsProbe />
      </ArtifactPolicyProvider>,
    );

    expect(screen.getByTestId("artifact-paths")).toHaveTextContent(
      "/tmp/outside.md",
    );
  });

  it("resolves local markdown hrefs relative to the session cwd", () => {
    render(
      <ArtifactPolicyProvider messages={[]} sessionCwd="/Users/test/app">
        <LinkProbe href="output/report.md" />
      </ArtifactPolicyProvider>,
    );

    expect(screen.getByTestId("link-path")).toHaveTextContent(
      "/Users/test/app/output/report.md",
    );
  });

  it("resolves relative markdown hrefs against Windows and UNC roots", () => {
    const { rerender } = render(
      <ArtifactPolicyProvider messages={[]} sessionCwd="C:/">
        <LinkProbe href="repo/report.md" />
      </ArtifactPolicyProvider>,
    );
    expect(screen.getByTestId("link-path")).toHaveTextContent(
      "C:/repo/report.md",
    );

    rerender(
      <ArtifactPolicyProvider messages={[]} sessionCwd="//server/share">
        <LinkProbe href="repo/report.md" />
      </ArtifactPolicyProvider>,
    );
    expect(screen.getByTestId("link-path")).toHaveTextContent(
      "//server/share/repo/report.md",
    );
  });

  it("decodes percent-encoded spaces in an absolute markdown href", () => {
    // The default chat working dir is "~/goose artifacts" (has a space), so a
    // correctly-authored markdown image escapes the space as %20. The resolved
    // path must be decoded so path_exists/convertFileSrc see the real path.
    render(
      <ArtifactPolicyProvider messages={[]} sessionCwd="/Users/test/app">
        <LinkProbe href="/Users/test/goose%20artifacts/smiley.svg" />
      </ArtifactPolicyProvider>,
    );

    expect(screen.getByTestId("link-path")).toHaveTextContent(
      "/Users/test/goose artifacts/smiley.svg",
    );
  });

  it("decodes percent-encoded spaces in a relative markdown href", () => {
    render(
      <ArtifactPolicyProvider
        messages={[]}
        sessionCwd="/Users/test/goose artifacts"
      >
        <LinkProbe href="my%20image.png" />
      </ArtifactPolicyProvider>,
    );

    expect(screen.getByTestId("link-path")).toHaveTextContent(
      "/Users/test/goose artifacts/my image.png",
    );
  });

  it.each([
    ["C:\\Users\\me\\repo\\report.md", "C:/Users/me/repo/report.md"],
    ["C:/Users/me/repo/report.md", "C:/Users/me/repo/report.md"],
    [
      "c:%5Cusers%5Cme%5Crepo%5Cmy%20report.md",
      "c:/users/me/repo/my report.md",
    ],
    ["D:%2Fdata%2Freport.md", "D:/data/report.md"],
  ])("resolves the Windows drive markdown href %s", (href, expected) => {
    render(
      <ArtifactPolicyProvider messages={[]} sessionCwd="C:/Users/me/repo">
        <LinkProbe href={href} />
      </ArtifactPolicyProvider>,
    );

    expect(screen.getByTestId("link-has-candidate")).toHaveTextContent("true");
    expect(screen.getByTestId("link-path")).toHaveTextContent(expected);
  });

  it("marks a Windows drive href inside the session cwd as within cwd", () => {
    render(
      <ArtifactPolicyProvider messages={[]} sessionCwd={WINDOWS_SESSION_CWD}>
        <LinkProbe href="C:%5CUsers%5Cme%5Crepo%5Csrc%5Cmain.ts" />
      </ArtifactPolicyProvider>,
    );

    expect(screen.getByTestId("link-path")).toHaveTextContent(
      "C:/Users/me/repo/src/main.ts",
    );
    expect(screen.getByTestId("link-within-cwd")).toHaveTextContent("true");
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,<h1>hello</h1>",
    "vbscript:msgbox(1)",
    "https://example.com/report.md",
    "mailto:hello@example.com",
    "berd://session/session-1",
    "berd:///session/session-1",
    "#anchor",
  ])("does not resolve blocked markdown href %s", (href) => {
    render(
      <ArtifactPolicyProvider messages={[]} sessionCwd="/Users/test/app">
        <LinkProbe href={href} />
      </ArtifactPolicyProvider>,
    );

    expect(screen.getByTestId("link-has-candidate")).toHaveTextContent("false");
    expect(screen.getByTestId("link-path")).toHaveTextContent("");
  });

  it("marks a path inside the session cwd as within cwd", () => {
    render(
      <ArtifactPolicyProvider messages={[]} sessionCwd="/Users/test/app">
        <LinkProbe href="output/report.png" />
      </ArtifactPolicyProvider>,
    );

    expect(screen.getByTestId("link-within-cwd")).toHaveTextContent("true");
  });

  it("marks an absolute path outside the session cwd as not within cwd", () => {
    render(
      <ArtifactPolicyProvider messages={[]} sessionCwd="/Users/test/app">
        <LinkProbe href="/Users/test/secrets/private.png" />
      </ArtifactPolicyProvider>,
    );

    // The path still resolves (click-to-open relies on it), but cwd-scoped
    // consumers like inline markdown images must see it as outside the cwd.
    expect(screen.getByTestId("link-path")).toHaveTextContent(
      "/Users/test/secrets/private.png",
    );
    expect(screen.getByTestId("link-within-cwd")).toHaveTextContent("false");
  });

  it("marks a ..-escaping relative path as not within cwd", () => {
    render(
      <ArtifactPolicyProvider messages={[]} sessionCwd="/Users/test/app">
        <LinkProbe href="../../secrets/private.png" />
      </ArtifactPolicyProvider>,
    );

    expect(screen.getByTestId("link-path")).toHaveTextContent(
      "/Users/secrets/private.png",
    );
    expect(screen.getByTestId("link-within-cwd")).toHaveTextContent("false");
  });

  it("does not treat a sibling directory with a shared prefix as within cwd", () => {
    render(
      <ArtifactPolicyProvider messages={[]} sessionCwd="/Users/test/app">
        <LinkProbe href="/Users/test/app-secrets/private.png" />
      </ArtifactPolicyProvider>,
    );

    expect(screen.getByTestId("link-within-cwd")).toHaveTextContent("false");
  });

  it("reports not within cwd when there is no session cwd", () => {
    render(
      <ArtifactPolicyProvider messages={[]} sessionCwd={null}>
        <LinkProbe href="output/report.png" />
      </ArtifactPolicyProvider>,
    );

    expect(screen.getByTestId("link-within-cwd")).toHaveTextContent("false");
  });

  it.each([
    "file:report.md",
    "file:./report.md",
    "file:../report.md",
    "file:///tmp/report%ZZ.md",
    "file:///tmp/report.md?download=1",
    "file:///tmp/report.md#preview",
  ])("rejects an unsafe file markdown href %s", (href) => {
    render(
      <ArtifactPolicyProvider messages={[]} sessionCwd="/Users/test/app">
        <LinkProbe href={href} />
      </ArtifactPolicyProvider>,
    );

    expect(screen.getByTestId("link-has-candidate")).toHaveTextContent("false");
    expect(screen.getByTestId("link-path")).toHaveTextContent("");
  });

  it.each([
    "\\\\attacker\\share\\x.md",
    "%5C%5Cattacker%5Cshare%5Cx.md",
    "//attacker/share/x.md",
    "file://attacker/share/x.md",
  ])("does not resolve the UNC markdown destination %s", (href) => {
    // A UNC destination must never become a candidate: on Windows the first
    // filesystem call on it opens an SMB session to `attacker` (NTLM exchange)
    // and blocks the UI thread until the network timeout.
    render(
      <ArtifactPolicyProvider messages={[]} sessionCwd="C:/Users/me/repo">
        <LinkProbe href={href} />
      </ArtifactPolicyProvider>,
    );

    expect(screen.getByTestId("link-has-candidate")).toHaveTextContent("false");
    expect(screen.getByTestId("link-path")).toHaveTextContent("");
  });

  it("resolves file markdown hrefs as local paths", () => {
    render(
      <ArtifactPolicyProvider messages={[]} sessionCwd="/Users/test/app">
        <LinkProbe href="file:///tmp/report.md" />
      </ArtifactPolicyProvider>,
    );

    expect(screen.getByTestId("link-has-candidate")).toHaveTextContent("true");
    expect(screen.getByTestId("link-path")).toHaveTextContent("/tmp/report.md");
  });
});

const mockRevealInFileManager = vi.fn<(path: string) => Promise<void>>();
const mockToastMessage = vi.fn();
let mockArtifactRoot: string | null = null;

vi.mock("@/shared/lib/fileManager", () => ({
  revealInFileManager: (path: string) => mockRevealInFileManager(path),
}));

vi.mock("sonner", () => ({
  toast: {
    message: (...args: unknown[]) => mockToastMessage(...args),
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock("@/shared/artifacts/useResolvedArtifactRoot", () => ({
  useResolvedArtifactRoot: () => mockArtifactRoot,
}));

function OpenProbe({
  path,
  mode = "external",
}: {
  path: string;
  mode?: "external" | "app";
}) {
  const { openResolvedPath, openInApp } = useArtifactActionsContext();
  const [error, setError] = useState<string | null>(null);
  const [settled, setSettled] = useState(false);

  return (
    <div>
      <button
        type="button"
        onClick={() => {
          setSettled(false);
          void (mode === "app" ? openInApp(path) : openResolvedPath(path))
            .then(() => setSettled(true))
            .catch((err: unknown) => {
              setError(err instanceof Error ? err.message : String(err));
              setSettled(true);
            });
        }}
      >
        open
      </button>
      <span data-testid="open-error">{error ?? ""}</span>
      <span data-testid="open-settled">{String(settled)}</span>
    </div>
  );
}

describe("ArtifactPolicyContext open gate", () => {
  beforeEach(() => {
    mockArtifactRoot = null;
    mockPathExists.mockReset();
    mockPathExists.mockResolvedValue(true);
    mockRevealInFileManager.mockReset();
    mockRevealInFileManager.mockResolvedValue(undefined);
    mockToastMessage.mockReset();
    vi.mocked(openPath).mockReset();
    useChatSessionStore.setState({ sessions: [] });
  });

  it.each([
    "C:/Users/me/AppData/Local/Temp/report.cmd",
    "C:/Users/me/repo/setup.bat",
    "C:/Users/me/Downloads/report.pdf.lnk",
    "C:/Users/me/repo/notes.PS1",
    "C:/Users/me/repo/tool.exe.",
    "scripts/run.js",
  ])("reveals %s in the file manager instead of running it", async (path) => {
    render(
      <ArtifactPolicyProvider messages={[]} sessionCwd="C:/Users/me/repo">
        <OpenProbe path={path} />
      </ArtifactPolicyProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "open" }));
    await waitFor(() =>
      expect(screen.getByTestId("open-settled")).toHaveTextContent("true"),
    );

    expect(openPath).not.toHaveBeenCalled();
    expect(mockRevealInFileManager).toHaveBeenCalledTimes(1);
    expect(mockToastMessage).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("open-error")).toHaveTextContent("");
  });

  // A file the agent wrote into the session cwd is inside the trusted roots,
  // so nothing else in the gate would stop it: these types must be refused by
  // the denylist itself or they run on a single click.
  it.each([
    "summary.py",
    "helper.pyw",
    "tool.jar",
    "console.msc",
    "share.scf",
    "theme.settingcontent-ms",
    "recent.library-ms",
    "manual.chm",
    "runner.sct",
    "runner.wsc",
    "patch.mst",
    "app.appinstaller",
    "wizard.diagcab",
    // An alternate-data-stream suffix hides the real extension from the
    // denylist unless it is cut off first.
    "payload.exe::$DATA",
    "summary.py:extra",
    // A stream suffix on an otherwise ordinary name is not a document either.
    "notes.txt::$DATA",
  ])("reveals the run-on-open type %s written inside the cwd", async (name) => {
    render(
      <ArtifactPolicyProvider messages={[]} sessionCwd="C:/Users/me/repo">
        <OpenProbe path={name} />
      </ArtifactPolicyProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "open" }));
    await waitFor(() =>
      expect(screen.getByTestId("open-settled")).toHaveTextContent("true"),
    );

    expect(openPath).not.toHaveBeenCalled();
    expect(mockRevealInFileManager).toHaveBeenCalledWith(
      `C:/Users/me/repo/${name}`,
    );
    expect(screen.getByTestId("open-error")).toHaveTextContent("");
  });

  it("reveals an executable reached through openInApp's external fallback", async () => {
    // `.exe` is not viewable in-app, so openInApp falls through to the
    // external open — the gate must sit on that path too.
    render(
      <ArtifactPolicyProvider
        messages={[]}
        sessionCwd="C:/Users/me/repo"
        sessionId="session-1"
      >
        <OpenProbe path="C:/Users/me/repo/payload.exe" mode="app" />
      </ArtifactPolicyProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "open" }));
    await waitFor(() =>
      expect(screen.getByTestId("open-settled")).toHaveTextContent("true"),
    );

    expect(openPath).not.toHaveBeenCalled();
    expect(mockRevealInFileManager).toHaveBeenCalledWith(
      "C:/Users/me/repo/payload.exe",
    );
  });

  it("opens a document inside the session cwd without asking", async () => {
    render(
      <ArtifactPolicyProvider messages={[]} sessionCwd="C:/Users/me/repo">
        <OpenProbe path="docs/report.pdf" />
      </ArtifactPolicyProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "open" }));
    await waitFor(() =>
      expect(openPath).toHaveBeenCalledWith("C:/Users/me/repo/docs/report.pdf"),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mockRevealInFileManager).not.toHaveBeenCalled();
  });

  it("opens a document under the artifact root without asking", async () => {
    mockArtifactRoot = "C:/Users/me/Distill/artifacts";
    render(
      <ArtifactPolicyProvider messages={[]} sessionCwd="C:/Users/me/repo">
        <OpenProbe path="C:/Users/me/Distill/artifacts/post.docx" />
      </ArtifactPolicyProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "open" }));
    await waitFor(() =>
      expect(openPath).toHaveBeenCalledWith(
        "C:/Users/me/Distill/artifacts/post.docx",
      ),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens a document under an attached workspace without asking", async () => {
    useChatSessionStore.setState({
      sessions: [
        {
          id: "session-1",
          title: "t",
          createdAt: "2024-01-01",
          updatedAt: "2024-01-01",
          messageCount: 0,
          archiveMutationBySessionId: {},
          workspaceAttachments: [
            { id: "ws-1", path: "D:\\work\\other-repo", source: "user" },
          ],
        } as never,
      ],
    });
    render(
      <ArtifactPolicyProvider
        messages={[]}
        sessionCwd="C:/Users/me/repo"
        sessionId="session-1"
      >
        <OpenProbe path="D:/work/other-repo/README.pdf" />
      </ArtifactPolicyProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "open" }));
    await waitFor(() =>
      expect(openPath).toHaveBeenCalledWith("D:/work/other-repo/README.pdf"),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("asks before opening a document outside every known root, and opens on confirm", async () => {
    render(
      <ArtifactPolicyProvider messages={[]} sessionCwd="C:/Users/me/repo">
        <OpenProbe path="D:/elsewhere/report.pdf" />
      </ArtifactPolicyProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "open" }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("D:/elsewhere/report.pdf");
    expect(openPath).not.toHaveBeenCalled();

    await userEvent.click(within(dialog).getByRole("button", { name: "Open" }));
    await waitFor(() =>
      expect(openPath).toHaveBeenCalledWith("D:/elsewhere/report.pdf"),
    );
    await waitFor(() =>
      expect(screen.getByTestId("open-settled")).toHaveTextContent("true"),
    );
    expect(screen.getByTestId("open-error")).toHaveTextContent("");
  });

  it("does not open a document outside every known root when the user cancels", async () => {
    render(
      <ArtifactPolicyProvider messages={[]} sessionCwd="C:/Users/me/repo">
        <OpenProbe path="../secrets/report.pdf" />
      </ArtifactPolicyProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "open" }));

    const dialog = await screen.findByRole("dialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Cancel" }),
    );

    await waitFor(() =>
      expect(screen.getByTestId("open-settled")).toHaveTextContent("true"),
    );
    expect(openPath).not.toHaveBeenCalled();
    expect(screen.getByTestId("open-error")).toHaveTextContent("");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it.each([
    "\\\\attacker\\share\\x.md",
    "//attacker/share/x.md",
    "file://attacker/share/x.md",
  ])("never probes or opens the UNC target %s", async (path) => {
    render(
      <ArtifactPolicyProvider messages={[]} sessionCwd="C:/Users/me/repo">
        <OpenProbe path={path} />
      </ArtifactPolicyProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "open" }));
    await waitFor(() =>
      expect(screen.getByTestId("open-settled")).toHaveTextContent("true"),
    );

    // The SMB/NTLM handshake happens on the `path_exists` call, so that call
    // is what must not be made — being blocked at `openPath` would be too late.
    expect(mockPathExists).not.toHaveBeenCalled();
    expect(openPath).not.toHaveBeenCalled();
    expect(mockRevealInFileManager).not.toHaveBeenCalled();
  });

  it("reports a missing file with a translated message", async () => {
    mockPathExists.mockResolvedValue(false);
    render(
      <ArtifactPolicyProvider messages={[]} sessionCwd="C:/Users/me/repo">
        <OpenProbe path="docs/missing.pdf" />
      </ArtifactPolicyProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "open" }));
    await waitFor(() =>
      expect(screen.getByTestId("open-error")).toHaveTextContent(
        "File not found: docs/missing.pdf",
      ),
    );
    expect(openPath).not.toHaveBeenCalled();
  });
});

function TrustedRootProbe({ path }: { path: string }) {
  const { isPathWithinTrustedRoots } = useArtifactActionsContext();

  return (
    <span data-testid="within-trusted-roots">
      {String(isPathWithinTrustedRoots(path))}
    </span>
  );
}

// The predicate inline images are scoped with: there is no click to confirm a
// rendered image, so an agent-named file is either inside the chat's folders or
// it is not shown.
describe("ArtifactPolicyContext trusted-root predicate", () => {
  beforeEach(() => {
    mockArtifactRoot = null;
    useChatSessionStore.setState({ sessions: [] });
  });

  it.each([
    ["diagram.png", "true"],
    ["out/diagram.png", "true"],
    ["C:/Users/me/repo/out/diagram.png", "true"],
    ["C:/Users/me/Pictures/private.png", "false"],
    ["../../Pictures/private.png", "false"],
    ["//attacker/share/private.png", "false"],
  ])("reports %s as within the chat's folders: %s", (path, expected) => {
    render(
      <ArtifactPolicyProvider messages={[]} sessionCwd="C:/Users/me/repo">
        <TrustedRootProbe path={path} />
      </ArtifactPolicyProvider>,
    );

    expect(screen.getByTestId("within-trusted-roots")).toHaveTextContent(
      expected,
    );
  });

  it("accepts a path under the artifact root", () => {
    mockArtifactRoot = "C:/Users/me/Distill/artifacts";
    render(
      <ArtifactPolicyProvider messages={[]} sessionCwd="C:/Users/me/repo">
        <TrustedRootProbe path="C:/Users/me/Distill/artifacts/session/plot.png" />
      </ArtifactPolicyProvider>,
    );

    expect(screen.getByTestId("within-trusted-roots")).toHaveTextContent(
      "true",
    );
  });
});

describe("getArtifactSignature", () => {
  // A streamed frame rebuilds the messages array but not the settled messages
  // in it, so a message's fragment is read once and reused — the signature must
  // not walk the whole transcript again per frame.
  function countingMessage(id: string, path: string) {
    let reads = 0;
    const message = {
      id,
      role: "assistant" as const,
      created: 1,
      get content() {
        reads += 1;
        return [
          {
            type: "toolRequest" as const,
            id: `${id}-tool`,
            name: "write_file",
            arguments: {},
            status: "completed" as const,
            locations: [{ path }],
          },
        ];
      },
    };
    return { message: message as unknown as Message, reads: () => reads };
  }

  it("reads a settled message only once across frames", () => {
    const settled = countingMessage("a1", "out/report.md");

    const first = getArtifactSignature([settled.message], "/work");
    const second = getArtifactSignature([settled.message], "/work");

    expect(second).toBe(first);
    expect(settled.reads()).toBe(1);
  });

  it("still reflects a message whose identity changed", () => {
    const before = countingMessage("a1", "out/report.md");
    const after = countingMessage("a1", "out/summary.md");

    expect(getArtifactSignature([after.message], "/work")).not.toBe(
      getArtifactSignature([before.message], "/work"),
    );
  });

  it("keeps the cwd out of the per-message cache", () => {
    const settled = countingMessage("a1", "out/report.md");

    expect(getArtifactSignature([settled.message], "/new")).not.toBe(
      getArtifactSignature([settled.message], "/old"),
    );
  });
});
