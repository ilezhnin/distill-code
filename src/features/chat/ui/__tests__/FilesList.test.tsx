import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FilesList } from "../FilesList";

const {
  mockListDirectoryEntries,
  mockRevealInFileManager,
  mockOpenInApp,
  mockOpenResolvedPath,
} = vi.hoisted(() => ({
  mockListDirectoryEntries: vi.fn(),
  mockRevealInFileManager: vi.fn(),
  mockOpenInApp: vi.fn(),
  mockOpenResolvedPath: vi.fn(),
}));

vi.mock("@/shared/api/system", () => ({
  listDirectoryEntries: mockListDirectoryEntries,
}));

vi.mock("@/shared/lib/fileManager", () => ({
  revealInFileManager: mockRevealInFileManager,
}));

vi.mock("@/features/chat/hooks/ArtifactPolicyContext", () => ({
  useArtifactActionsContext: () => ({
    openInApp: mockOpenInApp,
    openResolvedPath: mockOpenResolvedPath,
    pathExists: () => Promise.resolve(true),
    resolveMarkdownHref: () => null,
  }),
}));

const makeEntry = (overrides: Record<string, unknown> = {}) => ({
  kind: "file" as const,
  name: "README.md",
  path: "/Users/test/project/README.md",
  ...overrides,
});

describe("FilesList", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOpenInApp.mockResolvedValue(undefined);
    mockOpenResolvedPath.mockResolvedValue(undefined);
    mockRevealInFileManager.mockResolvedValue(undefined);
    mockListDirectoryEntries.mockResolvedValue([]);
  });

  it("shows an empty state when no project working directories are available", () => {
    render(<FilesList />);

    expect(
      screen.getByText("Files will show here after you assign a project."),
    ).toBeInTheDocument();
  });

  it("renders separate top-level roots for each working directory", async () => {
    const { container } = render(
      <FilesList
        projectWorkingDirs={["/Users/test/goose2", "/Users/test/sprout"]}
      />,
    );

    await waitFor(() => {
      expect(mockListDirectoryEntries).toHaveBeenCalledWith(
        "/Users/test/goose2",
      );
      expect(mockListDirectoryEntries).toHaveBeenCalledWith(
        "/Users/test/sprout",
      );
    });

    expect(screen.getByText("goose2")).toBeInTheDocument();
    expect(screen.getByText("sprout")).toBeInTheDocument();
    const rootRow = screen.getByText("goose2").closest("button")?.parentElement;
    expect(rootRow).toHaveClass("gap-3", "h-6", "rounded-sm", "px-0", "py-0");
    expect(rootRow).not.toHaveClass("px-3.5");
    expect(rootRow).not.toHaveClass("py-1.5");
    expect(rootRow).not.toHaveClass("py-2.5");
    expect(rootRow).not.toHaveClass("rounded");
    expect(container.firstElementChild).not.toHaveClass("px-4");
    expect(container.firstElementChild).not.toHaveClass("pb-4");
    expect(container.firstElementChild).not.toHaveClass("pt-4");
    expect(container.firstElementChild).not.toHaveClass("px-1");
    expect(container.firstElementChild).not.toHaveClass("pb-1");
    expect(container.firstElementChild).not.toHaveClass("pb-6");
    expect(container.firstElementChild).not.toHaveClass("pt-1");
  });

  it("expands folders in place without opening them externally", async () => {
    const user = userEvent.setup();
    mockListDirectoryEntries.mockImplementation((path: string) => {
      if (path === "/Users/test/project") {
        return Promise.resolve([
          makeEntry({
            kind: "directory",
            name: "src",
            path: "/Users/test/project/src",
          }),
        ]);
      }

      if (path === "/Users/test/project/src") {
        return Promise.resolve([
          makeEntry({
            name: "App.tsx",
            path: "/Users/test/project/src/App.tsx",
          }),
        ]);
      }

      return Promise.resolve([]);
    });

    render(<FilesList projectWorkingDirs={["/Users/test/project"]} />);

    await screen.findByText("src");
    await user.click(screen.getByText("src"));

    await waitFor(() => {
      expect(mockListDirectoryEntries).toHaveBeenCalledWith(
        "/Users/test/project/src",
      );
    });
    expect(mockOpenInApp).not.toHaveBeenCalled();
    expect(screen.getByText("App.tsx")).toBeInTheDocument();
  });

  it("opens files in the in-app viewer when a file is clicked", async () => {
    const user = userEvent.setup();
    mockListDirectoryEntries.mockResolvedValue([
      makeEntry({
        name: "README.md",
        path: "/Users/test/project/README.md",
      }),
    ]);

    render(<FilesList projectWorkingDirs={["/Users/test/project"]} />);

    const fileName = await screen.findByText("README.md");
    expect(fileName.closest('[role="treeitem"]')).toHaveClass(
      "gap-3",
      "rounded-sm",
      "px-3.5",
      "py-1.5",
    );
    expect(fileName.closest('[role="treeitem"]')).not.toHaveClass("py-2.5");
    expect(fileName.closest('[role="treeitem"]')).not.toHaveClass("rounded");

    await user.click(fileName);

    expect(mockOpenInApp).toHaveBeenCalledWith(
      "/Users/test/project/README.md",
    );
  });

  it("supports context menu actions for folders and files", async () => {
    const user = userEvent.setup();
    mockListDirectoryEntries.mockResolvedValue([
      makeEntry({
        kind: "directory",
        name: "src",
        path: "/Users/test/project/src",
      }),
      makeEntry({
        name: "README.md",
        path: "/Users/test/project/README.md",
      }),
    ]);

    render(<FilesList projectWorkingDirs={["/Users/test/project"]} />);

    const folderLabel = await screen.findByText("src");
    fireEvent.contextMenu(folderLabel);
    await user.click(
      screen.getByRole("menuitem", {
        name: /reveal in (finder|explorer|file manager)/i,
      }),
    );
    expect(mockRevealInFileManager).toHaveBeenCalledWith(
      "/Users/test/project/src",
    );

    const fileLabel = screen.getByText("README.md");
    fireEvent.contextMenu(fileLabel);
    await user.click(
      screen.getByRole("menuitem", {
        name: /reveal in (finder|explorer|file manager)/i,
      }),
    );
    expect(mockRevealInFileManager).toHaveBeenCalledWith(
      "/Users/test/project/README.md",
    );
  });

  it("keeps opening the file in an external editor from the context menu", async () => {
    const user = userEvent.setup();
    mockListDirectoryEntries.mockResolvedValue([
      makeEntry({
        name: "README.md",
        path: "/Users/test/project/README.md",
      }),
    ]);

    render(<FilesList projectWorkingDirs={["/Users/test/project"]} />);

    fireEvent.contextMenu(await screen.findByText("README.md"));
    await user.click(
      screen.getByRole("menuitem", { name: /open in editor/i }),
    );

    expect(mockOpenResolvedPath).toHaveBeenCalledWith(
      "/Users/test/project/README.md",
    );
    expect(mockOpenInApp).not.toHaveBeenCalled();
  });
});
