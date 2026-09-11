import { create } from "zustand";
import type { ProviderCatalogEntry } from "@/shared/types/providers";
import { CURATED_PROVIDER_CATALOG } from "../curatedProviders";

export interface ProviderCatalogState {
  entries: ProviderCatalogEntry[];
  loading: boolean;
  loaded: boolean;
  error: string | null;
}

interface ProviderCatalogActions {
  setEntries: (entries: ProviderCatalogEntry[]) => void;
  reset: () => void;
}

export type ProviderCatalogStore = ProviderCatalogState &
  ProviderCatalogActions;

function curatedState(): ProviderCatalogState {
  return {
    entries: CURATED_PROVIDER_CATALOG,
    loading: false,
    loaded: true,
    error: null,
  };
}

/** The harness catalog is static; the store exists so tests can swap it. */
export const useProviderCatalogStore = create<ProviderCatalogStore>((set) => ({
  ...curatedState(),

  setEntries: (entries) => {
    set({ entries, loading: false, loaded: true, error: null });
  },

  reset: () => set(curatedState()),
}));
