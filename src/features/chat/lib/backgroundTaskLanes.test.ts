import { describe, expect, it } from "vitest";
import type { Message, MessageContent } from "@/shared/types/messages";
import type { BackgroundTask } from "../stores/backgroundTasksStore";
import {
  buildTaskLanes,
  fitTimelineSpan,
  formatAxisDistance,
  laneHead,
  laneRuns,
  latestScheduledWakeup,
  timelineTicks,
} from "./backgroundTaskLanes";

const NOW = Date.UTC(2026, 10, 14, 18, 0, 0);
const MINUTE = 60_000;
const ago = (minutes: number) => NOW - minutes * MINUTE;

function task(
  id: string,
  rest: Partial<BackgroundTask> & Pick<BackgroundTask, "state">,
): BackgroundTask {
  return { id, taskType: "shell", ...rest };
}
const wake = (id: string, started: number, ended?: number) =>
  task(id, {
    taskType: "turn",
    name: "Claude is working",
    description: `A scheduled wakeup fired (set for ${new Date(ago(started)).toISOString()}).`,
    state: ended === undefined ? "running" : "completed",
    startedAt: ago(started),
    ...(ended === undefined ? {} : { endedAt: ago(ended) }),
  });

describe("buildTaskLanes", () => {
  it("keeps a command's reruns and the agent's turns over its results on one lane", () => {
    const lanes = buildTaskLanes([
      task("turn-2", {
        taskType: "turn",
        state: "running",
        description:
          'Background command "Build the "example" installer" completed (exit code 0)',
        startedAt: ago(2),
      }),
      task("build-2", {
        state: "completed",
        description: 'Build the "example" installer',
        startedAt: ago(9),
        endedAt: ago(2),
      }),
      task("build-1", {
        state: "failed",
        description: 'Build the "example" installer',
        startedAt: ago(20),
        endedAt: ago(15),
      }),
    ]);

    expect(lanes).toHaveLength(1);
    const [lane] = lanes;
    expect(lane.kind).toBe("work");
    expect(lane.title).toBe('Build the "example" installer');
    expect(lane.blocks.map((block) => block.task.id)).toEqual([
      "build-1",
      "build-2",
      "turn-2",
    ]);
    // The turn is the agent's, not a third run of the command; while it is
    // still going it is what the lane is read by.
    expect(laneRuns(lane).map((block) => block.task.id)).toEqual([
      "build-1",
      "build-2",
    ]);
    expect(laneHead(lane)?.task.id).toBe("turn-2");
  });

  it("gives the wake-ups a lane of their own, and the agent's other turns another", () => {
    const lanes = buildTaskLanes([
      wake("wake-1", 120, 115),
      wake("wake-2", 60, 55),
      task("stray", {
        taskType: "turn",
        state: "completed",
        description: 'Background command "A cleared command" completed',
        startedAt: ago(30),
        endedAt: ago(29),
      }),
    ]);

    expect(lanes.map((lane) => lane.kind)).toEqual(["agent", "wakeups"]);
    expect(lanes[1].blocks.map((block) => block.task.id)).toEqual([
      "wake-1",
      "wake-2",
    ]);
  });

  it("lists what still runs first, longest-running on top, then the latest to end", () => {
    const lanes = buildTaskLanes([
      task("ended-early", {
        state: "completed",
        description: "Format",
        startedAt: ago(50),
        endedAt: ago(40),
      }),
      task("young", {
        state: "running",
        description: "Serve",
        startedAt: ago(5),
      }),
      task("ended-late", {
        state: "stopped",
        description: "Tail",
        startedAt: ago(30),
        endedAt: ago(10),
      }),
      task("old", {
        state: "running",
        description: "Index",
        startedAt: ago(84),
      }),
    ]);

    expect(lanes.map((lane) => lane.title)).toEqual([
      "Index",
      "Serve",
      "Tail",
      "Format",
    ]);
  });
});

