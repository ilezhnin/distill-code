import { describe, expect, it } from "vitest";
import { automationCommandSyntax, parseGoalCommand } from "./commands";
import { parseLoopCommand } from "./loopCommands";

describe("control words of /goal and /loop", () => {
  it("control: lower-case control words are controls", () => {
    expect(parseGoalCommand("pause")).toEqual({ action: "pause" });
    expect(parseGoalCommand("resume")).toEqual({ action: "resume" });
    expect(parseGoalCommand("clear")).toEqual({ action: "clear" });
    expect(parseGoalCommand("status")).toEqual({ action: "status" });
    expect(parseLoopCommand("stop 1")).toEqual({ action: "stop", number: 1 });
    expect(parseLoopCommand("stop all")).toEqual({ action: "stop" });
    expect(parseLoopCommand("pause")).toEqual({ action: "pause" });
    expect(parseLoopCommand("list")).toEqual({ action: "list" });
  });

  it("the command name is case-insensitive", () => {
    expect(automationCommandSyntax("/GOAL Pause")).toEqual({
      name: "goal",
      args: "Pause",
    });
  });

  it("a capitalised or spaced control word is the same control, not a new objective or loop", () => {
    expect({
      goalPause: parseGoalCommand("Pause"),
      goalClear: parseGoalCommand("Clear"),
      goalResume: parseGoalCommand(" RESUME "),
      goalStatus: parseGoalCommand("Status"),
      loopStop: parseLoopCommand("Stop 1"),
      loopStopSpaced: parseLoopCommand("  stop   2 "),
      loopStopAll: parseLoopCommand("STOP All"),
      loopPause: parseLoopCommand("Pause"),
      loopResume: parseLoopCommand("Resume 3"),
      loopList: parseLoopCommand("List"),
    }).toEqual({
      goalPause: { action: "pause" },
      goalClear: { action: "clear" },
      goalResume: { action: "resume" },
      goalStatus: { action: "status" },
      loopStop: { action: "stop", number: 1 },
      loopStopSpaced: { action: "stop", number: 2 },
      loopStopAll: { action: "stop" },
      loopPause: { action: "pause" },
      loopResume: { action: "resume", number: 3 },
      loopList: { action: "list" },
    });
  });

  it("control: an objective that only starts with a control word stays an objective", () => {
    expect(parseGoalCommand("pause the build when tests fail")).toMatchObject({
      action: "set",
      objective: "pause the build when tests fail",
    });
    expect(parseGoalCommand("Clear the cache --max-turns 3")).toMatchObject({
      action: "set",
      objective: "Clear the cache",
      maxTurns: 3,
    });
  });
});
