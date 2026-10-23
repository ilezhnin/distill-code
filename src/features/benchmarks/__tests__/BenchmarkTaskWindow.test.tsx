import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TaskGrid, type TaskCell } from "../ui/BenchmarkTaskGrid";
import type { TaskGridFocusReturn } from "../hooks/useTaskGridWindow";
import { i18n } from "@/shared/i18n";

let columns = 4;
let width = 800;
const changedHeights = new Map<number, number>();
const observers = new Set<TestResizeObserver>();
class TestResizeObserver {
  elements = new Set<Element>();
  constructor(readonly callback: ResizeObserverCallback) {
    observers.add(this);
  }
  observe(element: Element) {
    this.elements.add(element);
  }
  unobserve(element: Element) {
    this.elements.delete(element);
  }
  disconnect() {
    this.elements.clear();
    observers.delete(this);
  }
}
function notifyResize(changed?: readonly Element[]) {
  for (const observer of [...observers]) {
    const entries = [...observer.elements]
      .filter((element) => !changed || changed.includes(element))
      .map((target) => ({ target }) as ResizeObserverEntry);
    if (entries.length)
      observer.callback(entries, observer as unknown as ResizeObserver);
  }
}
function rowHeight(grid: Element, row: number): number {
  const first = grid.children[row * columns] as HTMLElement | undefined;
  if (!first) return 0;
  return first.querySelector("[data-task-body]")
    ? (changedHeights.get(row) ?? (row % 3 === 0 ? 88 : 64))
    : Number.parseFloat(first.style.height) || 88;
}
function rowTop(grid: Element, row: number): number {
  let result = Number(
    grid.parentElement
      ?.closest("[data-grid-top]")
      ?.getAttribute("data-grid-top") ?? 200,
  );
  const previous = grid.parentElement
    ?.closest("[data-after-grid]")
    ?.previousElementSibling?.querySelector("ul");
  if (previous)
    result =
      rowTop(previous, Math.ceil(previous.children.length / columns)) +
      80 +
      Number(previous.parentElement?.getAttribute("data-section-extra") ?? 0);
  for (let i = 0; i < row; i++) result += rowHeight(grid, i) + 8;
  return result;
}
function rect(top: number, height: number): DOMRect {
  return {
    top,
    bottom: top + height,
    left: 0,
    right: width,
    width,
    height,
    x: 0,
    y: top,
    toJSON: () => ({}),
  };
}
function fixture(index: number): TaskCell {
  return {
    versionId: `case-${index}`,
    number: index + 1,
    name: `Invented ${index}`,
    status: { kind: "scored", score: 1, passes: 1, of: 1, durationMs: 2_000 },
    durationMs: 2_000,
    activity: {
      execution: [{ startedAt: 1_000, finishedAt: 3_000 }],
      waiting: [],
      partial: false,
    },
    clock: false,
    cost: 0.01,
    attemptIds: [`attempt-${index}`],
    dots: ["passed", "queued", "queued"],
    verdict: "queued",
  };
}
const cells = Array.from({ length: 346 }, (_, index) => fixture(index));
function shell(children: React.ReactNode) {
  return (
    <div data-window-scroll="" style={{ overflowY: "auto" }}>
      <div>{children}</div>
    </div>
  );
}
function scrollTo(element: HTMLElement, top: number) {
  act(() => {
    fireEvent.wheel(element);
    element.scrollTop = top;
    fireEvent.scroll(element);
  });
  act(notifyResize);
  act(() => fireEvent.scroll(element));
}
function ownerOf(container: HTMLElement): HTMLElement {
  const owner = container.querySelector<HTMLElement>("[data-window-scroll]");
  if (!owner) throw new Error("Missing invented scroll owner");
  return owner;
}

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(5_000);
  columns = 4;
  width = 800;
  changedHeights.clear();
  observers.clear();
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(performance.now()), 16),
  );
  vi.stubGlobal("cancelAnimationFrame", (handle: number) =>
    window.clearTimeout(handle),
  );
  const scrollPositions = new WeakMap<Element, number>();
  vi.spyOn(Element.prototype, "scrollTop", "get").mockImplementation(function (
    this: Element,
  ) {
    return (
      scrollPositions.get(this) ??
      Number(this.getAttribute("data-initial-scroll") ?? 0)
    );
  });
  vi.spyOn(Element.prototype, "scrollTop", "set").mockImplementation(function (
    this: Element,
    value,
  ) {
    scrollPositions.set(this, value);
  });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.matches("ul,[data-window-scroll]") ? width : 0;
    },
  );
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.matches("[data-window-scroll]") ? 300 : 0;
    },
  );
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.matches("[data-window-scroll]") ? width : 0;
    },
  );
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      return this.matches("[data-window-scroll]") ? 300 : 0;
    },
  );
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      const grids = [...this.querySelectorAll("ul")];
      return this.matches("[data-window-scroll]") && grids.length
        ? Math.max(
            ...grids.map((grid) =>
              rowTop(grid, Math.ceil(grid.children.length / columns)),
            ),
          ) + 100
        : 0;
    },
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      if (this.matches("[data-window-scroll]")) return rect(0, 300);
      const owner = this.closest<HTMLElement>("[data-window-scroll]");
      if (this.tagName === "UL")
        return rect(
          rowTop(this, 0) - (owner?.scrollTop ?? 0),
          rowTop(this, Math.ceil(this.children.length / columns)) -
            rowTop(this, 0) -
            8,
        );
      if (this.matches("li[data-task-index]")) {
        const grid = this.parentElement;
        if (!grid) throw new Error("Missing invented grid");
        const row = Math.floor(Number(this.dataset.taskIndex) / columns);
        return rect(
          rowTop(grid, row) - (owner?.scrollTop ?? 0),
          rowHeight(grid, row),
        );
      }
      return rect(0, 0);
    },
  );
  const nativeStyle = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) =>
    element.tagName === "UL"
      ? ({
          gridTemplateColumns: Array(columns)
            .fill(`${width / columns}px`)
            .join(" "),
          rowGap: "8px",
        } as CSSStyleDeclaration)
      : nativeStyle(element),
  );
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value(this: HTMLElement, options: ScrollToOptions) {
      this.scrollTop = options.top ?? this.scrollTop;
    },
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("bounds expensive bodies while keeping all task buttons and repetition names", () => {
  const view = render(shell(<TaskGrid cells={cells} onOpen={vi.fn()} />));
  expect(screen.getAllByRole("button")).toHaveLength(346);
  expect(screen.getAllByRole("img")).toHaveLength(346);
  expect(
    new Set(
      screen.getAllByRole("img").map((node) => node.getAttribute("aria-label")),
    ).size,
  ).toBe(1);
  const bodies = view.container.querySelectorAll("[data-task-body]");
  expect(bodies.length).toBeGreaterThan(0);
  expect(bodies.length).toBeLessThan(40);
  expect(
    screen.getByRole("button", { name: "Task 346: Invented 345" }),
  ).toBeEnabled();
  expect(screen.getAllByRole("listitem")[345]).toHaveAttribute(
    "aria-posinset",
    "346",
  );
  expect(screen.getAllByRole("listitem")[345]).toHaveAttribute(
    "aria-setsize",
    "346",
  );
});

