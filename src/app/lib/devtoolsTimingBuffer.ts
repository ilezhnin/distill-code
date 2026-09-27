// React's development build annotates every commit on the DevTools
// performance timeline with `performance.measure(name, { detail: { devtools } })`,
// attaching a diff of the changed props. Chromium keeps every measure entry
// until someone clears it, and React never does: a dev app that streams agent
// output for a few hours piles up millions of entries, each holding a copy of
// the streamed text, until the WebView2 renderer dies of out-of-memory.
//
// DevTools records a timeline annotation when the call happens, not by reading
// the buffer later, so dropping the buffered entry straight away keeps React's
// tracks in a recorded profile and releases the memory.
export function installDevtoolsTimingBufferGuard(
  target: Performance = performance,
): void {
  const measure = target.measure.bind(target);
  target.measure = ((
    measureName: string,
    startOrMeasureOptions?: string | PerformanceMeasureOptions,
    endMark?: string,
  ) => {
    const entry = measure(measureName, startOrMeasureOptions, endMark);
    if (isDevtoolsAnnotation(startOrMeasureOptions)) {
      target.clearMeasures(measureName);
    }
    return entry;
  }) as Performance["measure"];
}

function isDevtoolsAnnotation(
  startOrMeasureOptions: string | PerformanceMeasureOptions | undefined,
): boolean {
  if (typeof startOrMeasureOptions !== "object") return false;
  const detail: unknown = startOrMeasureOptions.detail;
  return typeof detail === "object" && detail !== null && "devtools" in detail;
}
