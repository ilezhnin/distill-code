import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ProviderAccount,
  ProviderAccountsSnapshot,
  ProviderAccountStatus,
} from "../api/providerAccounts";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  statuses: vi.fn(),
  setDefault: vi.fn(),
  add: vi.fn(),
  remove: vi.fn(),
  auth: vi.fn(),
  cancelAuth: vi.fn(),
  signOut: vi.fn(),
  invalidate: vi.fn(),
  refreshModels: vi.fn(),
}));
vi.mock("../api/providerAccounts", () => ({
  listProviderAccounts: mocks.list,
  getProviderAccountStatuses: mocks.statuses,
  setDefaultProviderAccount: mocks.setDefault,
  addProviderAccount: mocks.add,
  removeProviderAccount: mocks.remove,
  authenticateProviderAccount: mocks.auth,
  cancelProviderAccountAuthentication: mocks.cancelAuth,
  signOutProviderAccount: mocks.signOut,
}));
vi.mock("./providerModelCacheStore", () => ({
  useProviderModelCacheStore: {
    getState: () => ({
      invalidateProvider: mocks.invalidate,
      refreshProviderModels: mocks.refreshModels,
    }),
  },
}));
import { useProviderAccountsStore } from "./providerAccountsStore";

const now = Date.now();
const account: ProviderAccount = {
  id: "saved",
  providerId: "codex-acp",
  label: "Personal",
  authMethod: "oauth",
  enabled: true,
  autoSwitch: true,
  createdAt: now,
  updatedAt: now,
};
const snapshot: ProviderAccountsSnapshot = {
  accounts: [account],
  defaults: { "codex-acp": account.id },
  automaticSwitching: { "codex-acp": false },
};
const status: ProviderAccountStatus = {
  accountId: account.id,
  providerId: account.providerId,
  state: "ready",
  subscription: "Pro",
  accountLabel: "person@example.test",
  limits: [],
  resetTokens: null,
  credits: null,
  lastUpdatedAt: now,
  lastAttemptAt: now,
  stale: false,
  error: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  useProviderAccountsStore.setState({
    accounts: [],
    defaults: {},
    automaticSwitching: {},
    statuses: {},
    authStates: {},
    loaded: false,
    refreshing: false,
    error: null,
  });
  mocks.list.mockResolvedValue(snapshot);
  mocks.statuses.mockResolvedValue({ accounts: [status], updatedAt: now });
  mocks.refreshModels.mockResolvedValue(undefined);
});

