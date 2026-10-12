// The browser receives only the candidate artifact and public test inputs.
// Expected values and assertions remain in this controller process.
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const MAX_INPUT = 4 * 1024 * 1024;
const ASSERTIONS = new Set([
  "expectAccessibleName",
  "expectAccessibleDescription",
  "expectAccessibleError",
  "expectText",
  "expectValue",
  "expectCount",
  "expectSize",
  "expectBounds",
]);
const normalizeAccessibleText = (text) => text.replace(/\s+/gu, " ").trim();

async function createBoundsContext(client) {
  const { frameTree } = await client.send("Page.getFrameTree");
  const { executionContextId } = await client.send("Page.createIsolatedWorld", {
    frameId: frameTree.frame.id,
    worldName: `distill-bounds-${randomUUID()}`,
  });
  return executionContextId;
}

async function readRenderedBounds(
  client,
  executionContextId,
  selector,
  relativeTo,
  coordinateSpace,
) {
  // A fresh world per step supplies native DOM methods. One synchronous observation
  // keeps target and reference coherent during script and CSS animation.
  // Only selectors and the coordinate mode cross; expected geometry stays in Node.
  const { result, exceptionDetails } = await client.send(
    "Runtime.callFunctionOn",
    {
      executionContextId,
      functionDeclaration: ((targetSelector, referenceSelector, space) => {
        const find = (css) => {
          const elements = Document.prototype.querySelectorAll.call(
            document,
            css,
          );
          if (elements.length !== 1)
            throw new Error("Expected one positioned element");
          const element = elements[0];
          if (!Element.prototype.getClientRects.call(element).length)
            throw new Error("Expected rendered element");
          return element;
        };
        const target = find(targetSelector);
        const reference =
          referenceSelector === null ? null : find(referenceSelector);
        if (space === "svg") {
          if (
            !(target instanceof SVGRectElement) ||
            !(reference instanceof SVGSVGElement)
          )
            throw new Error("Expected SVG rectangle and viewport");
          const box = SVGGraphicsElement.prototype.getBBox.call(target);
          const targetMatrix =
            SVGGraphicsElement.prototype.getScreenCTM.call(target);
          const referenceMatrix =
            SVGGraphicsElement.prototype.getScreenCTM.call(reference);
          const finiteMatrix = (matrix) =>
            matrix &&
            [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f].every(
              Number.isFinite,
            );
          if (!finiteMatrix(targetMatrix) || !finiteMatrix(referenceMatrix))
            throw new Error("SVG transform unavailable");
          const inverse = SVGMatrix.prototype.inverse.call(referenceMatrix);
          if (!finiteMatrix(inverse))
            throw new Error("SVG viewport transform is singular");
          const transform = SVGMatrix.prototype.multiply.call(
            inverse,
            targetMatrix,
          );
          if (!finiteMatrix(transform))
            throw new Error("SVG relative transform unavailable");
          return [
            [box.x, box.y],
            [box.x + box.width, box.y],
            [box.x + box.width, box.y + box.height],
            [box.x, box.y + box.height],
          ].map(([x, y]) => {
            const point =
              SVGSVGElement.prototype.createSVGPoint.call(reference);
            point.x = x;
            point.y = y;
            const mapped = SVGPoint.prototype.matrixTransform.call(
              point,
              transform,
            );
            return { x: mapped.x, y: mapped.y };
          });
        }
        const read = (element) => {
          const rect = Element.prototype.getBoundingClientRect.call(element);
          return {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          };
        };
        const actual = read(target);
        const origin = reference === null ? { x: 0, y: 0 } : read(reference);
        return {
          x: actual.x - origin.x,
          y: actual.y - origin.y,
          width: actual.width,
          height: actual.height,
        };
      }).toString(),
      arguments: [
        { value: selector },
        { value: relativeTo ?? null },
        { value: coordinateSpace },
      ],
      returnByValue: true,
    },
  );
  if (exceptionDetails || !result.value)
    throw new Error("Rendered bounds unavailable");
  return result.value;
}

