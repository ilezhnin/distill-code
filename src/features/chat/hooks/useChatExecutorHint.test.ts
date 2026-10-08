import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutorDecision } from "@/features/benchmarks/lib/executorSelection";
import { useChatExecutorHint } from "./useChatExecutorHint";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const decision = (reason: string) => ({ reason }) as ExecutorDecision;

describe("chat executor hint lifecycle", () => {
  it("reads only while open and discards a reply from an older draft", async () => {
    let finishOld!: (value: ExecutorDecision) => void;
    const old = vi.fn(
      () =>
        new Promise<ExecutorDecision>((resolve) => {
          finishOld = resolve;
        }),
    );
    const fresh = vi.fn(async () => decision("fresh"));
    const { result, rerender } = renderHook(
      ({ open, read }) => useChatExecutorHint(open, read),
      { initialProps: { open: false, read: old } },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(old).not.toHaveBeenCalled();
    rerender({ open: true, read: old });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    rerender({ open: true, read: fresh });
    expect(result.current).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(result.current?.decision?.reason).toBe("fresh");
    await act(async () => {
      finishOld(decision("obsolete"));
    });
    expect(result.current?.decision?.reason).toBe("fresh");
    rerender({ open: false, read: fresh });
    expect(result.current).toBeNull();
  });

  it("coalesces edits and reports a stalled service without accepting its late answer", async () => {
    let finish!: (value: ExecutorDecision) => void;
    const old = vi.fn(async () => decision("old"));
    const pending = vi.fn(
      () =>
        new Promise<ExecutorDecision>((resolve) => {
          finish = resolve;
        }),
    );
    const { result, rerender } = renderHook(
      ({ read }) => useChatExecutorHint(true, read),
      { initialProps: { read: old } },
    );
    rerender({ read: pending });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_001);
    });
    expect(old).not.toHaveBeenCalled();
    expect(result.current?.failed).toBe(true);
    await act(async () => {
      finish(decision("late"));
    });
    expect(result.current?.decision).toBeNull();
  });

  it("contains native errors and stops pending work when closed", async () => {
    const read = vi.fn(async () => {
      throw new Error("unavailable");
    });
    const { result, rerender } = renderHook(
      ({ open }) => useChatExecutorHint(open, read),
      { initialProps: { open: true } },
    );
    rerender({ open: false });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(read).not.toHaveBeenCalled();
    rerender({ open: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(result.current?.failed).toBe(true);
  });
});
