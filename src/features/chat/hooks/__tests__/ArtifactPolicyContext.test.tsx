import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { openPath } from "@tauri-apps/plugin-opener";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import {
  ArtifactPolicyProvider,
  useArtifactActionsContext,
} from "../ArtifactPolicyContext";

const mockPathExists = vi.fn<(path: string) => Promise<boolean>>();

vi.mock("@/shared/api/system", () => ({
  pathExists: (path: string) => mockPathExists(path),
}));

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
  it.each([
    "javascript:alert(1)",
    "data:text/html,<h1>hello</h1>",
    "vbscript:msgbox(1)",
    "https://example.com/report.md",
    "mailto:hello@example.com",
    "distill://session/session-1",
    "distill:///session/session-1",
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
});
