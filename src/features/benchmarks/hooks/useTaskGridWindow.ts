import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

const MINIMUM_WINDOWED_CASES = 80;
const ESTIMATED_ROW_HEIGHT = 88;
const OVERSCAN_ROWS = 2;

function scrollParent(element: HTMLElement): HTMLElement | null {
  for (
    let parent = element.parentElement;
    parent;
    parent = parent.parentElement
  ) {
    if (/^(auto|scroll)$/.test(getComputedStyle(parent).overflowY))
      return parent;
  }
  return null;
}

interface Geometry {
  owner: HTMLElement;
  columns: number;
  width: number;
  gap: number;
  margin: number;
}

export interface TaskGridFocusReturn {
  scope: string;
  versionId: string;
  scrollTop: number;
  viewportOffset: number;
}

/** Window only card contents: every real list item and button stays mounted. */
export function useTaskGridWindow(
  keys: readonly string[],
  locale: string,
  focusReturn?: MutableRefObject<TaskGridFocusReturn | null>,
  focusScope?: string,
  restoreFocus = true,
) {
  const gridRef = useRef<HTMLUListElement>(null);
  const [geometry, setGeometry] = useState<Geometry | null>(null);
  const [measured, setMeasured] = useState(false);
  const [pinnedKey, setPinnedKey] = useState<string | null>(null);
  const heights = useRef(new Map<string, number>());
  const anchor = useRef<{ key: string; offset: number } | null>(null);
  const pendingAnchor = useRef<{ key: string; offset: number } | null>(null);
  const requested = keys.length >= MINIMUM_WINDOWED_CASES;
  const columns = geometry?.columns ?? 1;
  const rows = useMemo(() => {
    const result: string[] = [];
    for (let i = 0; i < keys.length; i += columns)
      result.push(JSON.stringify(keys.slice(i, i + columns)));
    return result;
  }, [keys, columns]);
  const active = requested && geometry != null;
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => (active ? geometry.owner : null),
    enabled: active,
    getItemKey: (index) => rows[index],
    estimateSize: (index) =>
      heights.current.get(rows[index]) ?? ESTIMATED_ROW_HEIGHT,
    gap: geometry?.gap ?? 8,
    scrollMargin: geometry?.margin ?? 0,
    initialOffset: () => geometry?.owner.scrollTop ?? 0,
    overscan: OVERSCAN_ROWS,
  });
  const virtualRows = virtualizer.getVirtualItems();
  const pinnedIndex = pinnedKey == null ? -1 : keys.indexOf(pinnedKey);
  const materialized = useMemo(() => {
    const result = new Set(virtualRows.map((row) => row.index));
    if (pinnedIndex >= 0) result.add(Math.floor(pinnedIndex / columns));
    return result;
  }, [virtualRows, pinnedIndex, columns]);
  const latest = useRef({ keys, rows, geometry, virtualizer, materialized });
  latest.current = { keys, rows, geometry, virtualizer, materialized };

  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid || !requested) {
      setMeasured(true);
      return;
    }
    const owner = scrollParent(grid);
    if (!owner || owner.clientHeight <= 0 || grid.clientWidth <= 0) {
      setMeasured(true);
      return;
    }
    const update = () => {
      const style = getComputedStyle(grid);
      const template = style.gridTemplateColumns.trim();
      const next = {
        owner,
        columns:
          template && template !== "none" ? template.split(/\s+/).length : 1,
        width: grid.clientWidth,
        gap: Number.parseFloat(style.rowGap) || 0,
        margin:
          grid.getBoundingClientRect().top -
          owner.getBoundingClientRect().top -
          owner.clientTop +
          owner.scrollTop,
      };
      const previous = latest.current.geometry;
      if (previous && previous.width !== next.width)
        pendingAnchor.current = anchor.current;
      setGeometry((previous) =>
        previous &&
        Object.keys(next).every(
          (key) =>
            previous[key as keyof Geometry] === next[key as keyof Geometry],
        )
          ? previous
          : next,
      );
      setMeasured(true);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(grid);
    observer.observe(owner);
    if (owner.firstElementChild) observer.observe(owner.firstElementChild);
    // A preceding section can move this grid without resizing either this
    // grid or the fixed-height scroller (for example another model's summary).
    for (
      let element: Element | null = grid;
      element && element !== owner;
      element = element.parentElement
    ) {
      for (
        let sibling = element.previousElementSibling;
        sibling;
        sibling = sibling.previousElementSibling
      )
        observer.observe(sibling);
    }
    return () => observer.disconnect();
  }, [requested]);

  useLayoutEffect(() => {
    if (!active) return;
    const owner = geometry.owner;
    const remember = () => {
      const current = latest.current;
      const grid = gridRef.current;
      anchor.current = null;
      if (!grid || !current.geometry) return;
      const origin = owner.getBoundingClientRect().top + owner.clientTop;
      const edge = origin + owner.clientHeight;
      // Multiple grids share a drawer scroller. Only its first visible grid
      // may preserve the offset; a below-viewport or previously seen grid
      // must not move that same scroller during its own resize.
      for (const other of owner.querySelectorAll<HTMLUListElement>(
        "ul[data-task-grid]",
      )) {
        if (other === grid) break;
        if (scrollParent(other) !== owner) continue;
        const rect = other.getBoundingClientRect();
        if (rect.bottom > origin && rect.top < edge) return;
      }
      for (const row of current.virtualizer.getVirtualItems()) {
        const index = row.index * current.geometry.columns;
        const item = grid.children[index];
        if (!item) continue;
        const rect = item.getBoundingClientRect();
        if (rect.bottom <= origin || rect.top >= edge) continue;
        const key = current.keys[index];
        if (key) anchor.current = { key, offset: rect.top - origin };
        break;
      }
    };
    const cancel = () => {
      pendingAnchor.current = null;
    };
    remember();
    owner.addEventListener("scroll", remember, { passive: true });
    owner.addEventListener("wheel", cancel, { passive: true });
    owner.addEventListener("pointerdown", cancel, { passive: true });
    owner.addEventListener("keydown", cancel);
    return () => {
      owner.removeEventListener("scroll", remember);
      owner.removeEventListener("wheel", cancel);
      owner.removeEventListener("pointerdown", cancel);
      owner.removeEventListener("keydown", cancel);
    };
  }, [active, geometry?.owner]);

  const previousLayout = useRef({ width: geometry?.width, locale });
  const previousKeys = useRef(keys);
  useLayoutEffect(() => {
    if (
      keys.length !== previousKeys.current.length ||
      keys.some((key, index) => key !== previousKeys.current[index])
    )
      pendingAnchor.current ??= anchor.current;
    previousKeys.current = keys;
    const previous = previousLayout.current;
    previousLayout.current = { width: geometry?.width, locale };
    if (previous.width !== geometry?.width || previous.locale !== locale) {
      if (previous.width != null) pendingAnchor.current ??= anchor.current;
      heights.current.clear();
      virtualizer.measure();
    }
    const current = new Set(rows);
    for (const key of heights.current.keys())
      if (!current.has(key)) heights.current.delete(key);
  }, [geometry?.width, locale, keys, rows, virtualizer]);

  // CSS grid stretches every LI to its row's tallest card. Observe only the
  // first LI of each materialized row; placeholders retain that measured size.
  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!active || !grid) return;
    const measure = (element: HTMLElement) => {
      const index = Number(element.dataset.taskIndex);
      const row = Math.floor(index / columns);
      const height = element.getBoundingClientRect().height;
      const current = latest.current;
      // A resize batch can still contain the previous column layout's rows.
      if (
        current.geometry?.width !== grid.clientWidth ||
        current.geometry.columns !== columns
      )
        return;
      if (!current.materialized.has(row) || height <= 0) return;
      const key = rows[row];
      if (Math.abs((heights.current.get(key) ?? 0) - height) < 0.5) return;
      heights.current.set(key, height);
      // Only one owner adjusts the offset during a responsive/locale anchor
      // restoration. Otherwise preserve the virtualizer's normal compensation.
      const adjust = virtualizer.shouldAdjustScrollPositionOnItemSizeChange;
      if (pendingAnchor.current)
        virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => false;
      try {
        virtualizer.resizeItem(row, height);
      } finally {
        virtualizer.shouldAdjustScrollPositionOnItemSizeChange = adjust;
      }
    };
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) measure(entry.target as HTMLElement);
    });
    for (const row of materialized) {
      const element = grid.children[row * columns] as HTMLElement | undefined;
      if (element) {
        observer.observe(element);
      }
    }
    return () => observer.disconnect();
  }, [active, columns, materialized, rows, virtualizer]);

  useLayoutEffect(() => {
    const pending = pendingAnchor.current;
    if (!active || !pending) return;
    const index = keys.indexOf(pending.key);
    if (index < 0) {
      pendingAnchor.current = null;
      return;
    }
    const item = gridRef.current?.children[index];
    if (item)
      geometry.owner.scrollTop +=
        item.getBoundingClientRect().top -
        geometry.owner.getBoundingClientRect().top -
        geometry.owner.clientTop -
        pending.offset;
    // A column/locale change first replaces old row heights, then measures the
    // newly visible natural contents. Keep the logical anchor through both
    // layouts; wheel/pointer/key input cancels it immediately above.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        if (pendingAnchor.current === pending) pendingAnchor.current = null;
      });
    });
    return () => cancelAnimationFrame(frame);
  });

  const previousFocusScope = useRef(focusScope);
  useLayoutEffect(() => {
    const previous = previousFocusScope.current;
    if (
      previous !== focusScope &&
      focusReturn?.current &&
      focusReturn.current.scope === previous
    )
      focusReturn.current = null;
    previousFocusScope.current = focusScope;
  }, [focusScope, focusReturn]);

  useLayoutEffect(() => {
    const point = focusReturn?.current;
    const grid = gridRef.current;
    if (!restoreFocus || !point || point.scope !== focusScope || !grid) return;
    const index = keys.indexOf(point.versionId);
    const item = grid.children[index];
    const button = item?.querySelector("button");
    const owner = scrollParent(grid);
    if (!item || !button || button.disabled || !owner) return;
    setPinnedKey(point.versionId);
    const frame = requestAnimationFrame(() => {
      // A drawer may mount before its cached/query data arrives. Consume only
      // after the actual task exists, and after the dialog's initial autofocus.
      if (focusReturn?.current !== point || !button.isConnected) return;
      owner.scrollTop = point.scrollTop;
      owner.scrollTop +=
        item.getBoundingClientRect().top -
        owner.getBoundingClientRect().top -
        owner.clientTop -
        point.viewportOffset;
      button.focus({ preventScroll: true });
      focusReturn.current = null;
    });
    return () => cancelAnimationFrame(frame);
  }, [keys, focusReturn, focusScope, restoreFocus]);

  const pin = useCallback((key: string) => setPinnedKey(key), []);
  const rememberFocus = useCallback(
    (key: string) => {
      setPinnedKey(key);
      const grid = gridRef.current;
      const owner = grid ? scrollParent(grid) : null;
      const item = grid?.children[latest.current.keys.indexOf(key)];
      if (focusReturn && focusScope && owner && item)
        focusReturn.current = {
          scope: focusScope,
          versionId: key,
          scrollTop: owner.scrollTop,
          viewportOffset:
            item.getBoundingClientRect().top -
            owner.getBoundingClientRect().top -
            owner.clientTop,
        };
    },
    [focusReturn, focusScope],
  );
  return {
    gridRef,
    active,
    pin,
    rememberFocus,
    materialized(index: number) {
      if (!requested || (measured && !active)) return true;
      if (!active) return index < 24;
      return materialized.has(Math.floor(index / columns));
    },
    placeholderHeight(index: number) {
      return (
        heights.current.get(rows[Math.floor(index / columns)]) ??
        ESTIMATED_ROW_HEIGHT
      );
    },
  };
}
