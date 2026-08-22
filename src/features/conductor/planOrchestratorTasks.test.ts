import { describe, expect, it } from "vitest";
import { planOrchestratorTasks } from "./planOrchestratorTasks";

describe("planOrchestratorTasks", () => {
  it("keeps a single request as one orchestrator task", () => {
    expect(planOrchestratorTasks("Fix the login button")).toEqual([
      "Fix the login button",
    ]);
  });

  it("splits numbered operator lists into parallel tasks", () => {
    expect(
      planOrchestratorTasks(
        "Please do both:\n1. Fix the login button\n2. Add a logout test",
      ),
    ).toEqual(["Fix the login button", "Add a logout test"]);
  });
});
