import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type BackgroundTask,
  useBackgroundTasksStore,
} from "../../stores/backgroundTasksStore";
import { useChatStore } from "../../stores/chatStore";
import {
  BackgroundTaskList,
  BackgroundTasksPanel,
} from "../BackgroundTasksPanel";

vi.mock("@/shared/api/acpConnection", () => ({ getClient: vi.fn() }));
vi.mock("@/shared/lib/fileManager", () => ({
  revealInFileManager: vi.fn(async () => {}),
}));

const NOW = Date.UTC(2026, 10, 14, 18, 0, 0);
const MINUTE = 60_000;
const ago = (seconds: number) => NOW - seconds * 1000;

const packing: BackgroundTask = {
  id: "pack",
  taskType: "shell",
  state: "running",
  description: "Pack the example project",
  startedAt: ago(450),
  canStop: true,
};
const located: BackgroundTask = {
  id: "locate",
  taskType: "shell",
  state: "completed",
  description: "Locate the example files",
  startedAt: ago(400),
  endedAt: ago(359),
};
const built: BackgroundTask = {
  id: "build",
  taskType: "shell",
  state: "failed",
  description: "Build the example installer",
  summary: "Exit 1\nerror: linker not found",
  outputFilePath: "C:/example/tasks/build.output",
  startedAt: ago(300),
  endedAt: ago(170),
};
const wake = (id: string, started: number, ended?: number): BackgroundTask => ({
  id,
  taskType: "turn",
  name: "Claude is working",
  description: `A scheduled wakeup fired (set for ${new Date(ago(started)).toISOString()}).`,
  state: ended === undefined ? "running" : "completed",
  startedAt: ago(started),
  ...(ended === undefined ? { canStop: true } : { endedAt: ago(ended) }),
});

const lanes = () => screen.getAllByTestId("background-task-lane");
const laneStates = () => lanes().map((lane) => lane.getAttribute("data-state"));
const blocks = () => screen.getAllByTestId("background-task-block");
const percent = (value: string) => Number.parseFloat(value);

function freezeClock() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
}

