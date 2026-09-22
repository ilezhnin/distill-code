import { act, render } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { AcpToolsReconciledPayload } from "@/shared/api/acpTools";
import { AcpToolsEvents } from "./AcpToolsEvents";

const mocks = vi.hoisted(() => ({
  listener: undefined as
    | ((payload: AcpToolsReconciledPayload) => void)
    | undefined,
  doctor: vi.fn(),
  invalidate: vi.fn(),
  refresh: vi.fn(),
  unlisten: vi.fn(),
  queryClient: {},
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => mocks.queryClient,
}));
vi.mock("@/shared/api/useDoctorReport", () => ({
  rerunDoctorReport: mocks.doctor,
}));
vi.mock("@/shared/api/acpTools", () => ({
  listenAcpToolsReconciled: (listener: typeof mocks.listener) => {
    mocks.listener = listener;
    return Promise.resolve(mocks.unlisten);
  },
}));
vi.mock("@/features/providers/stores/providerModelCacheStore", () => ({
  useProviderModelCacheStore: {
    getState: () => ({
      invalidateProvider: mocks.invalidate,
      refreshProviderModels: mocks.refresh,
    }),
  },
}));
beforeEach(() => vi.clearAllMocks());

it.each([
  true,
  false,
])("refreshes installed models after reconciliation (ok=%s)", async (ok) => {
  const view = render(<AcpToolsEvents />);
  await act(async () =>
    mocks.listener?.({ ok, providerIds: ["claude-acp", "codex-acp"] }),
  );
  expect(mocks.doctor).toHaveBeenCalledWith(mocks.queryClient);
  for (const providerId of ["claude-acp", "codex-acp"]) {
    expect(mocks.invalidate).toHaveBeenCalledWith(providerId);
    expect(mocks.refresh).toHaveBeenCalledWith(providerId, { force: true });
  }
  view.unmount();
  await Promise.resolve();
  expect(mocks.unlisten).toHaveBeenCalledOnce();
});