function matchesRectangleCorners(actual, x, y, width, height, tolerance) {
  if (
    !Array.isArray(actual) ||
    actual.length !== 4 ||
    !actual.every(
      (point) => Number.isFinite(point.x) && Number.isFinite(point.y),
    )
  )
    return false;
  const expected = [
    { x, y },
    { x: x + width, y },
    { x: x + width, y: y + height },
    { x, y: y + height },
  ];
  const match = (index, remaining) =>
    index === actual.length ||
    remaining.some(
      (point, position) =>
        Math.abs(actual[index].x - point.x) <= tolerance &&
        Math.abs(actual[index].y - point.y) <= tolerance &&
        match(
          index + 1,
          remaining.filter((_, i) => i !== position),
        ),
    );
  return match(0, expected);
}

async function readActiveErrorMessage(client, locator, nodeId, relations) {
  const { frameTree } = await client.send("Page.getFrameTree");
  let utilityContext;
  const onContext = ({ context }) => {
    if (
      context.auxData?.frameId === frameTree.frame.id &&
      context.name.startsWith("__playwright_utility_world_")
    )
      utilityContext = context.id;
  };
  client.on("Runtime.executionContextCreated", onContext);
  try {
    await client.send("Runtime.enable");
  } finally {
    client.off("Runtime.executionContextCreated", onContext);
  }
  if (!utilityContext) throw new Error("Accessible text runtime unavailable");
  const { object } = await client.send("DOM.resolveNode", {
    nodeId,
    executionContextId: utilityContext,
  });
  let restore;
  const references = [];
  try {
    for (const relation of relations) {
      const resolved = await client.send("DOM.resolveNode", {
        backendNodeId: relation.backendDOMNodeId,
        executionContextId: utilityContext,
      });
      references.push(resolved.object.objectId);
    }
    // Utility-world facades map private virtual IDREFs to active native
    // relations, including unnamed reflection targets. Resolve the live
    // reflection again inside the synchronous text computation, without
    // disabling candidate scripts or discarding pending timer callbacks.
    // No real DOM attributes or candidate-world properties are changed.
    const masked = await client.send("Runtime.callFunctionOn", {
      objectId: object.objectId,
      functionDeclaration: function (prefix, ...elements) {
        const root = this.getRootNode();
        const reflection = Object.getOwnPropertyDescriptor(
          Element.prototype,
          "ariaErrorMessageElements",
        )?.get;
        if (!reflection) throw new Error("Native error reflection unavailable");
        const ids = elements.map((_, index) => `${prefix}${index}`);
        const selectors = new Map(
          ids.map((id, index) => [`#${id}`, elements[index]]),
        );
        const previous = Object.getOwnPropertyDescriptor(this, "getAttribute");
        const original = this.getAttribute;
        const previousQuery = Object.getOwnPropertyDescriptor(
          root,
          "querySelector",
        );
        const originalQuery = root.querySelector;
        const restoreQuery = () => {
          if (previousQuery)
            Object.defineProperty(root, "querySelector", previousQuery);
          else delete root.querySelector;
        };
        Object.defineProperty(root, "querySelector", {
          configurable: true,
          value(selector) {
            return selectors.has(selector)
              ? selectors.get(selector)
              : originalQuery.call(this, selector);
          },
        });
        try {
          Object.defineProperty(this, "getAttribute", {
            configurable: true,
            value(name) {
              if (name !== "aria-errormessage")
                return original.call(this, name);
              const live = reflection.call(this) ?? [];
              return ids
                .filter((_, index) => live.includes(elements[index]))
                .join(" ");
            },
          });
        } catch (error) {
          restoreQuery();
          throw error;
        }
        return () => {
          try {
            if (previous) Object.defineProperty(this, "getAttribute", previous);
            else delete this.getAttribute;
          } finally {
            restoreQuery();
          }
        };
      }.toString(),
      arguments: [
        { value: `distill-error-${randomUUID()}-` },
        ...references.map((objectId) => ({ objectId })),
      ],
    });
    restore = masked.result?.objectId;
    if (!restore) throw new Error("Accessible error readback unavailable");
    // Pinned Playwright computes text alternatives in its isolated utility
    // world. Its private API returns received text only on a mismatch, so a
    // constant never-match requests readback. Protected expectations stay here.
    const actual = await locator._expect("to.have.accessible.error.message", {
      expectedText: [{ regexSource: "(?!)" }],
      isNot: false,
      timeout: 1,
    });
    if (typeof actual.received?.value !== "string")
      throw new Error("Accessible error readback missing");
    return actual.received.value;
  } finally {
    try {
      if (restore)
        await client.send("Runtime.callFunctionOn", {
          objectId: restore,
          functionDeclaration: "function() { this(); }",
        });
    } finally {
      if (restore)
        await client.send("Runtime.releaseObject", { objectId: restore });
      for (const objectId of references)
        await client.send("Runtime.releaseObject", { objectId });
      await client.send("Runtime.releaseObject", { objectId: object.objectId });
    }
  }
}

