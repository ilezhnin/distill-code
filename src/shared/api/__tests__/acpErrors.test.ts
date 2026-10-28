import { describe, expect, it } from "vitest";
import { formatAcpErrorMessage, isProviderNotSetError } from "../acpErrors";

describe("formatAcpErrorMessage", () => {
  it("shows the provider's failure title without exposing transport metadata", () => {
    const title =
      "Selected model is at capacity. Please try a different model.";
    const error = {
      message: "Internal error",
      data: {
        accountId: "fixture-account",
        dispatchStarted: true,
        promptNotAccepted: false,
        errorKind: "provider_failure",
        sessionFailure: {
          title,
          severity: "error",
          category: "service",
          actions: ["retry"],
        },
      },
    };
    const original = structuredClone(error);
    expect(formatAcpErrorMessage(error)).toBe(title);
    expect(error).toEqual(original);
  });

  it.each([
    [new Error("Connection closed"), "Connection closed"],
    ["  Connection closed  ", "Connection closed"],
    [
      { message: "Internal error", data: " Provider not set " },
      "Provider not set",
    ],
    [
      { message: "Internal error", data: { message: " Service unavailable " } },
      "Service unavailable",
    ],
    [
      { message: "Connection closed", data: { accountId: "fixture-account" } },
      "Connection closed",
    ],
    [
      {
        message: "Connection closed",
        data: { sessionFailure: { title: " " } },
      },
      "Connection closed",
    ],
    [{ data: { accountId: "fixture-account" } }, "Fallback"],
    [{ data: 42 }, "Fallback"],
    [null, "Fallback"],
  ])("extracts readable text from %j", (error, expected) => {
    expect(formatAcpErrorMessage(error, "Fallback")).toBe(expected);
  });

  it("does not serialize cyclic diagnostic data", () => {
    const error = { message: "Connection closed", data: {} };
    error.data = error;
    expect(formatAcpErrorMessage(error)).toBe("Connection closed");
  });

  it("preserves provider recovery without matching diagnostic metadata", () => {
    expect(isProviderNotSetError({ data: "Provider not set" })).toBe(true);
    expect(
      isProviderNotSetError(new Error("Provider not set up correctly")),
    ).toBe(false);
    expect(
      isProviderNotSetError({
        message: "Connection closed",
        data: { debug: "Provider not set" },
      }),
    ).toBe(false);
  });
});
