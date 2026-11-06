/**
 * Tests for the Kimi Code steering preload,
 * src-tauri/resources/kimi-acp-steering.mjs.
 *
 * The preload edits Kimi's bundle as Node loads it. These tests run its edits
 * on an invented bundle that carries the same anchors, and drive the
 * resulting ACP server: what it advertises, what `_session/steering`
 * answers, and that a bundle without an anchor stays as it is. `node --test`,
 * wired into `pnpm test:scripts`.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const preloadPath = fileURLToPath(
  new URL("../src-tauri/resources/kimi-acp-steering.mjs", import.meta.url),
);
const { addSteering } = await import(pathToFileURL(preloadPath).href);

// The shape of Kimi Code's ACP server where the edits apply, indented as in
// its bundle.
const bundle = [
  "var RequestError$1 = class RequestError$1 extends Error {",
  "\tstatic invalidParams(_data, message) { return new RequestError$1(message); }",
  "};",
  'var SET_SESSION_MODEL_METHOD = "session/set_model";',
  "function parseSetSessionModelParams(params) { return params; }",
  "export function agentFacade(call, scope) {",
  "\treturn {",
  '\t\tsteer: (input) => call(scope, "agentPromptService", "submitSteer", [input]),',
  "\t};",
  "}",
  "// The engine keeps a turn going for a message steered into its last step:",
  "// if (this.hasLiveNudge()) return;",
  "export function createAcpAgentApp(getServer) {",
  "\tconst routes = new Map();",
  "\tconst app = { onRequest(method, parse, handler) { routes.set(method, (params) => handler({ params: parse(params) })); return app; } };",
  "\tapp.onRequest(SET_SESSION_MODEL_METHOD, parseSetSessionModelParams, (ctx) => getServer().setSessionModel(ctx.params));",
  "\treturn routes;",
  "}",
  "export var AcpSession;",
  "{",
  "\tAcpSession = class {",
  "\t\tconstructor(agent) { this.agent = agent; }",
  "\t\tasync preparePromptContent(blocks) {",
  "\t\t\tawait this.whilePreparing?.();",
  '\t\t\treturn blocks.map((block) => ({ type: "text", text: block.text }));',
  "\t\t}",
  "\t\tdriveLaunch(launch) {",
  "\t\t\tconst driver = { settled: false };",
  "\t\t\tthis.driver = driver;",
  "\t\t\treturn launch.then((launched) => {",
  "\t\t\t\tdriver.turnId = launched.turn_id;",
  "\t\t\t\tif (driver.cancelRequested === true) driver.settled = true;",
  "\t\t\t});",
  "\t\t}",
  "\t\tassertNoActiveTurn() {}",
  "\t\tdriveTurn(input) {",
  "\t\t\tthis.assertNoActiveTurn();",
  "\t\t\treturn this.driveLaunch(this.agent.prompt({ input }));",
  "\t\t}",
  "\t};",
  "}",
  "export var AcpServer;",
  "{",
  "\tAcpServer = class {",
  '\t\tconstructor(sessions) { this.sessions = sessions; this.agentInfo = { name: "kimi" }; }',
  "\t\tasync initialize() {",
  "\t\t\treturn {",
  "\t\t\t\tprotocolVersion: 1,",
  "\t\t\t\t...this.agentInfo ? { agentInfo: this.agentInfo } : {}",
  "\t\t\t};",
  "\t\t}",
  "\t\tasync prompt(params, signal) {",
  "\t\t\tconst acpSession = this.sessions.get(params.sessionId);",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: invented bundle source text
  "\t\t\tif (!acpSession) throw RequestError$1.invalidParams(void 0, `Unknown sessionId: ${params.sessionId}`);",
  "\t\t\treturn acpSession.prompt(params.prompt);",
  "\t\t}",
  "\t};",
  "}",
  "",
].join("\n");

const work = mkdtempSync(join(tmpdir(), "flock-kimi-steering-"));
after(() => rmSync(work, { recursive: true, force: true }));

async function load(source, name) {
  const file = join(work, `${name}.mjs`);
  writeFileSync(file, source);
  return import(pathToFileURL(file).href);
}

const steered = addSteering(bundle);
assert.equal(steered.missing, undefined);
const kimi = await load(steered.source, "steered");

/** A Kimi server with one session whose engine answers a steer with `turn`
 * (`null` for no turn). */
