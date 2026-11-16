import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type BackgroundTask,
  useBackgroundTasksStore,
} from "../../stores/backgroundTasksStore";
import {
  BackgroundTaskList,
  BackgroundTasksPanel,
} from "../BackgroundTasksPanel";

vi.mock("@/shared/api/acpConnection", () => ({ getClient: vi.fn() }));
vi.mock("@/shared/lib/fileManager", () => ({
  revealInFileManager: vi.fn(async () => {}),
}));

const NOW = Date.UTC(2026, 10, 14, 18, 0, 0);
const ago = (seconds: number) => NOW - seconds * 1000;

const packing: BackgroundTask = {
  id: "pack",
  state: "running",
  description: "Pack the example project",
  startedAt: ago(134),
  canStop: true,
};
const located: BackgroundTask = {
  id: "locate",
  state: "completed",
  description: "Locate the example files",
  startedAt: ago(400),
  endedAt: ago(359),
};
const built: BackgroundTask = {
  id: "build",
  state: "failed",
  description: "Build the example installer",
  summary: "Exit 1\nerror: linker not found",
  outputFilePath: "C:/example/tasks/build.output",
  startedAt: ago(300),
  endedAt: ago(170),
};

const rowTitles = () =>
  screen
    .getAllByTestId("background-task-row")
    .map((row) => row.getAttribute("data-state"));

describe("BackgroundTaskList", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("counts the work by state and lists what still runs first, then the latest end", () => {
    render(
      <BackgroundTaskList
        tasks={[located, built, packing]}
        onStop={async () => {}}
      />,
    );

    const toggle = screen.getByTestId("background-tasks-toggle");
    expect(toggle).toHaveTextContent(
      "Background tasks1 running · 1 failed · 1 done",
    );
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(rowTitles()).toEqual(["running", "failed", "completed"]);
  });

  it("times a running task to now and an ended one to its end", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    render(
      <BackgroundTaskList tasks={[located, packing]} onStop={async () => {}} />,
    );

    const [running, ended] = screen.getAllByTestId("background-task-row");
    expect(running).toHaveTextContent("2m 14s");
    expect(ended).toHaveTextContent("41s");
  });

  it("folds once everything has ended and still says how it went", async () => {
    const user = userEvent.setup();
    render(
      <BackgroundTaskList tasks={[located, built]} onStop={async () => {}} />,
    );

    const toggle = screen.getByTestId("background-tasks-toggle");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveTextContent("1 failed · 1 done");

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
  });

  it("opens a row onto its whole result and its output file", async () => {
    const user = userEvent.setup();
    const onShowOutput = vi.fn(async () => {});
    render(
      <BackgroundTaskList
        tasks={[packing, built]}
        onStop={async () => {}}
        onShowOutput={onShowOutput}
      />,
    );

    const [running, failed] = screen.getAllByTestId("background-task-row");
    // Nothing is behind a task that has neither a result nor an output file.
    expect(within(running).queryByRole("button", { name: /Pack/ })).toBeNull();
    expect(within(failed).getByText("Exit 1")).toBeInTheDocument();

    const open = within(failed).getByRole("button", {
      name: "Build the example installer",
    });
    await user.click(open);
    expect(open).toHaveAttribute("aria-expanded", "true");
    expect(within(failed).getByText(/error: linker not found/)).toBeVisible();

    await user.click(
      within(failed).getByRole("button", { name: "Show output file" }),
    );
    expect(onShowOutput).toHaveBeenCalledWith("C:/example/tasks/build.output");
  });

  it("stops a running task and says so when the request fails", async () => {
    const user = userEvent.setup();
    const onStop = vi.fn(async () => {
      throw new Error("offline");
    });
    render(<BackgroundTaskList tasks={[packing, located]} onStop={onStop} />);

    expect(screen.getAllByRole("button", { name: "Stop" })).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Stop" }));

    expect(onStop).toHaveBeenCalledWith("pack");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not stop the task. Try again.",
    );
  });
});

describe("BackgroundTasksPanel", () => {
  beforeEach(() => {
    useBackgroundTasksStore.setState({ bySession: {}, dismissedBySession: {} });
  });

  it("clears what has ended and keeps what still runs", async () => {
    const user = userEvent.setup();
    useBackgroundTasksStore.setState({
      bySession: { chat: [packing, located, built] },
    });
    render(<BackgroundTasksPanel sessionId="chat" />);
    expect(screen.getAllByTestId("background-task-row")).toHaveLength(3);

    await user.click(
      screen.getByRole("button", { name: "Clear finished tasks" }),
    );

    expect(rowTitles()).toEqual(["running"]);
    expect(
      screen.queryByRole("button", { name: "Clear finished tasks" }),
    ).toBeNull();

    // The host reports the whole list again; what was cleared stays cleared,
    // and a task that ends after the clearing is shown.
    useBackgroundTasksStore.getState().replace("chat", [
      { id: "pack", state: "completed", description: "Pack the example" },
      { id: "locate", state: "completed" },
      { id: "build", state: "failed" },
    ]);
    await waitFor(() => expect(rowTitles()).toEqual(["completed"]));
    expect(screen.getByText("Pack the example")).toBeInTheDocument();
  });

  it("shows nothing for a chat with no background work", () => {
    const { container } = render(<BackgroundTasksPanel sessionId="quiet" />);
    expect(container).toBeEmptyDOMElement();
  });
});