describe("providerAccountsStore", () => {
  it("keeps one card when adding a subscription resumes an existing account", async () => {
    await useProviderAccountsStore.getState().refresh();
    mocks.add.mockResolvedValue(account);
    const reused = await useProviderAccountsStore.getState().add({
      providerId: account.providerId,
      label: account.label,
      authMethod: "oauth",
    });
    await useProviderAccountsStore.getState().refresh();
    expect(reused.id).toBe(account.id);
    expect(useProviderAccountsStore.getState().accounts).toEqual([account]);
    expect(useProviderAccountsStore.getState().statuses[account.id]).toEqual(
      status,
    );
  });

  it("cancels only the active attempt and ignores its late response after retry", async () => {
    await useProviderAccountsStore.getState().refresh();
    let finishOld!: (value: unknown) => void;
    let finishNew!: (value: unknown) => void;
    mocks.auth
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finishOld = resolve;
        }),
      )
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finishNew = resolve;
        }),
      );
    const oldLogin = useProviderAccountsStore
      .getState()
      .authenticate(account.id);
    const oldAttempt =
      useProviderAccountsStore.getState().authStates[account.id].attemptId;
    await useProviderAccountsStore.getState().authenticate(account.id);
    expect(mocks.auth).toHaveBeenCalledTimes(1);
    mocks.cancelAuth.mockResolvedValueOnce(undefined);
    await useProviderAccountsStore.getState().cancelAuthentication(account.id);
    expect(mocks.cancelAuth).toHaveBeenCalledWith(account.id, oldAttempt);
    expect(
      useProviderAccountsStore.getState().authStates[account.id].status,
    ).toBe("needs_auth");
    const newLogin = useProviderAccountsStore
      .getState()
      .authenticate(account.id);
    const newAttempt =
      useProviderAccountsStore.getState().authStates[account.id].attemptId;
    expect(newAttempt).not.toBe(oldAttempt);
    finishOld({
      accountId: account.id,
      attemptId: oldAttempt,
      status: "needs_auth",
      message: "Cancelled",
    });
    await oldLogin;
    expect(
      useProviderAccountsStore.getState().authStates[account.id],
    ).toMatchObject({ attemptId: newAttempt, status: "running" });
    finishNew({
      accountId: account.id,
      attemptId: newAttempt,
      status: "authenticated",
      message: "Ready",
    });
    await newLogin;
    expect(
      useProviderAccountsStore.getState().authStates[account.id].status,
    ).toBe("authenticated");
  });

  it("keeps a sign-in pending if cancellation could not reach the backend", async () => {
    useProviderAccountsStore.setState({
      authStates: {
        saved: {
          accountId: "saved",
          attemptId: "pending",
          status: "running",
          message: "",
        },
      },
    });
    mocks.cancelAuth.mockRejectedValueOnce(new Error("IPC unavailable"));
    await expect(
      useProviderAccountsStore.getState().cancelAuthentication("saved"),
    ).rejects.toThrow("IPC unavailable");
    expect(useProviderAccountsStore.getState().authStates.saved.status).toBe(
      "running",
    );
  });

  it("clears signed-out usage without removing the profile, default or other accounts", async () => {
    const siblingAccount = { ...account, id: "sibling" };
    mocks.list.mockResolvedValue({
      ...snapshot,
      accounts: [account, siblingAccount],
    });
    await useProviderAccountsStore.getState().refresh();
    const sibling = { ...status, accountId: "sibling" };
    useProviderAccountsStore.setState((state) => ({
      statuses: { ...state.statuses, sibling },
    }));
    mocks.signOut.mockResolvedValueOnce(undefined);
    mocks.statuses.mockResolvedValue({
      accounts: [
        {
          ...status,
          state: "needs_auth",
          limits: [],
          subscription: null,
          lastAttemptAt: Date.now() + 1,
        },
      ],
      updatedAt: now,
    });
    await useProviderAccountsStore.getState().signOut(account.id);
    expect(mocks.signOut).toHaveBeenCalledWith(account.id);
    expect(useProviderAccountsStore.getState().accounts).toEqual([
      account,
      siblingAccount,
    ]);
    expect(useProviderAccountsStore.getState().defaults).toEqual(
      snapshot.defaults,
    );
    expect(useProviderAccountsStore.getState().statuses[account.id].state).toBe(
      "needs_auth",
    );
    expect(useProviderAccountsStore.getState().statuses.sibling).toEqual(
      sibling,
    );
    expect(mocks.invalidate).toHaveBeenCalledWith("codex-acp", {
      forget: true,
    });
    await useProviderAccountsStore.getState().refresh();
  });

  it("preserves availability when the backend refuses sign-out", async () => {
    await useProviderAccountsStore.getState().refresh();
    mocks.signOut.mockRejectedValueOnce(new Error("Busy account"));
    await expect(
      useProviderAccountsStore.getState().signOut(account.id),
    ).rejects.toThrow("Busy account");
    expect(useProviderAccountsStore.getState().statuses[account.id]).toEqual(
      status,
    );
  });
  it("shows saved accounts while a quota probe is still pending", async () => {
    let resolveStatus!: (value: {
      accounts: ProviderAccountStatus[];
      updatedAt: number;
    }) => void;
    mocks.statuses.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveStatus = resolve;
      }),
    );
    const pending = useProviderAccountsStore.getState().refresh();
    await vi.waitFor(() =>
      expect(useProviderAccountsStore.getState().loaded).toBe(true),
    );
    expect(useProviderAccountsStore.getState().accounts).toEqual([account]);
    expect(useProviderAccountsStore.getState().refreshing).toBe(true);
    resolveStatus({ accounts: [status], updatedAt: now });
    await pending;
  });

  it("does not restore removed account metadata from a delayed refresh", async () => {
    await useProviderAccountsStore.getState().refresh();
    useProviderAccountsStore.setState({
      authStates: {
        saved: {
          accountId: "saved",
          status: "authenticated",
          message: "ready",
        },
      },
    });
    let resolveStatus!: (value: {
      accounts: ProviderAccountStatus[];
      updatedAt: number;
    }) => void;
    mocks.statuses.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveStatus = resolve;
      }),
    );
    const pending = useProviderAccountsStore.getState().refresh();
    mocks.remove.mockResolvedValue({
      accounts: [],
      defaults: {},
      automaticSwitching: {},
    });
    await useProviderAccountsStore.getState().remove("saved");
    resolveStatus({ accounts: [status], updatedAt: now });
    await pending;
    expect(useProviderAccountsStore.getState().statuses).toEqual({});
    expect(useProviderAccountsStore.getState().authStates).toEqual({});
  });

  it("reports a failed refresh without replacing the saved roster", async () => {
    await useProviderAccountsStore.getState().refresh();
    mocks.list.mockRejectedValueOnce(new Error("IPC unavailable"));
    await useProviderAccountsStore.getState().refresh();
    expect(useProviderAccountsStore.getState().accounts).toEqual([account]);
    expect(useProviderAccountsStore.getState().error).toContain(
      "IPC unavailable",
    );
  });
  it("queues a forced refresh behind an in-flight background request", async () => {
    let resolveStatus: (value: {
      accounts: ProviderAccountStatus[];
      updatedAt: number;
    }) => void = () => {};
    mocks.statuses.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveStatus = resolve;
      }),
    );
    const first = useProviderAccountsStore.getState().refresh();
    const forced = useProviderAccountsStore.getState().refresh(true);
    resolveStatus({ accounts: [status], updatedAt: now });
    await Promise.all([first, forced]);
    expect(mocks.statuses.mock.calls.map(([force]) => force)).toEqual([
      false,
      true,
    ]);
  });
  it("hydrates the full roster and preserves last-known limits on refresh failure", async () => {
    await useProviderAccountsStore.getState().refresh();
    expect(useProviderAccountsStore.getState().accounts).toEqual([account]);
    mocks.statuses.mockRejectedValueOnce(new Error("offline"));
    await useProviderAccountsStore.getState().refresh(true);
    expect(useProviderAccountsStore.getState().statuses.saved).toMatchObject({
      ...status,
      stale: true,
      error: "Error: offline",
      lastAttemptAt: expect.any(Number),
    });
    expect(useProviderAccountsStore.getState().error).toContain("offline");
  });

  it("does not publish a failed default change", async () => {
    await useProviderAccountsStore.getState().refresh();
    mocks.setDefault.mockRejectedValueOnce(new Error("account unavailable"));
    await expect(
      useProviderAccountsStore.getState().setDefault("codex-acp", "other"),
    ).rejects.toThrow("account unavailable");
    expect(useProviderAccountsStore.getState().defaults["codex-acp"]).toBe(
      "saved",
    );
  });

  it("changes the default without authenticating again and invalidates its model inventory", async () => {
    mocks.setDefault.mockResolvedValue({
      ...snapshot,
      defaults: { "codex-acp": "other" },
    });
    await useProviderAccountsStore.getState().setDefault("codex-acp", "other");
    expect(mocks.auth).not.toHaveBeenCalled();
    expect(mocks.invalidate).toHaveBeenCalledWith("codex-acp", {
      forget: true,
    });
    expect(useProviderAccountsStore.getState().defaults["codex-acp"]).toBe(
      "other",
    );
  });

  it("passes a new API key to the backend without retaining it in state", async () => {
    const saved = { ...account, authMethod: "api_key" as const };
    mocks.add.mockResolvedValue(saved);
    await useProviderAccountsStore.getState().add({
      providerId: "codex-acp",
      label: "Personal",
      authMethod: "api_key",
      apiKey: "secret-test-key",
    });
    await useProviderAccountsStore.getState().refresh();
    expect(mocks.add).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "secret-test-key" }),
    );
    expect(JSON.stringify(useProviderAccountsStore.getState())).not.toContain(
      "secret-test-key",
    );
  });
});
