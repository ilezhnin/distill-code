import { create } from "zustand";

interface PendingNavigation {
  next: () => void;
  onCancel?: () => void;
}
interface BenchmarkViewState {
  dirty: boolean;
  pending: PendingNavigation | null;
  setDirty: (dirty: boolean) => void;
  guardNavigation: (next: () => void, onCancel?: () => void) => void;
  resolveNavigation: (discard: boolean) => void;
}

export const useBenchmarkViewStore = create<BenchmarkViewState>((set, get) => ({
  dirty: false,
  pending: null,
  setDirty: (dirty) => set({ dirty }),
  guardNavigation: (next, onCancel) => {
    if (!get().dirty) {
      next();
      return;
    }
    get().pending?.onCancel?.();
    set({ pending: { next, onCancel } });
  },
  resolveNavigation: (discard) => {
    const pending = get().pending;
    set({ pending: null, ...(discard ? { dirty: false } : {}) });
    if (discard) pending?.next();
    else pending?.onCancel?.();
  },
}));
