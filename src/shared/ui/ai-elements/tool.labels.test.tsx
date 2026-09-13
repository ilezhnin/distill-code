import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { i18n } from "@/shared/i18n";
import { Tool, ToolHeader, ToolInput, ToolOutput } from "./tool";

// Tool cards are the densest text in the transcript, and every label here used
// to be an English literal — so a Spanish UI showed "Running"/"Pending" on an
// in-progress card and "Parameters"/"Result" inside it.
describe("tool card labels", () => {
  it("translates the status badge", () => {
    render(
      <Tool>
        <ToolHeader
          type="dynamic-tool"
          toolName="shell"
          state="input-available"
          title="shell"
        />
      </Tool>,
    );

    expect(screen.getByText("Running")).toBeInTheDocument();
  });

  it("translates the status badge into the active locale", async () => {
    await i18n.changeLanguage("es");
    render(
      <Tool>
        <ToolHeader
          type="dynamic-tool"
          toolName="shell"
          state="input-available"
          title="shell"
        />
      </Tool>,
    );

    expect(screen.getByText("En ejecución")).toBeInTheDocument();
    expect(screen.queryByText("Running")).toBeNull();
  });

  it("translates the elapsed-time suffix", () => {
    render(
      <Tool>
        <ToolHeader
          type="dynamic-tool"
          toolName="shell"
          state="input-available"
          title="shell"
          elapsedSeconds={7}
        />
      </Tool>,
    );

    expect(screen.getByText("7s")).toBeInTheDocument();
  });

  it("translates the default input label", async () => {
    // The label shows twice: as the section heading and as the collapsed
    // summary.
    const { unmount } = render(<ToolInput input={{ command: "pnpm test" }} />);
    expect(screen.getAllByText("Parameters")).toHaveLength(2);
    unmount();

    await i18n.changeLanguage("es");
    render(<ToolInput input={{ command: "pnpm test" }} />);
    expect(screen.getAllByText("Parámetros")).toHaveLength(2);
  });

  it("keeps an explicit input label", () => {
    render(<ToolInput input={{ command: "pnpm test" }} label="Command" />);

    expect(screen.getAllByText("Command")).toHaveLength(2);
    expect(screen.queryByText("Parameters")).toBeNull();
  });

  it("translates the default output label", async () => {
    const { unmount } = render(
      <ToolOutput output="done" errorText={undefined} />,
    );
    expect(screen.getByText("Result")).toBeInTheDocument();
    unmount();

    await i18n.changeLanguage("es");
    render(<ToolOutput output="done" errorText={undefined} />);
    expect(screen.getByText("Resultado")).toBeInTheDocument();
  });

  it("translates the default output label for a failure", async () => {
    await i18n.changeLanguage("es");
    render(<ToolOutput output={undefined} errorText="boom" />);

    // The Spanish word for the error label is the same, so assert the key
    // resolved at all rather than a distinct spelling.
    expect(screen.getByText("Error")).toBeInTheDocument();
    expect(screen.queryByText("Resultado")).toBeNull();
  });
});
