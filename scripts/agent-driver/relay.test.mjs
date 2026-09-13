/**
 * Tests for the agent driver relay.
 *
 * `node --test`, no vitest: the relay's whole point is to work on a machine
 * where the agent cannot install anything, and a test that needs the very
 * toolchain the relay exists to reach would be untestable at exactly the
 * moment it mattered. `node --test` runs from a bare checkout.
 *
 * The end-to-end cases run a real relay against a fake driver socket, because
 * every bug this thing can have lives in the seams: a half-written answer
 * file, a lane that stays busy, an envelope deleted before its answer landed.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  ALLOWED_COMMANDS,
  buildCmdLine,
  clamp,
  createPendingAnswers,
  createRelay,
  MAX_PENDING_ANSWERS,
  parseArgs,
  quoteForCmd,
  resolveCwd,
  resolveExecutable,
  tail,
} from "./relay.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");

describe("quoteForCmd", () => {
  it("wraps a plain argument", () => {
    assert.equal(quoteForCmd("vitest"), '"vitest"');
  });

  it("keeps a path with spaces in one piece", () => {
    assert.equal(quoteForCmd("C:\\Program Files\\x"), '"C:\\Program Files\\x"');
  });

  it("escapes an embedded quote and the backslashes in front of it", () => {
    assert.equal(quoteForCmd('say "hi"'), '"say \\"hi\\""');
  });

  it("doubles trailing backslashes so the closing quote survives", () => {
    // Without this, cmd.exe reads the final \" as an escaped quote and the
    // argument swallows everything after it.
    assert.equal(quoteForCmd("C:\\dir\\"), '"C:\\dir\\\\"');
  });
});

describe("buildCmdLine", () => {
  // `cmd /s` strips only the first and last quote character of the whole
  // line it is handed, not each token's own quotes — so the line must carry
  // one extra pair around everything, matching WindowsDev.psm1's
  // `` "/d /s /c `"$command`"" `` and Node's own `shell: true` behaviour.

  it("wraps the resolved path and every argument, then wraps the lot again", () => {
    assert.equal(
      buildCmdLine("C:\\...\\pnpm.cmd", ["vitest", "run"]),
      '""C:\\...\\pnpm.cmd" "vitest" "run""',
    );
  });

  it("keeps a path with spaces intact after both strips", () => {
    // After cmd removes the outer pair: `"C:\Program Files\pnpm.cmd" "-v"`,
    // which is exactly what tokenizes back into two arguments.
    assert.equal(
      buildCmdLine("C:\\Program Files\\pnpm.cmd", ["-v"]),
      '""C:\\Program Files\\pnpm.cmd" "-v""',
    );
  });

  it("survives with no arguments at all", () => {
    assert.equal(buildCmdLine("just.cmd", []), '""just.cmd""');
  });
});

describe("clamp", () => {
  it("passes a value already inside the range through", () => {
    assert.equal(clamp(5, 0, 10), 5);
  });

  it("floors a value below the minimum", () => {
    assert.equal(clamp(-10_000, 0, 10), 0);
  });

  it("ceils a value above the maximum", () => {
    assert.equal(clamp(999_999, 0, 10), 10);
  });
});

describe("tail", () => {
  it("returns short output untouched", () => {
    assert.equal(tail("all good"), "all good");
  });

  it("keeps the end, which is where the failure is", () => {
    const result = tail("abcdefghij", 4);
    assert.ok(result.endsWith("ghij"));
    assert.match(result, /6 earlier characters/);
  });
});

describe("resolveCwd", () => {
  const repo = path.resolve("/repo");
  const relay = path.resolve("/relay");

  it("reads a relative path against the repository", () => {
    assert.equal(resolveCwd("sdk", repo, relay), path.join(repo, "sdk"));
  });

  it("allows the roots themselves", () => {
    assert.equal(resolveCwd(".", repo, relay), repo);
    assert.equal(resolveCwd(relay, repo, relay), relay);
  });

  it("refuses a path that climbs out", () => {
    assert.equal(resolveCwd("../../etc", repo, relay), null);
  });

  it("does not mistake a sibling with a shared prefix for a child", () => {
    assert.equal(resolveCwd("/repo-other", repo, relay), null);
  });
});

describe("resolveExecutable", () => {
  it("finds a real binary on PATH", () => {
    assert.ok(resolveExecutable("node", process.env, process.platform));
  });

  it("prefers the .cmd shim over npm's extensionless bash script on Windows", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "relay-exe-"));
    try {
      writeFileSync(path.join(dir, "pnpm"), "#!/bin/sh\n");
      writeFileSync(path.join(dir, "pnpm.cmd"), "@echo off\r\n");
      // Lower-case: the test also runs on case-sensitive file systems.
      const env = { PATH: dir, PATHEXT: ".exe;.cmd" };
      assert.equal(
        resolveExecutable("pnpm", env, "win32"),
        path.join(dir, "pnpm.cmd"),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null for something that is not there", () => {
    assert.equal(
      resolveExecutable("definitely-not-a-command-9f3a", process.env, "linux"),
      null,
    );
  });
});

describe("parseArgs", () => {
  it("defaults to the legacy driver port", () => {
    assert.equal(parseArgs([]).port, 9999);
  });

  it("refuses a port that is not a port", () => {
    assert.throws(() => parseArgs(["--port", "0"]), /between 1 and 65535/);
  });

  it("refuses an argument it does not know", () => {
    assert.throws(() => parseArgs(["--exec-anything"]), /Unknown argument/);
  });
});

describe("the relay end to end", () => {
  let server;
  let relay;
  let root;
  let port;

  before(async () => {
    server = net.createServer((socket) => {
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        let newline = buffer.indexOf("\n");
        while (newline !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          let command;
          try {
            command = JSON.parse(line);
          } catch {
            socket.write(
              `${JSON.stringify({ success: false, error: "Invalid JSON" })}\n`,
            );
            newline = buffer.indexOf("\n");
            continue;
          }
          const answer =
            command.action === "snapshot"
              ? { success: true, data: "[e1] button Send" }
              : command.action === "active"
                ? { success: true, data: "body" }
                : {
                    success: false,
                    error: `Unsupported test driver action: ${command.action}`,
                  };
          socket.write(`${JSON.stringify(answer)}\n`);
          newline = buffer.indexOf("\n");
        }
      });
      socket.on("error", () => {});
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = server.address().port;
    root = mkdtempSync(path.join(tmpdir(), "agent-driver-"));
    relay = createRelay({ root, port, repoRoot: REPO_ROOT });
  });

  after(() => {
    relay?.stop();
    server?.close();
  });

  /** Drop an envelope the way the agent does: write, then rename into place. */
  function post(id, envelope) {
    const target = path.join(relay.paths.inbox, `${id}.json`);
    writeFileSync(`${target}.tmp`, JSON.stringify(envelope), "utf8");
    renameSync(`${target}.tmp`, target);
  }

  async function collect(id, timeoutMs = 20_000) {
    const file = path.join(relay.paths.outbox, `${id}.json`);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        return JSON.parse(readFileSync(file, "utf8"));
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    throw new Error(`No answer for ${id} within ${timeoutMs}ms`);
  }

  it("forwards a driver action and brings the answer back", async () => {
    post("d1", { kind: "driver", action: "snapshot" });
    const answer = await collect("d1");
    assert.equal(answer.ok, true);
    assert.equal(answer.data, "[e1] button Send");
  });

  it("reports a driver refusal as a failed answer, not a hang", async () => {
    post("d2", { kind: "driver", action: "nope" });
    const answer = await collect("d2");
    assert.equal(answer.ok, false);
    assert.match(answer.error, /Unsupported test driver action/);
  });

  it("runs an allowed command and returns its exit code", async () => {
    post("e1", {
      kind: "exec",
      cmd: "node",
      args: ["-e", "process.stdout.write('hi')"],
    });
    const answer = await collect("e1");
    assert.equal(answer.ok, true);
    assert.equal(answer.code, 0);
    assert.equal(answer.stdoutTail, "hi");
  });

  it("returns a non-zero exit as a failure with the output kept", async () => {
    post("e2", { kind: "exec", cmd: "node", args: ["-e", "process.exit(3)"] });
    const answer = await collect("e2");
    assert.equal(answer.ok, false);
    assert.equal(answer.code, 3);
    assert.ok(answer.logFile);
  });

  it("refuses a command outside the allowlist by name", async () => {
    post("e3", { kind: "exec", cmd: "rm", args: ["-rf", "/"] });
    const answer = await collect("e3");
    assert.equal(answer.ok, false);
    assert.match(answer.error, /not an allowed command/);
    for (const allowed of ALLOWED_COMMANDS)
      assert.match(answer.error, new RegExp(allowed));
  });

  it("refuses a cwd outside both roots", async () => {
    post("e4", {
      kind: "exec",
      cmd: "node",
      args: ["-e", ""],
      cwd: "../../etc",
    });
    const answer = await collect("e4");
    assert.equal(answer.ok, false);
    assert.match(answer.error, /cwd must be inside/);
  });

  it("kills a command that outruns its timeout and says so", async () => {
    post("e5", {
      kind: "exec",
      cmd: "node",
      args: ["-e", "setTimeout(() => {}, 60000)"],
      timeoutMs: 1_000,
    });
    const answer = await collect("e5");
    assert.equal(answer.ok, false);
    assert.equal(answer.timedOut, true);
  });

  it("answers an unparseable envelope instead of swallowing it", async () => {
    const target = path.join(relay.paths.inbox, "x1.json");
    writeFileSync(`${target}.tmp`, "not json", "utf8");
    renameSync(`${target}.tmp`, target);
    const answer = await collect("x1");
    assert.equal(answer.ok, false);
    assert.match(answer.error, /not valid JSON/);
  });

  it("waits for an envelope that is still being written", async () => {
    // A copy onto the mount can land in pieces; the first piece is not JSON
    // yet, and must not be answered as garbage and deleted.
    const target = path.join(relay.paths.inbox, "p1.json");
    writeFileSync(target, '{"kind":"control",', "utf8");
    await new Promise((resolve) => setTimeout(resolve, 600));
    writeFileSync(target, '{"kind":"control","action":"ping"}', "utf8");
    const answer = await collect("p1");
    assert.equal(answer.ok, true);
    assert.equal(answer.pong, true);
  });

  it("answers a timed-out command even when a grandchild holds its output", async () => {
    // Killing the direct child is not enough when something it started still
    // has stdout open; the lane used to stay busy until that process died.
    const script = [
      "const { spawn } = require('node:child_process');",
      "spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {",
      "  stdio: 'inherit',",
      "});",
      "setTimeout(() => {}, 30000);",
    ].join("\n");
    post("e6", {
      kind: "exec",
      cmd: "node",
      args: ["-e", script],
      timeoutMs: 1_000,
    });
    const answer = await collect("e6");
    assert.equal(answer.ok, false);
    assert.equal(answer.timedOut, true);
  });

  it("names an envelope kind it does not know", async () => {
    post("x2", { kind: "telepathy" });
    const answer = await collect("x2");
    assert.equal(answer.ok, false);
    assert.match(answer.error, /Unknown envelope kind/);
  });

  it("answers a control ping", async () => {
    post("c1", { kind: "control", action: "ping" });
    const answer = await collect("c1");
    assert.equal(answer.ok, true);
    assert.equal(answer.pong, true);
  });

  it("clears every envelope out of the inbox", async () => {
    assert.deepEqual(
      readdirSync(relay.paths.inbox).filter((f) => f.endsWith(".json")),
      [],
    );
  });

  it("keeps a heartbeat that says which port it watches", async () => {
    const beat = JSON.parse(readFileSync(relay.paths.heartbeat, "utf8"));
    assert.equal(beat.driverPort, port);
    assert.deepEqual(beat.allowedCommands, ALLOWED_COMMANDS);
  });
});