describe("latestScheduledWakeup", () => {
  const message = (content: MessageContent[], created = ago(10)): Message => ({
    id: `m-${created}-${content.length}`,
    role: "assistant",
    created,
    content,
  });
  const call = (
    id: string,
    args: Record<string, unknown>,
    startedAt: number,
  ): MessageContent => ({
    type: "toolRequest",
    id,
    name: "ScheduleWakeup",
    toolName: "ScheduleWakeup",
    arguments: args,
    status: "completed",
    startedAt,
  });
  const answer = (
    id: string,
    result: string,
    isError = false,
  ): MessageContent => ({
    type: "toolResponse",
    id,
    name: "ScheduleWakeup",
    result,
    isError,
  });

  it("reads the moment from the tool's answer and settles it on the minute", () => {
    // Called 45 s before the minute it was asked to wait from.
    const startedAt = ago(1) + 15_000;
    const wakeup = latestScheduledWakeup([
      message([
        call(
          "w1",
          { delaySeconds: 3600, reason: " watching the build " },
          startedAt,
        ),
        answer(
          "w1",
          "Next wakeup scheduled for 18:59:00 (in 3583s). End the turn.",
        ),
      ]),
    ]);

    expect(wakeup).toEqual({
      at: NOW + 59 * MINUTE,
      reason: "watching the build",
    });
  });

  it("stands on the call's own delay until the tool has answered", () => {
    expect(
      latestScheduledWakeup([
        message([{ type: "text", text: "Scheduling." }]),
        message([call("w1", { delaySeconds: 270 }, NOW)]),
      ]),
    ).toEqual({ at: NOW + 270_000 });
  });

  it("has none once the loop is ended, the call failed, or none was made", () => {
    const scheduled = message([
      call("w1", { delaySeconds: 600 }, ago(5)),
      answer("w1", "Next wakeup scheduled for 18:05:00 (in 600s)."),
    ]);
    expect(
      latestScheduledWakeup([
        scheduled,
        message([call("w2", { stop: true }, ago(1))]),
      ]),
    ).toBeNull();
    expect(
      latestScheduledWakeup([
        message([
          call("w3", { delaySeconds: 600 }, ago(1)),
          answer("w3", "delaySeconds is out of range", true),
        ]),
      ]),
    ).toBeNull();
    expect(
      latestScheduledWakeup([message([{ type: "text", text: "Done." }])]),
    ).toBeNull();
    expect(latestScheduledWakeup(undefined)).toBeNull();
  });
});

describe("the timeline's span", () => {
  it("fits what still runs from its start and never less than a quarter of an hour", () => {
    const lanes = (minutes: number, state: BackgroundTask["state"]) =>
      buildTaskLanes([
        task("t", {
          state,
          description: "Index",
          startedAt: ago(minutes),
          ...(state === "running" ? {} : { endedAt: ago(1) }),
        }),
      ]);

    expect(fitTimelineSpan(lanes(3, "running"), NOW)).toBe(15 * MINUTE);
    expect(fitTimelineSpan(lanes(84, "running"), NOW)).toBe(180 * MINUTE);
    // What has ended may leave the left edge.
    expect(fitTimelineSpan(lanes(600, "completed"), NOW)).toBe(15 * MINUTE);
    expect(fitTimelineSpan(lanes(5000, "running"), NOW)).toBe(1440 * MINUTE);
  });

  it("marks the axis at no more than six distances back from now", () => {
    expect(timelineTicks(15 * MINUTE).map(formatAxisDistance)).toEqual([
      "5m",
      "10m",
    ]);
    expect(timelineTicks(180 * MINUTE).map(formatAxisDistance)).toEqual([
      "30m",
      "1h",
      "1h 30m",
      "2h",
      "2h 30m",
    ]);
    expect(timelineTicks(1440 * MINUTE).map(formatAxisDistance)).toEqual([
      "4h",
      "8h",
      "12h",
      "16h",
      "20h",
    ]);
  });
});