it("keeps native button identity, focus and current evidence across a window boundary", async () => {
  const user = userEvent.setup();
  const open = vi.fn();
  const next = cells.map((cell) => ({ ...cell }));
  next[25] = { ...next[25], attemptIds: [] };
  const view = render(shell(<TaskGrid cells={next} onOpen={open} />));
  const original = screen.getByRole("button", { name: "Task 25: Invented 24" });
  act(() => original.focus());
  expect(original.querySelector("[data-task-body]")).not.toBeNull();
  await user.tab();
  const target = screen.getByRole("button", { name: "Task 27: Invented 26" });
  expect(target).toHaveFocus();
  await user.tab({ shift: true });
  expect(original).toHaveFocus();
  const revised = [...next];
  revised[24] = { ...next[24], attemptIds: ["revised-evidence"] };
  view.rerender(shell(<TaskGrid cells={revised} onOpen={open} />));
  expect(screen.getByRole("button", { name: "Task 25: Invented 24" })).toBe(
    original,
  );
  await user.keyboard("{Enter}");
  expect(open).toHaveBeenLastCalledWith(revised[24]);
  scrollTo(ownerOf(view.container), 3_000);
  expect(original).toHaveFocus();
  expect(original.querySelector("[data-task-body]")).not.toBeNull();
});