describe("BackgroundTaskList", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("counts the work by state and gives each piece of it a lane, what still runs first", () => {
    freezeClock();
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
    expect(laneStates()).toEqual(["running", "failed", "completed"]);
    expect(lanes()[0]).toHaveTextContent("Pack the example project");
  });

  it("draws a run from its start to its end, and one still going up to now", () => {
    freezeClock();
    render(
      <BackgroundTaskList tasks={[located, packing]} onStop={async () => {}} />,
    );

    // The past shown is a quarter of an hour; a sixth of that again is kept
    // to the right of now for what is next.
    const span = 15 * MINUTE;
    const at = (time: number) => ((time - (NOW - span)) / (span * 1.16)) * 100;
    const [running, ended] = blocks();
    expect(running).toHaveAttribute("data-state", "running");
    expect(percent(running.style.left)).toBeCloseTo(at(ago(450)), 3);
    expect(
      percent(running.style.left) + percent(running.style.width),
    ).toBeCloseTo(at(NOW), 3);
    expect(running).toHaveAccessibleName(
      "Pack the example project: Running in background · 7m 30s",
    );
    expect(percent(ended.style.left)).toBeCloseTo(at(ago(400)), 3);
    expect(percent(ended.style.width)).toBeCloseTo(
      at(ago(359)) - at(ago(400)),
      3,
    );
    expect(screen.getByTestId("background-tasks-span")).toHaveTextContent(
      "Last 15m",
    );
  });

  it("joins the agent's wake-ups on one lane and says when the next one is", () => {
    freezeClock();
    render(
      <BackgroundTaskList
        tasks={[wake("w1", 7300, 7000), wake("w2", 3700, 3500), packing]}
        wakeup={{ at: NOW + 34 * MINUTE, reason: "checking the indexer" }}
        onStop={async () => {}}
      />,
    );

    const wakeups = lanes().find(
      (lane) => lane.getAttribute("data-lane") === "wakeups",
    );
    expect(wakeups).toHaveTextContent("Scheduled wake-ups×2");
    expect(
      screen.getByTestId("background-tasks-next-wakeup"),
    ).toHaveTextContent("next wake-up in 34m 00s");
    expect(screen.getByTestId("background-task-next-in")).toHaveTextContent(
      "in 34m 00s",
    );
    expect(screen.getByTestId("background-task-next")).toHaveAttribute(
      "title",
      expect.stringContaining("checking the indexer"),
    );
  });

  it("shows a wake-up that is scheduled before any work has been reported", () => {
    freezeClock();
    const { rerender, container } = render(
      <BackgroundTaskList
        tasks={[]}
        wakeup={{ at: NOW + 12 * MINUTE }}
        onStop={async () => {}}
      />,
    );
    expect(screen.getByTestId("background-tasks-toggle")).toHaveTextContent(
      "next wake-up in 12m 00s",
    );

    // A wake-up that has fired is no longer next.
    rerender(
      <BackgroundTaskList
        tasks={[]}
        wakeup={{ at: NOW - MINUTE }}
        onStop={async () => {}}
      />,
    );
    expect(container).toBeEmptyDOMElement();
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

  it("opens a run onto its whole result and its output file", async () => {
    freezeClock();
    const user = userEvent.setup();
    const onShowOutput = vi.fn(async () => {});
    render(
      <BackgroundTaskList
        tasks={[packing, built]}
        onStop={async () => {}}
        onShowOutput={onShowOutput}
      />,
    );

    expect(screen.queryByText(/error: linker not found/)).toBeNull();
    const failed = blocks().find(
      (block) => block.getAttribute("data-state") === "failed",
    ) as HTMLElement;
    await user.click(failed);

    expect(failed).toHaveAttribute("aria-pressed", "true");
    const detail = document.querySelector<HTMLElement>(
      "[data-role='background-task-detail']",
    ) as HTMLElement;
    expect(detail).toHaveTextContent("Build the example installer");
    expect(detail).toHaveTextContent("Failed");
    expect(within(detail).getByText(/error: linker not found/)).toBeVisible();

    await user.click(
      within(detail).getByRole("button", { name: "Show output file" }),
    );
    expect(onShowOutput).toHaveBeenCalledWith("C:/example/tasks/build.output");

    await user.click(within(detail).getByRole("button", { name: "Close" }));
    expect(screen.queryByText(/error: linker not found/)).toBeNull();
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
    useChatStore.setState({ messagesBySession: {} });
  });

  it("clears what has ended and keeps what still runs", async () => {
    const user = userEvent.setup();
    useBackgroundTasksStore.setState({
      bySession: { chat: [packing, located, built] },
    });
    render(<BackgroundTasksPanel sessionId="chat" />);
    expect(lanes()).toHaveLength(3);

    await user.click(
      screen.getByRole("button", { name: "Clear finished tasks" }),
    );

    expect(laneStates()).toEqual(["running"]);
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
    await waitFor(() => expect(laneStates()).toEqual(["completed"]));
    expect(screen.getByText("Pack the example")).toBeInTheDocument();
  });

  it("reads the next wake-up from the agent's own call in the transcript", () => {
    const startedAt = Date.now();
    useChatStore.setState({
      messagesBySession: {
        chat: [
          {
            id: "turn",
            role: "assistant",
            created: startedAt,
            content: [
              {
                type: "toolRequest",
                id: "wake",
                name: "ScheduleWakeup",
                toolName: "ScheduleWakeup",
                arguments: { delaySeconds: 3600, reason: "watching the run" },
                status: "completed",
                startedAt,
              },
            ],
          },
        ],
      },
    });
    render(<BackgroundTasksPanel sessionId="chat" />);

    const next = screen.getByTestId("background-tasks-next-wakeup");
    expect(next).toHaveTextContent(/next wake-up in (59m \d\ds|1h 00m)/);
    expect(next).toHaveAttribute(
      "title",
      expect.stringContaining("watching the run"),
    );
  });

  it("shows nothing for a chat with no background work", () => {
    const { container } = render(<BackgroundTasksPanel sessionId="quiet" />);
    expect(container).toBeEmptyDOMElement();
  });
});
