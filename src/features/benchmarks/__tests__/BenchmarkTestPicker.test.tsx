import { useState } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { BenchmarkTestPicker } from "../ui/BenchmarkTestPicker";
import { definition } from "./fixtures";

afterEach(cleanup);

it("keeps exact selections across grouped search without exposing row metadata", async () => {
  const user = userEvent.setup();
  const changed = vi.fn();
  const versions = [
    {
      ...definition.versions[0],
      id: "train-1",
      contentHash: "private-hash-one",
      manifest: {
        ...definition.draft,
        name: "Integer transformation (selector evaluation v1)",
        split: "train",
      },
    },
    {
      ...definition.versions[0],
      id: "held-1",
      contentHash: "private-hash-two",
      manifest: {
        ...definition.draft,
        name: "Independent transformation",
        split: "held_out",
      },
    },
    {
      ...definition.versions[0],
      id: "dev-1",
      contentHash: "private-hash-three",
      manifest: {
        ...definition.draft,
        name: "Development example",
        split: "development",
      },
    },
  ];
  function Picker() {
    const [selected, setSelected] = useState<string[]>([]);
    return (
      <BenchmarkTestPicker
        versions={versions}
        selectedIds={selected}
        disabled={false}
        onChange={(ids) => {
          changed(ids);
          setSelected(ids);
        }}
      />
    );
  }
  render(<Picker />);
  expect(
    screen.getByRole("checkbox", { name: "Integer transformation" }),
  ).not.toBeChecked();
  expect(screen.queryByText("private-hash-one")).not.toBeInTheDocument();
  expect(screen.queryByText(/selector evaluation/)).not.toBeInTheDocument();
  await user.click(
    screen.getByRole("checkbox", { name: "Integer transformation" }),
  );
  await user.type(
    screen.getByRole("searchbox", { name: "Search tests" }),
    "Independent",
  );
  expect(
    screen.queryByRole("checkbox", { name: "Integer transformation" }),
  ).not.toBeInTheDocument();
  await user.click(
    screen.getByRole("checkbox", { name: "Select all: Held-out evaluation" }),
  );
  expect(changed).toHaveBeenLastCalledWith(["train-1", "held-1"]);
  await user.clear(screen.getByRole("searchbox", { name: "Search tests" }));
  expect(
    screen.getByRole("checkbox", { name: "Integer transformation" }),
  ).toBeChecked();
  await user.click(
    screen.getByRole("checkbox", { name: "Select all: Training" }),
  );
  expect(changed).toHaveBeenLastCalledWith(["held-1"]);
});

it("distinguishes published versions with the same compact name and locks preview selection", async () => {
  const user = userEvent.setup();
  const changed = vi.fn();
  const versions = [1, 2].map((number) => ({
    ...definition.versions[0],
    id: `version-${number}`,
    publishedAt: number,
    manifest: {
      ...definition.draft,
      name: `Integer transformation (selector evaluation v${number})`,
    },
  }));
  const { rerender } = render(
    <BenchmarkTestPicker
      versions={versions}
      selectedIds={[]}
      disabled={false}
      onChange={changed}
    />,
  );
  await user.click(
    screen.getByRole("checkbox", { name: "Integer transformation Version 2" }),
  );
  expect(changed).toHaveBeenLastCalledWith(["version-2"]);
  rerender(
    <BenchmarkTestPicker
      versions={versions}
      selectedIds={["version-2"]}
      disabled
      onChange={changed}
    />,
  );
  expect(
    screen.getByRole("checkbox", { name: "Integer transformation Version 2" }),
  ).toBeChecked();
  for (const checkbox of screen.getAllByRole("checkbox"))
    expect(checkbox).toBeDisabled();
});
