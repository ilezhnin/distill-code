import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef, type ComponentProps } from "react";
import type { ModelOption } from "../../types";
import {
  ModelList,
  MoreModelList,
  type ModelListHandle,
} from "../AgentModelPickerLists";
import {
  CLAUDE_PROVIDER_ID,
  CODEX_PROVIDER_ID,
  claudeModels,
  codexModels,
  modelRow,
  modelRowLabels,
  moreModelsRow,
} from "./modelPickerFixtures";

afterEach(() => {
  cleanup();
});

/** The Claude rows without the `default` alias, which the picker hides first. */
const claudeRowsShown = claudeModels.filter((model) => model.id !== "default");

function renderModelList(
  props: Partial<ComponentProps<typeof ModelList>> & {
    models: ModelOption[];
  },
) {
  const ref = createRef<ModelListHandle>();
  const onMoreOpenChange = vi.fn();
  const result = render(
    <div data-col="model">
      <ModelList
        ref={ref}
        currentModelId={null}
        currentModelProviderId={CLAUDE_PROVIDER_ID}
        moreOpen={false}
        onMoreOpenChange={onMoreOpenChange}
        onModelSelect={vi.fn()}
        {...props}
      />
    </div>,
  );
  return { ...result, ref, onMoreOpenChange };
}

describe("ModelList", () => {
  it("orders the main page by the harness menu order, never by what is selected", () => {
    renderModelList({
      models: [...claudeRowsShown].reverse(),
      currentModelId: "haiku",
    });

    expect(modelRowLabels("model")).toEqual([
      "Fable 5.1",
      "Opus 5",
      "Sonnet 5",
      "Haiku 4.5",
    ]);
  });

  it("puts a row the harness filed under no group on the main page", () => {
    renderModelList({
      models: [
        ...claudeRowsShown,
        {
          id: "claude-next",
          name: "Claude Next",
          providerId: CLAUDE_PROVIDER_ID,
        },
      ],
    });

    expect(modelRowLabels("model")).toContain("Claude Next");
  });

  it("shows no More models row when the harness files every row main", () => {
    renderModelList({
      models: codexModels,
      currentModelProviderId: CODEX_PROVIDER_ID,
    });

    expect(moreModelsRow()).toBeNull();
  });

  it("carries the check and the name of a selected older model on the More models row", () => {
    renderModelList({
      models: claudeRowsShown,
      currentModelId: "claude-opus-4-7",
    });

    const row = moreModelsRow();
    expect(row).toHaveTextContent("More models");
    expect(row).toHaveTextContent("Opus 4.7");
    // The selected row itself is on the other page; this row only points at it.
    expect(row).not.toHaveAttribute("data-selected");
  });

  it("offers search once both pages together exceed eight rows, and searches their flat union", async () => {
    const user = userEvent.setup();
    renderModelList({ models: claudeRowsShown });

    await user.click(screen.getByRole("button", { name: "Search models..." }));
    await user.keyboard("opus");

    expect(modelRowLabels("model")).toEqual([
      "Opus 5",
      "Opus 4.8",
      "Opus 4.7",
      "Opus 4.6",
    ]);
    expect(moreModelsRow()).toBeNull();
  });

  it("offers no search for a list of eight rows or fewer", () => {
    renderModelList({
      models: codexModels,
      currentModelProviderId: CODEX_PROVIDER_ID,
    });

    expect(
      screen.queryByRole("button", { name: "Search models..." }),
    ).toBeNull();
  });

  it("closes the More models page as its overlay, and reports false when nothing was open", () => {
    const open = renderModelList({ models: claudeRowsShown, moreOpen: true });
    expect(open.ref.current?.closeOverlay()).toBe(true);
    expect(open.onMoreOpenChange).toHaveBeenCalledWith(false);
    open.unmount();

    const closed = renderModelList({ models: claudeRowsShown });
    expect(closed.ref.current?.closeOverlay()).toBe(false);
    expect(closed.onMoreOpenChange).not.toHaveBeenCalled();
  });
});

describe("MoreModelList", () => {
  it("disables rows that reopen the session while a turn runs, except the selected one", () => {
    render(
      <div data-col="more">
        <MoreModelList
          models={claudeRowsShown}
          currentModelId="claude-opus-4-8"
          currentModelProviderId={CLAUDE_PROVIDER_ID}
          runActive
          hidden={false}
          onBack={vi.fn()}
          onModelSelect={vi.fn()}
        />
      </div>,
    );

    expect(modelRow("more", "Opus 4.8")).toBeEnabled();
    expect(modelRow("more", "Opus 4.7")).toBeDisabled();
    expect(modelRow("more", "Fable 5")).toBeEnabled();
  });

  it("returns to the main page from its Back row", async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    render(
      <div data-col="more">
        <MoreModelList
          models={claudeRowsShown}
          currentModelId={null}
          currentModelProviderId={CLAUDE_PROVIDER_ID}
          hidden={false}
          onBack={onBack}
          onModelSelect={vi.fn()}
        />
      </div>,
    );

    await user.click(screen.getByRole("button", { name: "Back" }));

    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