describe("when the outbox cannot be written", () => {
  // A directory sitting where `<id>.json` must land reproduces, on any OS,
  // the same failure a Windows sync client/AV holding the file open would
  // cause: `writeAtomic`'s rename refuses because the target is not a plain
  // file. The relay used to treat that as "never answered" and re-claim (and
  // re-run) the envelope on every 250ms poll for as long as that lasted.
  let relay;
  let root;

  before(() => {
    root = mkdtempSync(path.join(tmpdir(), "agent-driver-blocked-"));
    relay = createRelay({ root, port: 1, repoRoot: REPO_ROOT });
    // Block the exact path `answer("e1", …)` writes to.
    mkdirSync(path.join(relay.paths.outbox, "e1.json"), { recursive: true });
  });

  after(() => {
    relay?.stop();
  });

  it("runs the command exactly once even though the answer cannot be written yet", async () => {
    const counter = path.join(root, "counter.txt");
    writeFileSync(counter, "0", "utf8");
    const target = path.join(relay.paths.inbox, "e1.json");
    writeFileSync(
      `${target}.tmp`,
      JSON.stringify({
        kind: "exec",
        cmd: "node",
        args: [
          "-e",
          `require("fs").writeFileSync(${JSON.stringify(counter)}, String(Number(require("fs").readFileSync(${JSON.stringify(counter)}, "utf8")) + 1))`,
        ],
      }),
      "utf8",
    );
    renameSync(`${target}.tmp`, target);

    // Several poll intervals: a re-executing relay would have run the
    // command many times over by now (the regression measured 8+ in 2.2s).
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    assert.equal(readFileSync(counter, "utf8"), "1");
    // The envelope already produced a body, so it must be gone from inbox/
    // regardless of whether the answer could be written.
    assert.deepEqual(
      readdirSync(relay.paths.inbox).filter((f) => f.endsWith(".json")),
      [],
    );

    // Once the obstruction clears, the cached body is still delivered — the
    // side effect must never repeat just because the write is retried.
    rmSync(path.join(relay.paths.outbox, "e1.json"), {
      recursive: true,
      force: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const answer = JSON.parse(
      readFileSync(path.join(relay.paths.outbox, "e1.json"), "utf8"),
    );
    assert.equal(answer.ok, true);
    assert.equal(readFileSync(counter, "utf8"), "1");
  });
});

describe("a driver envelope with an out-of-range timeout", () => {
  // Regression: `socket.setTimeout(negative)` throws synchronously, and that
  // throw used to happen before the socket's `'error'` listener was
  // attached. With the app not running (ECONNREFUSED), the resulting
  // listener-less `'error'` event crashed the whole relay process, not just
  // this one command — so this must run out of process to be a meaningful
  // check: an in-process crash would take the entire test file down with it
  // rather than fail cleanly.
  it("answers with a failure instead of crashing the relay", () => {
    const root = mkdtempSync(path.join(tmpdir(), "agent-driver-timeout-"));
    const relayUrl = pathToFileURL(path.join(HERE, "relay.mjs")).href;
    const child = [
      `import { createRelay } from ${JSON.stringify(relayUrl)};`,
      `import { readFileSync, renameSync, writeFileSync } from "node:fs";`,
      `import path from "node:path";`,
      // Port 1 is privileged and nothing on this machine listens there, so
      // the connection attempt refuses immediately (ECONNREFUSED) instead of
      // hanging — exactly the "app not running" case the finding describes.
      `const relay = createRelay({ root: ${JSON.stringify(root)}, port: 1, repoRoot: ${JSON.stringify(REPO_ROOT)} });`,
      `const target = path.join(relay.paths.inbox, "d1.json");`,
      `writeFileSync(\`\${target}.tmp\`, JSON.stringify({ kind: "driver", action: "snapshot", timeout: -10000 }), "utf8");`,
      `renameSync(\`\${target}.tmp\`, target);`,
      `const outFile = path.join(relay.paths.outbox, "d1.json");`,
      `const deadline = Date.now() + 5_000;`,
      `while (Date.now() < deadline) {`,
      `  try { readFileSync(outFile, "utf8"); break; } catch {}`,
      `  await new Promise((r) => setTimeout(r, 50));`,
      `}`,
      `relay.stop();`,
    ].join("\n");

    // Throws (non-zero exit / signal) if the child process crashed instead
    // of exiting cleanly once the answer was written.
    execFileSync(process.execPath, ["--input-type=module", "-e", child], {
      timeout: 10_000,
    });

    const answer = JSON.parse(
      readFileSync(path.join(root, "outbox", "d1.json"), "utf8"),
    );
    assert.equal(answer.ok, false);
    assert.match(answer.error, /Cannot reach the app test driver/);
  });
});

describe("the undeliverable-answer store", () => {
  function refuse() {
    throw new Error("EPERM");
  }

  it("keeps at most MAX_PENDING_ANSWERS bodies, dropping the oldest", () => {
    // A permanently unwritable outbox/ used to grow this map forever: every
    // answer produced for the rest of the process's life, held in memory.
    const logs = [];
    const pending = createPendingAnswers({ onLog: (line) => logs.push(line) });

    for (let index = 0; index < MAX_PENDING_ANSWERS + 5; index += 1) {
      pending.hold(`e${index}`, { ok: true });
    }

    assert.equal(pending.size, MAX_PENDING_ANSWERS);
    assert.equal(pending.has("e0"), false);
    assert.equal(pending.has(`e${MAX_PENDING_ANSWERS + 4}`), true);
    assert.equal(
      logs.filter((line) => line.includes("answer dropped")).length,
      5,
    );
  });

  it("logs a body that will not land once per interval, not once per poll", () => {
    // The poll runs every 250 ms, so the old code wrote about four lines a
    // second per stuck body — the kind of failure that fills a disk unwatched.
    const logs = [];
    const pending = createPendingAnswers({
      logIntervalMs: 1_000,
      onLog: (line) => logs.push(line),
    });
    pending.hold("e1", { ok: true });

    for (let now = 0; now < 1_000; now += 250) {
      pending.flush(refuse, now);
    }
    assert.equal(logs.length, 1);

    pending.flush(refuse, 1_000);
    assert.equal(logs.length, 2);
  });

  it("gives up on a body after its attempts are spent", () => {
    const logs = [];
    const pending = createPendingAnswers({
      maxAttempts: 3,
      logIntervalMs: 0,
      onLog: (line) => logs.push(line),
    });
    pending.hold("e1", { ok: true });

    pending.flush(refuse, 0);
    pending.flush(refuse, 1);
    assert.equal(pending.size, 1);
    pending.flush(refuse, 2);

    assert.equal(pending.size, 0);
    assert.ok(logs.at(-1).includes("given up after 3 attempts"));
  });

  it("delivers and forgets a body as soon as the write succeeds", () => {
    const written = [];
    const pending = createPendingAnswers();
    pending.hold("e1", { ok: true });

    pending.flush((id, body) => written.push([id, body]), 0);

    assert.equal(pending.size, 0);
    assert.deepEqual(written, [["e1", { ok: true }]]);
  });
});
