import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";

import { ModelRankingField } from "../ModelRankingField";

if (!HTMLElement.prototype.hasPointerCapture) {
  HTMLElement.prototype.hasPointerCapture = () => false;
}

describe("ModelRankingField", () => {
  it("survives the operator typing a name that is an Object.prototype member", () => {
    // The field derives the role class from the live name field while the
    // operator is still typing. "Constructor" slugs to `constructor`, which a
    // plain-object lookup used to find on the prototype — and the builder
    // crashed on the keystroke.
    for (const displayName of ["Constructor", "ToString", "__proto__"]) {
      const { unmount } = renderWithProviders(
        <ModelRankingField
          value=""
          onChange={vi.fn()}
          displayName={displayName}
        />,
      );
      expect(screen.getByTestId("model-ranking-field")).toBeTruthy();
      expect(screen.queryByTestId("model-ranking-fill")).toBeNull();
      unmount();
    }
  });
});