it("uses measured variable row heights when bodies leave and re-enter the viewport", () => {
  const view = render(shell(<TaskGrid cells={cells} onOpen={vi.fn()} />));
  changedHeights.set(0, 136);
  act(notifyResize);
  const first = screen.getAllByRole("listitem")[0];
  scrollTo(ownerOf(view.container), 3_000);
  expect(first.querySelector("[data-task-body]")).toBeNull();
  expect(first).toHaveStyle({ height: "136px" });
  scrollTo(ownerOf(view.container), 0);
  expect(first.querySelector("[data-task-body]")).not.toBeNull();
  expect(first.style.height).toBe("");
});

it("keeps the same logical visible case when responsive columns change", () => {
  const view = render(shell(<TaskGrid cells={cells} onOpen={vi.fn()} />));
  const owner = ownerOf(view.container);
  act(notifyResize);
  scrollTo(owner, 1_600);
  const firstVisible = screen
    .getAllByRole("listitem")
    .find((item) => item.getBoundingClientRect().bottom > 0);
  if (!firstVisible) throw new Error("Missing visible invented row");
  const before = firstVisible.getBoundingClientRect().top;
  columns = 2;
  width = 400;
  act(notifyResize);
  act(() => fireEvent.scroll(owner));
  act(notifyResize);
  expect(firstVisible.getBoundingClientRect().top).toBeCloseTo(before, 0);
  expect(firstVisible.querySelector("[data-task-body]")).not.toBeNull();
  expect(
    view.container.querySelectorAll("[data-task-body]").length,
  ).toBeLessThan(40);
});

it("does not start an offscreen live clock until its card is materialized", () => {
  vi.useFakeTimers();
  const live = [...cells];
  live[300] = {
    ...live[300],
    status: { kind: "running", startedAt: 1_000 },
    clock: true,
    dots: ["running"],
    verdict: "running",
  };
  const interval = vi.spyOn(window, "setInterval");
  render(shell(<TaskGrid cells={live} onOpen={vi.fn()} />));
  expect(interval).not.toHaveBeenCalled();
  act(() =>
    screen.getByRole("button", { name: "Task 301: Invented 300" }).focus(),
  );
  expect(interval).toHaveBeenCalledTimes(1);
  const observe = vi.spyOn(TestResizeObserver.prototype, "observe");
  const rectangles = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
  rectangles.mockClear();
  act(() => vi.advanceTimersByTime(3_000));
  expect(observe).not.toHaveBeenCalled();
  expect(rectangles).not.toHaveBeenCalled();
});

