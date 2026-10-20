import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { isRefusal } from "../api/benchmarks";
import { BenchmarkAlert } from "../ui/BenchmarkPrimitives";

afterEach(cleanup);

it("reads an error in the destructive tone and a warning in the warning tone", () => {
  render(
    <>
      <BenchmarkAlert>failed</BenchmarkAlert>
      <BenchmarkAlert tone="warning">refused for now</BenchmarkAlert>
    </>,
  );
  const [error, warning] = screen.getAllByRole("alert");
  expect(error).toHaveTextContent("failed");
  expect(error.className).toContain("text-destructive");
  expect(warning).toHaveTextContent("refused for now");
  expect(warning.className).toContain("text-warning");
  expect(warning.className).not.toContain("text-destructive");
});

it("tells a sandbox refusal from a failure by its code", () => {
  expect(
    isRefusal({
      code: "resource_busy",
      message:
        "measured CPU load is above the light-job admission line; no provider process started",
    }),
  ).toBe(true);
  expect(
    isRefusal({ code: "infrastructure_failure", message: "bridge exited" }),
  ).toBe(false);
  expect(isRefusal(new Error("bridge exited"))).toBe(false);
  expect(isRefusal(null)).toBe(false);
});
