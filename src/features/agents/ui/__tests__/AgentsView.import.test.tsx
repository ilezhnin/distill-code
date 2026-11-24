import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import type { CreatePersonaRequest, Persona } from "@/shared/types/agents";
import { AgentsView } from "../AgentsView";

const mocks = vi.hoisted(() => ({
  importPersonas: vi.fn(),
  listPersonaSources: vi.fn(),
  createPersona: vi.fn(),
  imageRequest: { current: null as unknown },
}));

vi.mock("@/shared/api/agents", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/shared/api/agents")>()),
  listPersonas: async () => [],
  refreshPersonas: async () => [],
  createPersona: (...args: unknown[]) => mocks.createPersona(...args),
  importPersonas: (...args: unknown[]) => mocks.importPersonas(...args),
  listPersonaSources: (...args: unknown[]) => mocks.listPersonaSources(...args),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

// The gallery and the cards are not what is under test: the import dialog,
// and what the view does with the file it hands over, are.
vi.mock("@/features/agents/ui/PersonaGallery", () => ({
  PersonaGallery: ({
    onImportAgentImage,
  }: {
    onImportAgentImage?: () => void;
  }) => (
    <button type="button" onClick={onImportAgentImage}>
      open the import dialog
    </button>
  ),
}));
vi.mock("@/features/agents/ui/share-card", () => ({
  AgentShareDialog: () => null,
}));
vi.mock("@/features/agents/ui/share-card/AgentShareCardPreview", () => ({
  AgentShareCardPreview: ({ displayName }: { displayName: string }) => (
    <p>preview of {displayName}</p>
  ),
}));
vi.mock("@/features/agents/ui/share-card/AgentCardReveal", () => ({
  AgentCardReveal: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/features/agents/ui/share-card/HolographicAgentCard", () => ({
  HolographicAgentCard: () => <p>preview of the card</p>,
}));
vi.mock("@/features/agents/ui/AgentDetailPage", () => ({
  AgentDetailPage: () => null,
}));
vi.mock("@/features/agents/ui/AgentImageImportDialog", () => ({
  AgentImageImportDialog: ({
    onConfirm,
  }: {
    onConfirm: (request: CreatePersonaRequest) => Promise<void>;
  }) => (
    <button
      type="button"
      onClick={() => {
        void onConfirm(
          mocks.imageRequest.current as CreatePersonaRequest,
        ).catch(() => {});
      }}
    >
      add the agent from the image
    </button>
  ),
}));

const reviewer = {
  type: "agent",
  path: "C:/Example/.flock/agents/reviewer.md",
  name: "Reviewer",
  description: "Reviews",
  content: "TRUSTED",
  global: true,
  writable: true,
};

function personaFile(displayName: string): File {
  const bytes = new TextEncoder().encode(
    `---\nname: imported\ndisplay_name: "${displayName}"\ndescription: "Example"\n---\n\nMARKER-PERSONA\n`,
  );
  return {
    name: "imported.persona.md",
    type: "text/markdown",
    size: bytes.byteLength,
    arrayBuffer: async () => bytes.buffer,
  } as unknown as File;
}

function jsonFile(contents: unknown, name: string): File {
  const bytes = new TextEncoder().encode(JSON.stringify(contents));
  return {
    name,
    type: "application/json",
    size: bytes.byteLength,
    arrayBuffer: async () => bytes.buffer,
  } as unknown as File;
}

async function pickInTheImportDialog(file: File) {
  const user = userEvent.setup();
  render(<AgentsView />);
  await user.click(
    await screen.findByRole("button", { name: "open the import dialog" }),
  );
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  expect(input).not.toBeNull();
  fireEvent.change(input as HTMLInputElement, { target: { files: [file] } });
  return user;
}

describe("importing from the Agents screen", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listPersonaSources.mockResolvedValue([reviewer]);
  });

  it("imports an agent whose name is free and says which one", async () => {
    mocks.importPersonas.mockResolvedValue([
      { id: "C:/Example/.flock/agents/scout.md", displayName: "Scout" },
    ] as Persona[]);

    const user = await pickInTheImportDialog(personaFile("Scout"));
    expect(await screen.findByText("preview of Scout")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Import agent" }));

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Imported agent "Scout".'),
    );
    expect(mocks.importPersonas).toHaveBeenCalledTimes(1);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("refuses an agent named after one that exists, before any preview", async () => {
    await pickInTheImportDialog(personaFile("reviewer"));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'The name "reviewer" is already taken by the agent "Reviewer". Rename or remove that agent, or change the name in the file.',
      ),
    );
    expect(screen.queryByText(/preview of/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Import agent" }),
    ).not.toBeInTheDocument();
    expect(mocks.importPersonas).not.toHaveBeenCalled();
  });

  it("refuses a name that was taken after the preview was shown", async () => {
    mocks.listPersonaSources.mockResolvedValueOnce([]);

    const user = await pickInTheImportDialog(personaFile("Reviewer"));
    expect(await screen.findByText("preview of Reviewer")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Import agent" }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringContaining('already taken by the agent "Reviewer"'),
      ),
    );
    expect(mocks.importPersonas).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("names both kinds when the file holds a skill or a project", async () => {
    await pickInTheImportDialog(
      jsonFile(
        {
          version: 1,
          type: "skill",
          name: "release-notes",
          description: "Writes notes",
          content: "Do it.",
        },
        "release-notes.skill.json",
      ),
    );

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "This file holds a skill, not an agent. Import it from Skills.",
      ),
    );
    expect(mocks.importPersonas).not.toHaveBeenCalled();
  });

  it("does not report an import that created nothing as a success", async () => {
    mocks.importPersonas.mockResolvedValue([]);

    const user = await pickInTheImportDialog(personaFile("Scout"));
    await screen.findByText("preview of Scout");
    await user.click(screen.getByRole("button", { name: "Import agent" }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Failed to import agent."),
    );
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("refuses an agent card under a taken name and adds it under a free one", async () => {
    const png = readFileSync(
      resolve(
        process.cwd(),
        "src/features/agents/agent-snapshot/fixtures/buzz-v1-config-only.agent.png",
      ),
    );
    const card = {
      name: "buzz.agent.png",
      type: "image/png",
      size: png.byteLength,
      arrayBuffer: async () =>
        png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength),
    } as unknown as File;
    URL.createObjectURL = vi.fn(() => "blob:card");
    URL.revokeObjectURL = vi.fn();
    mocks.createPersona.mockResolvedValue({
      id: "C:/Example/.flock/agents/buzz.md",
      displayName: "Buzz",
      systemPrompt: "x",
      isBuiltin: false,
      writable: true,
    });

    const user = await pickInTheImportDialog(card);
    await user.click(
      await screen.findByRole("button", { name: "Import agent" }),
    );
    const add = await screen.findByRole("button", {
      name: "add the agent from the image",
    });
    mocks.imageRequest.current = {
      displayName: "REVIEWER",
      systemPrompt: "MARKER-PERSONA",
    };
    await user.click(add);

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringContaining('already taken by the agent "Reviewer"'),
      ),
    );
    expect(mocks.createPersona).not.toHaveBeenCalled();

    // The dialog stays open, so the operator can give it another name.
    mocks.imageRequest.current = { displayName: "Buzz", systemPrompt: "x" };
    await user.click(add);

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        'Agent "Buzz" added from image.',
      ),
    );
    expect(mocks.createPersona).toHaveBeenCalledTimes(1);
  });
});
