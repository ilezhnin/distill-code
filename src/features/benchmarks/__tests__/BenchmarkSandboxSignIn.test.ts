import { expect, it } from "vitest";
import { sandboxSignInOffer } from "../ui/BenchmarkSandboxSignIn";

it("offers the sandbox sign-in only when the sandbox is known to lack it", () => {
  const state = (
    required: boolean,
    signedIn: boolean | null,
    open = false,
  ) => ({
    required,
    signedIn,
    open,
  });
  // Not yet known, or a provider that signs in in Flock: nothing to offer.
  expect(sandboxSignInOffer(null)).toBe("none");
  expect(sandboxSignInOffer(state(false, null))).toBe("none");
  expect(sandboxSignInOffer(state(false, false))).toBe("none");
  // The sandbox could not be checked: its setup prompt speaks instead.
  expect(sandboxSignInOffer(state(true, null))).toBe("none");
  expect(sandboxSignInOffer(state(true, true))).toBe("none");
  expect(sandboxSignInOffer(state(true, false))).toBe("signIn");
  // An open window is waited for, whatever was observed before it.
  expect(sandboxSignInOffer(state(true, null, true))).toBe("waiting");
  expect(sandboxSignInOffer(state(true, false, true))).toBe("waiting");
});
