import {
  getPreferenceStorage,
  readEffectiveSettings,
} from "@/shared/preferences/rootSettings";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

export type AtMentionDefaultCategory = "agents" | "files";

export const AT_MENTION_DEFAULT_CATEGORY_STORAGE_KEY =
  "distill:at-mention-default-category";
export const DEFAULT_AT_MENTION_DEFAULT_CATEGORY: AtMentionDefaultCategory =
  "agents";

const AT_MENTION_DEFAULT_CATEGORY_CHANGED_EVENT =
  "distill:at-mention-default-category-changed";

function normalizeAtMentionDefaultCategory(
  value: unknown,
): AtMentionDefaultCategory {
  return value === "files" || value === "agents"
    ? value
    : DEFAULT_AT_MENTION_DEFAULT_CATEGORY;
}

function readAtMentionDefaultCategory(): AtMentionDefaultCategory {
  try {
    return normalizeAtMentionDefaultCategory(
      getPreferenceStorage()?.getItem(AT_MENTION_DEFAULT_CATEGORY_STORAGE_KEY),
    );
  } catch {
    return DEFAULT_AT_MENTION_DEFAULT_CATEGORY;
  }
}

const listeners = new Set<() => void>();
let removeWindowListener: (() => void) | undefined;

function notifyListeners() {
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(onStoreChange: () => void) {
  listeners.add(onStoreChange);

  if (!removeWindowListener) {
    window.addEventListener(
      AT_MENTION_DEFAULT_CATEGORY_CHANGED_EVENT,
      notifyListeners,
    );
    window.addEventListener("storage", notifyListeners);
    removeWindowListener = () => {
      window.removeEventListener(
        AT_MENTION_DEFAULT_CATEGORY_CHANGED_EVENT,
        notifyListeners,
      );
      window.removeEventListener("storage", notifyListeners);
    };
  }

  return () => {
    listeners.delete(onStoreChange);
    if (listeners.size === 0) {
      removeWindowListener?.();
      removeWindowListener = undefined;
    }
  };
}

export function setAtMentionDefaultCategory(
  category: AtMentionDefaultCategory,
): void {
  const normalized = normalizeAtMentionDefaultCategory(category);
  try {
    getPreferenceStorage()?.setItem(
      AT_MENTION_DEFAULT_CATEGORY_STORAGE_KEY,
      normalized,
    );
  } catch {
    // localStorage can be unavailable in restricted contexts.
  }
  window.dispatchEvent(
    new CustomEvent(AT_MENTION_DEFAULT_CATEGORY_CHANGED_EVENT, {
      detail: { category: normalized },
    }),
  );
}

export function useAtMentionDefaultCategoryPreference(projectRoot?: string) {
  const category = useSyncExternalStore(
    subscribe,
    readAtMentionDefaultCategory,
    () => DEFAULT_AT_MENTION_DEFAULT_CATEGORY,
  );
  const setCategory = useCallback((nextCategory: AtMentionDefaultCategory) => {
    setAtMentionDefaultCategory(nextCategory);
  }, []);

  const [override, setOverride] = useState<{
    root: string;
    category: AtMentionDefaultCategory;
  } | null>(null);
  useEffect(() => {
    if (!projectRoot) return;
    let cancelled = false;
    const refresh = () => {
      void readEffectiveSettings(projectRoot)
        .then((settings) => {
          const value = settings["at-mention-default-category"] ?? category;
          if (!cancelled)
            setOverride(
              value === "agents" || value === "files"
                ? { root: projectRoot, category: value }
                : null,
            );
        })
        .catch(console.error);
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", refresh);
    };
  }, [projectRoot, category]);

  return {
    category:
      override && override.root === projectRoot ? override.category : category,
    setCategory,
  };
}
