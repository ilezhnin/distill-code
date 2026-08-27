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
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  ALLOWED_COMMANDS,
  createRelay,
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