let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
  if (Buffer.byteLength(input) > MAX_INPUT)
    throw new Error("Worker input exceeds limit");
}
const request = JSON.parse(input);
const imported = await import(pathToFileURL(process.argv[2]).href);
const { chromium } = imported.chromium ? imported : imported.default;
const viewport = request.spec.viewport ?? { width: 1000, height: 700 };
if (
  ![viewport.width, viewport.height].every(
    (n) => Number.isInteger(n) && n >= 320 && n <= 1600,
  )
)
  throw new Error("Invalid viewport");
// An explicit, freshly allocated profile keeps Playwright's recursive cleanup
// retries outside the evaluation time budget. It is never reused by another run.
const profile = await mkdtemp(join(tmpdir(), "distill-benchmark-browser-"));
const launchOptions = {
  executablePath: process.argv[3],
  headless: true,
  chromiumSandbox: true,
  args: [
    "--disable-background-networking",
    "--disable-extensions",
    "--disable-sync",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
  ],
  viewport,
  serviceWorkers: "block",
  acceptDownloads: false,
  permissions: [],
};
let blockedRequests = 0;
const checks = [];
const csp =
  "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'";
let context;
let result;
try {
  context = await chromium.launchPersistentContext(profile, launchOptions);
  await context.addInitScript(() => {
    for (const name of [
      "RTCPeerConnection",
      "webkitRTCPeerConnection",
      "RTCDataChannel",
      "WebTransport",
    ]) {
      Object.defineProperty(globalThis, name, {
        value: undefined,
        writable: false,
        configurable: false,
      });
    }
  });
  await context.route("**/*", (route) => {
    blockedRequests++;
    return route.abort("blockedbyclient");
  });
  await context.routeWebSocket("**/*", (socket) => {
    blockedRequests++;
    socket.close();
  });
  context.on("page", (page) => {
    if (context.pages().length > 1) void page.close();
  });
  const page = context.pages()[0] ?? (await context.newPage());
  page.setDefaultTimeout(1500);
  const shell = `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
  const quietShell =
    "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; img-src data:\">";
  await page.setContent(shell);
  const boundary = await page.evaluate(async () => ({
    node: typeof globalThis.process,
    require: typeof globalThis.require,
    tauri: typeof globalThis.__TAURI_INTERNALS__,
    network: await fetch("http://127.0.0.1:9/benchmark-boundary").then(
      () => true,
      () => false,
    ),
  }));
  if (
    boundary.node !== "undefined" ||
    boundary.require !== "undefined" ||
    boundary.tauri !== "undefined" ||
    boundary.network
  )
    throw new Error("Browser boundary verification failed");
  if (request.progressPath)
    await writeFile(request.progressPath, "candidate_started", { flag: "wx" });
  if (request.kind === "javascript") {
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(request.spec.functionName))
      throw new Error("Invalid function name");
    if (
      !Array.isArray(request.spec.argsCases) ||
      request.spec.argsCases.length < 1 ||
      request.spec.argsCases.length > 100
    )
      throw new Error("Expected 1-100 protected cases");
    const immutableArgs = request.spec.immutableArgs ?? [];
    if (
      !Array.isArray(immutableArgs) ||
      immutableArgs.some((index) => !Number.isInteger(index) || index < 0)
    )
      throw new Error("Invalid immutable argument indices");
    for (const [index, test] of request.spec.argsCases.entries()) {
      if (immutableArgs.some((argument) => argument >= test.args.length))
        throw new Error("Immutable argument index is outside the case inputs");
      try {
        // No expected value crosses this boundary. Each case receives a fresh realm.
        await page.goto("about:blank");
        await page.setContent(shell);
        const actual = await page.evaluate(
          async ({ source, name, args }) => {
            const run = new Function(
              "args",
              `"use strict";\n${source}\n;return ${name}(...args);`,
            );
            // Retain the actual argument references in the controller closure;
            // the candidate supplies its result, never an immutability verdict.
            return { result: await run(args), args };
          },
          {
            source: request.output,
            name: request.spec.functionName,
            args: test.args,
          },
        );
        const outputMatches = isDeepStrictEqual(actual.result, test.expected);
        const inputsPreserved = immutableArgs.every((argument) =>
          isDeepStrictEqual(actual.args[argument], test.args[argument]),
        );
        checks.push({
          index,
          pass: outputMatches && inputsPreserved,
          outputMatches,
          inputsPreserved,
        });
      } catch {
        checks.push({ index, pass: false });
      }
    }
  } else if (request.kind === "browser") {
    if (
      request.spec.timeoutSeconds !== undefined &&
      (!Number.isInteger(request.spec.timeoutSeconds) ||
        request.spec.timeoutSeconds < 1 ||
        request.spec.timeoutSeconds > 1200)
    )
      throw new Error("Invalid browser time budget");
    if (
      request.spec.stopOnFailure !== undefined &&
      typeof request.spec.stopOnFailure !== "boolean"
    )
      throw new Error("Invalid failure policy");
    if (
      !Array.isArray(request.spec.steps) ||
      request.spec.steps.length < 1 ||
      request.spec.steps.length > 200
    )
      throw new Error("Expected 1-200 protected interactions");
    for (const step of request.spec.steps) {
      if (
        step.timeoutMs !== undefined &&
        (!Number.isInteger(step.timeoutMs) ||
          step.timeoutMs < 1 ||
          step.timeoutMs > 5000)
      )
        throw new Error("Invalid interaction time budget");
    }
    await page.setContent(shell + request.output, {
      waitUntil: "domcontentloaded",
    });
    for (const [index, step] of request.spec.steps.entries()) {
      if (typeof step.selector !== "string" || step.selector.length > 1000)
        throw new Error("Invalid selector");
      const locator = page.locator(step.selector);
      const deadline = performance.now() + (step.timeoutMs ?? 0);
      const locatorOptions = () => ({
        timeout:
          step.timeoutMs === undefined
            ? 1500
            : Math.max(1, deadline - performance.now()),
      });
      let boundsClient;
      let boundsContext;
      let passed = false;
      let finalObservation = false;
      try {
        do {
          if (step.timeoutMs !== undefined && performance.now() >= deadline)
            finalObservation = true;
          // Action locators wait for readiness once; only observations retry.
          // Expectations and the retry clock remain in this controller process.
          try {
            if (step.action === "fill")
              await locator.fill(String(step.value), locatorOptions());
            else if (step.action === "click")
              await locator.click(locatorOptions());
            else if (step.action === "selectOption") {
              if (typeof step.value !== "string")
                throw new Error("Expected an option value");
              await locator.selectOption(
                { value: step.value },
                locatorOptions(),
              );
            } else if (step.action === "press")
              await locator.press(String(step.value), locatorOptions());
            else if (
              step.action === "expectAccessibleName" ||
              step.action === "expectAccessibleDescription" ||
              step.action === "expectAccessibleError"
            ) {
              // Chromium computes these properties; candidate JavaScript cannot
              // replace an element getter to report text the browser does not use.
              const property =
                step.action === "expectAccessibleName" ? "name" : "description";
              const errorMessage = step.action === "expectAccessibleError";
              if (
                (property === "description" || step.value !== undefined) &&
                typeof step.value !== "string"
              )
                throw new Error("Expected accessible text");
              const client = await context.newCDPSession(page);
              try {
                if ((await locator.count()) !== 1)
                  throw new Error("Expected one accessible control");
                const { root } = await client.send("DOM.getDocument");
                const { nodeId } = await client.send("DOM.querySelector", {
                  nodeId: root.nodeId,
                  selector: step.selector,
                });
                const { nodes } = await client.send(
                  "Accessibility.getPartialAXTree",
                  { nodeId, fetchRelatives: false },
                );
                if (errorMessage) {
                  const expected = normalizeAccessibleText(step.value);
                  if (!expected)
                    throw new Error("Expected nonempty error text");
                  let matched = nodes.some(
                    (node) =>
                      !node.ignored &&
                      normalizeAccessibleText(
                        node.description?.value ?? "",
                      ).includes(expected),
                  );
                  const relations = nodes
                    .filter((node) => !node.ignored)
                    .flatMap((node) => node.properties ?? [])
                    .filter((entry) => entry.name === "errormessage")
                    .flatMap((entry) => entry.value.relatedNodes ?? []);
                  if (!matched && relations.length) {
                    const actual = await readActiveErrorMessage(
                      client,
                      locator,
                      nodeId,
                      relations,
                    );
                    matched =
                      normalizeAccessibleText(actual).includes(expected);
                  }
                  if (!matched)
                    throw new Error("Accessible error text missing");
                  const after = await client.send("DOM.querySelector", {
                    nodeId: root.nodeId,
                    selector: step.selector,
                  });
                  if (after.nodeId !== nodeId)
                    throw new Error("Accessible control changed");
                  const afterTree = await client.send(
                    "Accessibility.getPartialAXTree",
                    { nodeId, fetchRelatives: false },
                  );
                  const activeState = (tree) =>
                    tree
                      .filter((node) => !node.ignored)
                      .map((node) => ({
                        description: node.description?.value,
                        relations: (node.properties ?? [])
                          .filter((entry) => entry.name === "errormessage")
                          .flatMap((entry) => entry.value.relatedNodes ?? [])
                          .map((relation) => relation.backendDOMNodeId),
                      }));
                  if (
                    !isDeepStrictEqual(
                      activeState(nodes),
                      activeState(afterTree.nodes),
                    )
                  )
                    throw new Error("Accessible error relation changed");
                } else if (
                  !nodes.some(
                    (node) =>
                      !node.ignored &&
                      (step.value === undefined
                        ? typeof node[property]?.value === "string" &&
                          node[property].value.trim()
                        : (node[property]?.value ?? "") === step.value),
                  )
                )
                  throw new Error("Accessible text mismatch");
              } finally {
                await client.detach();
              }
            } else if (step.action === "expectText") {
              if (
                (await locator.textContent(locatorOptions()))?.trim() !==
                step.value
              )
                throw new Error("Text mismatch");
            } else if (step.action === "expectValue") {
              if ((await locator.inputValue(locatorOptions())) !== step.value)
                throw new Error("Value mismatch");
            } else if (step.action === "expectCount") {
              if ((await locator.count()) !== step.value)
                throw new Error("Count mismatch");
            } else if (step.action === "expectSize") {
              const size = step.value;
              if (!size || typeof size !== "object" || Array.isArray(size))
                throw new Error("Expected rendered dimensions");
              const { width, height, tolerance = 0.5 } = size;
              if (
                ![width, height, tolerance].every(
                  (value) => Number.isFinite(value) && value >= 0,
                )
              )
                throw new Error("Invalid rendered dimensions");
              if ((await locator.count()) !== 1)
                throw new Error("Expected one sized element");
              // Playwright reads Chromium's layout box outside candidate scripts.
              // CSS and element attributes may produce the same rendered size.
              const actual = await locator.boundingBox(locatorOptions());
              if (
                !actual ||
                Math.abs(actual.width - width) > tolerance ||
                Math.abs(actual.height - height) > tolerance
              )
                throw new Error("Rendered size mismatch");
            } else if (step.action === "expectBounds") {
              const bounds = step.value;
              if (
                !bounds ||
                typeof bounds !== "object" ||
                Array.isArray(bounds)
              )
                throw new Error("Expected rendered bounds");
              const {
                x,
                y,
                width,
                height,
                relativeTo,
                coordinateSpace = "css",
                tolerance = 0.5,
              } = bounds;
              if (
                ![x, y].every(Number.isFinite) ||
                !["css", "svg"].includes(coordinateSpace) ||
                (coordinateSpace === "svg" && relativeTo === undefined) ||
                ![width, height, tolerance].every(
                  (value) => Number.isFinite(value) && value >= 0,
                ) ||
                (relativeTo !== undefined &&
                  (typeof relativeTo !== "string" ||
                    !relativeTo.trim() ||
                    relativeTo.length > 1000))
              )
                throw new Error("Invalid rendered bounds");
              boundsClient ??= await context.newCDPSession(page);
              boundsContext ??= await createBoundsContext(boundsClient);
              const actual = await readRenderedBounds(
                boundsClient,
                boundsContext,
                step.selector,
                relativeTo,
                coordinateSpace,
              );
              if (
                coordinateSpace === "svg"
                  ? !matchesRectangleCorners(
                      actual,
                      x,
                      y,
                      width,
                      height,
                      tolerance,
                    )
                  : ![actual.x, actual.y, actual.width, actual.height].every(
                      Number.isFinite,
                    ) ||
                    Math.abs(actual.x - x) > tolerance ||
                    Math.abs(actual.y - y) > tolerance ||
                    Math.abs(actual.width - width) > tolerance ||
                    Math.abs(actual.height - height) > tolerance
              )
                throw new Error("Rendered bounds mismatch");
            } else throw new Error("Unsupported interaction");
            passed = true;
            break;
          } catch {
            if (
              !ASSERTIONS.has(step.action) ||
              step.timeoutMs === undefined ||
              finalObservation
            )
              break;
            const remaining = deadline - performance.now();
            if (remaining > 0)
              await new Promise((resolve) =>
                setTimeout(resolve, Math.min(25, remaining)),
              );
          }
        } while (!finalObservation);
      } finally {
        await boundsClient?.detach();
      }
      checks.push({ index, pass: passed });
      if (!passed && request.spec.stopOnFailure) break;
    }
  } else if (request.kind === "render") {
    // A drawing or page for the judge panel: no scripts, no checks, one picture.
    await page.setContent(quietShell + request.output, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForTimeout(400);
  } else throw new Error("Unsupported artifact evaluator");
  if (request.screenshotPath) {
    const screenshot = await page.screenshot({ type: "png", timeout: 3000 });
    if (screenshot.length > 2 * 1024 * 1024)
      throw new Error("Screenshot exceeds artifact cap");
    await writeFile(request.screenshotPath, screenshot, { flag: "wx" });
  }
  result = {
    pass: checks.every((check) => check.pass),
    checks,
    boundary,
    blockedRequests,
    browserVersion: context.browser().version(),
  };
} catch (error) {
  result = { error: String(error.message ?? error) };
  process.exitCode = 1;
} finally {
  await context?.close();
  // Only remove the exact profile returned by mkdtemp above. On Windows, Edge
  // profile files can deny deletion after the browser exits. Do not retry every
  // file recursively and turn a completed check into a candidate timeout.
  try {
    await rm(profile, { recursive: true, force: true, maxRetries: 0 });
  } catch (error) {
    result.cleanupWarning = { code: error.code, retainedProfile: profile };
  }
}
process.stdout.write(JSON.stringify(result));
