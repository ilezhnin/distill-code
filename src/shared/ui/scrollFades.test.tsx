import { Profiler } from "react";
import { render, fireEvent, cleanup } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BottomFade } from "./BottomFade";
import { TopFade } from "./TopFade";

let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
beforeEach(() => {
  frames = new Map();
  nextFrame = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function flushFrames() {
  const callbacks = [...frames.values()];
  frames.clear();
  for (const callback of callbacks) callback(0);
}

it("paints a bottom fade once per frame without rendering React for every scroll", () => {
  const scroll = document.createElement("div");
  Object.defineProperties(scroll, {
    scrollHeight: { value: 1000 },
    clientHeight: { value: 200 },
  });
  const onRender = vi.fn();
  const view = render(
    <Profiler id="fade" onRender={onRender}>
      <BottomFade scrollElement={scroll} />
    </Profiler>,
  );
  const fade = view.container.firstElementChild as HTMLElement;
  flushFrames();
  expect(fade.style.opacity).toBe("1");
  const commits = onRender.mock.calls.length;
  for (let i = 0; i < 10; i++) {
    scroll.scrollTop = 740;
    fireEvent.scroll(scroll);
  }
  expect(frames.size).toBe(1);
  flushFrames();
  expect(fade.style.opacity).toBe("0.5");
  expect(onRender).toHaveBeenCalledTimes(commits);
  scroll.scrollTop = 800;
  fireEvent.scroll(scroll);
  flushFrames();
  expect(fade.style.opacity).toBe("0");
  view.unmount();
  expect(frames.size).toBe(0);
});

it("does not read scroll layout while rendering a top fade", () => {
  const scroll = document.createElement("div");
  const read = vi.fn(() => 40);
  Object.defineProperty(scroll, "scrollTop", { get: read });
  renderToString(<TopFade scrollElement={scroll} />);
  expect(read).not.toHaveBeenCalled();
  const view = render(<TopFade scrollElement={scroll} />);
  expect((view.container.firstElementChild as HTMLElement).style.opacity).toBe(
    "0.5",
  );
});