it("restores the same task and scroll after an evidence view unmounts a drawer grid", async () => {
  const focusReturn: { current: TaskGridFocusReturn | null } = {
    current: null,
  };
  const view = render(
    shell(
      <TaskGrid
        cells={cells}
        onOpen={vi.fn()}
        focusReturn={focusReturn}
        focusScope="invented-run:model"
      />,
    ),
  );
  const owner = ownerOf(view.container);
  scrollTo(owner, 900);
  const button = screen.getByRole("button", { name: "Task 41: Invented 40" });
  const before = button.parentElement?.getBoundingClientRect().top;
  fireEvent.click(button);
  expect(focusReturn.current?.versionId).toBe("case-40");
  view.rerender(shell(<div role="dialog">Evidence</div>));
  view.rerender(
    shell(
      <TaskGrid
        cells={cells}
        onOpen={vi.fn()}
        focusReturn={focusReturn}
        focusScope="invented-run:model"
      />,
    ),
  );
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Task 41: Invented 40" }),
    ).toHaveFocus(),
  );
  expect(
    screen
      .getByRole("button", { name: "Task 41: Invented 40" })
      .parentElement?.getBoundingClientRect().top,
  ).toBe(before);
  expect(focusReturn.current).toBeNull();
});

it("cancels a pending focus return when its route scope changes", async () => {
  const focusReturn: { current: TaskGridFocusReturn | null } = {
    current: {
      scope: "invented-run:model",
      versionId: "case-40",
      scrollTop: 900,
      viewportOffset: 100,
    },
  };
  const view = render(
    shell(
      <TaskGrid
        cells={cells}
        onOpen={vi.fn()}
        focusReturn={focusReturn}
        focusScope="invented-run:model"
      />,
    ),
  );
  view.rerender(
    shell(
      <TaskGrid
        cells={cells}
        onOpen={vi.fn()}
        focusReturn={focusReturn}
        focusScope="other-run:model"
      />,
    ),
  );
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 40));
  });
  expect(
    screen.getByRole("button", { name: "Task 41: Invented 40" }),
  ).not.toHaveFocus();
  expect(focusReturn.current).toBeNull();
});

it("lets user scrolling cancel a responsive anchor immediately", () => {
  const view = render(shell(<TaskGrid cells={cells} onOpen={vi.fn()} />));
  const owner = ownerOf(view.container);
  scrollTo(owner, 1_600);
  columns = 2;
  width = 400;
  act(notifyResize);
  scrollTo(owner, 5_000);
  expect(owner.scrollTop).toBeGreaterThan(4_500);
  const visible = screen.getAllByRole("listitem").filter((item) => {
    const r = item.getBoundingClientRect();
    return r.bottom > 0 && r.top < 300;
  });
  expect(visible.length).toBeGreaterThan(0);
  expect(
    visible.every((item) => item.querySelector("[data-task-body]") != null),
  ).toBe(true);
});

it("keeps small lists ordinary", () => {
  const view = render(
    shell(<TaskGrid cells={cells.slice(0, 12)} onOpen={vi.fn()} />),
  );
  expect(view.container.querySelectorAll("[data-task-body]")).toHaveLength(12);
  expect(
    screen.getAllByRole("listitem").every((item) => item.style.height === ""),
  ).toBe(true);
});

it("materializes the viewport on an initial deep restored scroll position", () => {
  const view = render(
    <div
      data-window-scroll=""
      data-initial-scroll="4000"
      style={{ overflowY: "auto" }}
    >
      <div>
        <TaskGrid cells={cells} onOpen={vi.fn()} />
      </div>
    </div>,
  );
  act(notifyResize);
  const visible = screen.getAllByRole("listitem").filter((item) => {
    const r = item.getBoundingClientRect();
    return r.bottom > 0 && r.top < 300;
  });
  expect(ownerOf(view.container).scrollTop).toBeGreaterThan(3_500);
  expect(visible.length).toBeGreaterThan(0);
  expect(
    visible.every((item) => item.querySelector("[data-task-body]") != null),
  ).toBe(true);
  expect(
    screen.getAllByRole("listitem")[0].querySelector("[data-task-body]"),
  ).toBeNull();
  expect(
    view.container.querySelectorAll("[data-task-body]").length,
  ).toBeLessThan(60);
});