function server({ running = true, turn = 7, ...driver } = {}) {
  const steers = [];
  const agent = {
    steer: async (payload) => {
      steers.push(payload);
      return turn === null ? undefined : { turn_id: turn };
    },
  };
  const session = new kimi.AcpSession(agent);
  if (running) session.driver = { settled: false, turnId: 7, ...driver };
  const acp = new kimi.AcpServer(new Map([["session-1", session]]));
  const routes = kimi.createAcpAgentApp(() => acp);
  const steer = (params) => routes.get("_session/steering")(params);
  return { acp, session, steers, steer };
}

const request = (text = "Look at the parser too.") => ({
  sessionId: "session-1",
  prompt: [{ type: "text", text }],
  _meta: { steering: { idleBehavior: "promptRequired" } },
});

describe("Kimi Code with the steering preload", () => {
  it("advertises steering as Claude Code's adapter does", async () => {
    const { acp } = server();
    const init = await acp.initialize();
    assert.deepEqual(init._meta, { steering: { supported: true } });
    assert.deepEqual(init.agentInfo, { name: "kimi" });
  });

  it("steers a message into the running turn of a prompt", async () => {
    const { steer, steers } = server();
    assert.deepEqual(await steer(request()), { outcome: "injected" });
    assert.deepEqual(steers, [
      { input: [{ type: "text", text: "Look at the parser too." }] },
    ]);
  });

  it("leaves the message to a prompt when no prompt's turn runs", async () => {
    for (const state of [
      { running: false },
      { settled: true },
      { turnId: undefined },
      { cancelRequested: true },
    ]) {
      const { steer, steers } = server(state);
      assert.deepEqual(
        await steer(request()),
        { outcome: "promptRequired", reason: "noRunningTurn" },
        JSON.stringify(state),
      );
      assert.deepEqual(steers, []);
    }
  });

  it("does not steer into a turn that settled while the message was prepared", async () => {
    const { session, steer, steers } = server();
    session.whilePreparing = async () => {
      session.driver.settled = true;
    };
    assert.deepEqual(await steer(request()), {
      outcome: "promptRequired",
      reason: "noRunningTurn",
    });
    assert.deepEqual(steers, []);
  });

  it("says so when the engine ran the message as a turn of its own", async () => {
    // null: the engine launched nothing it could name.
    for (const turn of [8, null]) {
      const { steer } = server({ turn });
      assert.deepEqual(await steer(request()), { outcome: "startedNewTurn" });
    }
  });

  it("refuses malformed requests and unknown sessions", async () => {
    const { steer } = server();
    await assert.rejects(async () =>
      steer({ sessionId: "session-1", prompt: [] }),
    );
    await assert.rejects(async () => steer({ prompt: request().prompt }));
    await assert.rejects(
      async () =>
        steer({
          ...request(),
          _meta: { steering: { idleBehavior: "startTurn" } },
        }),
      /unsupported steering idleBehavior/,
    );
    await assert.rejects(
      async () => steer({ ...request(), sessionId: "session-2" }),
      /Unknown sessionId: session-2/,
    );
  });

  it("leaves a bundle without an anchor, or with one twice, as it is", () => {
    assert.deepEqual(
      addSteering(bundle.replace("driveTurn(input)", "runTurn(input)")),
      { missing: "session steering" },
    );
    assert.deepEqual(
      addSteering(bundle.replace("async preparePromptContent(blocks) {", "")),
      { missing: "async preparePromptContent(blocks) {" },
    );
    const twice = bundle.replace(
      "export var AcpServer;",
      "// \t\t\t\t...this.agentInfo ? { agentInfo: this.agentInfo } : {}\n\t\t\t};\nexport var AcpServer;",
    );
    assert.deepEqual(addSteering(twice), { missing: "steering capability" });
  });

  it("takes itself out of what Kimi's process passes on", () => {
    const own = `--import=data:text/javascript;base64,${readFileSync(preloadPath).toString("base64")}`;
    const report =
      "const { execFileSync } = require('node:child_process');" +
      "console.log(JSON.stringify(process.env.NODE_OPTIONS ?? null));" +
      "console.log(execFileSync(process.execPath, ['-e', 'console.log(JSON.stringify(process.env.NODE_OPTIONS ?? null))']).toString().trim());";
    const run = (options) =>
      execFileSync(process.execPath, ["-e", report], {
        env: { ...process.env, NODE_OPTIONS: options },
      })
        .toString()
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    assert.deepEqual(run(`--max-old-space-size=4096 ${own}`), [
      "--max-old-space-size=4096",
      "--max-old-space-size=4096",
    ]);
    assert.deepEqual(run(own), [null, null]);
  });
});