it("uses each grid's own margin within the same drawer scroller", () => {
  const view = render(
    <div
      data-window-scroll=""
      data-initial-scroll="1600"
      style={{ overflowY: "auto" }}
    >
      <section data-grid-top="200">
        <TaskGrid cells={cells.slice(0, 12)} onOpen={vi.fn()} />
      </section>
      <section data-grid-top="1600">
        <TaskGrid cells={cells} onOpen={vi.fn()} />
      </section>
    </div>,
  );
  const second = view.container.querySelectorAll("ul")[1];
  expect(ownerOf(view.container).scrollTop).toBe(1_600);
  expect(second.children[0].querySelector("[data-task-body]")).not.toBeNull();
  expect(second.children[300].querySelector("[data-task-body]")).toBeNull();
  expect(second.querySelectorAll("[data-task-body]").length).toBeLessThan(60);
});

it.each([
  false,
  true,
])("lets only the visible large grid own a shared scroller anchor (old second-grid anchor: %s)", (visitSecond) => {
  const view = render(
    <div data-window-scroll="" style={{ overflowY: "auto" }}>
      <section>
        <TaskGrid cells={cells} onOpen={vi.fn()} />
      </section>
      <section data-after-grid="">
        <TaskGrid cells={cells} onOpen={vi.fn()} />
      </section>
    </div>,
  );
  const owner = ownerOf(view.container);
  const [first, second] = view.container.querySelectorAll("ul");
  act(notifyResize);
  if (visitSecond) scrollTo(owner, rowTop(second, 0) + 500);
  scrollTo(owner, 1_600);
  const visible = [...first.children].find(
    (item) => item.getBoundingClientRect().bottom > 0,
  );
  if (!visible) throw new Error("Missing visible first-grid task");
  const offset = visible.getBoundingClientRect().top;
  expect(second.getBoundingClientRect().top).toBeGreaterThan(300);
  columns = 2;
  width = 400;
  act(notifyResize);
  act(() => fireEvent.scroll(owner));
  act(notifyResize);
  expect(visible.getBoundingClientRect().top).toBeCloseTo(offset, 0);
  expect(visible.querySelector("[data-task-body]")).not.toBeNull();
});

it("updates a later grid's margin when only an earlier middle section resizes", () => {
  const view = render(
    <div data-window-scroll="" style={{ overflowY: "auto" }}>
      <section>
        <TaskGrid cells={cells.slice(0, 12)} onOpen={vi.fn()} />
      </section>
      <section data-after-grid="">
        <TaskGrid cells={cells.slice(0, 12)} onOpen={vi.fn()} />
      </section>
      <section data-after-grid="">
        <TaskGrid cells={cells} onOpen={vi.fn()} />
      </section>
    </div>,
  );
  const owner = ownerOf(view.container);
  const [, middle, third] = view.container.querySelectorAll("ul");
  scrollTo(owner, rowTop(third, 0) + 900);
  const section = middle.parentElement;
  if (!section) throw new Error("Missing middle section");
  // A summary/error grows; owner and third-grid border boxes do not resize.
  section.setAttribute("data-section-extra", "800");
  act(() => notifyResize([section]));
  const visible = [...third.children].filter((item) => {
    const r = item.getBoundingClientRect();
    return r.bottom > 0 && r.top < 300;
  });
  expect(visible.length).toBeGreaterThan(0);
  expect(
    visible.every((item) => item.querySelector("[data-task-body]") != null),
  ).toBe(true);
});

it("remeasures translated row content instead of preserving an old locale height", async () => {
  const view = render(shell(<TaskGrid cells={cells} onOpen={vi.fn()} />));
  act(notifyResize);
  const first = screen.getAllByRole("listitem")[0];
  changedHeights.set(0, 136);
  await act(async () => {
    await i18n.changeLanguage("es");
  });
  act(notifyResize);
  scrollTo(ownerOf(view.container), 3_000);
  expect(first).toHaveStyle({ height: "136px" });
  expect(screen.getAllByRole("button")).toHaveLength(346);
});
