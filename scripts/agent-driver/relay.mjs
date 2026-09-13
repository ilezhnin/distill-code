#!/usr/bin/env node
/**
 * The agent driver relay.
 *
 * The remote agent that works on this repository cannot reach this machine's
 * loopback interface, and it cannot run this machine's toolchain either: the
 * folder it sees is a network mount, and pnpm's `node_modules` is a tree of
 * symlinks that does not survive the crossing. So two things every local
 * developer takes for granted — press a button in the running app, run the
 * test suite — were operator-only, and every verification round trip cost a
 * human.
 *
 * This relay is the bridge. It watches a folder both sides can see and turns
 * the JSON envelopes the agent drops there into two things:
 *
 *   - `driver` → a line on `127.0.0.1:<port>`, where the Tauri
 *     `app-test-driver` plugin listens, and its answer back as a file.
 *   - `exec` → a child process from a small allowlist (pnpm, just, git,
 *     cargo, node), with its exit code and output back as a file.
 *
 * Deliberately boring: no server, no daemon manager, no dependencies. One
 * `node scripts/agent-driver/relay.mjs` in a terminal where `pnpm` already
 * works, and the agent stops asking you to press things.
 *
 * The allowlist is a guard rail against a mistyped envelope, not a security
 * boundary — `pnpm` can run anything this repository's scripts can. The inbox
 * is trusted input, because it is a folder on your own disk.
 */

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(HERE, "..", "..");

/** Commands an `exec` envelope may name. Everything else is refused by name. */
export const ALLOWED_COMMANDS = ["pnpm", "just", "git", "cargo", "node"];

const POLL_INTERVAL_MS = 250;
const HEARTBEAT_INTERVAL_MS = 2_000;
/** How often the relay checks whether the app's driver port answers at all. */
const PROBE_INTERVAL_MS = 10_000;
const DEFAULT_DRIVER_TIMEOUT_MS = 15_000;
/**
 * Bound on a `driver` envelope's requested `timeout`. `socket.setTimeout`
 * throws synchronously on a negative value, and that throw used to happen
 * before the socket's `'error'` listener was attached — an envelope like
 * `{ "timeout": -10000 }` with the app closed took the whole relay process
 * down. Clamping keeps every value `sendToDriver` sees safely non-negative
 * (and away from an unreasonably long hang) regardless of what the caller
 * sends.
 */
const MAX_DRIVER_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_EXEC_TIMEOUT_MS = 15 * 60_000;
/** How much of each stream rides back inside the answer file. */
const TAIL_LIMIT = 8_000;
/**
 * How long an envelope that does not parse yet may still be mid-write. Not
 * every writer can write-then-rename: a file copied onto the mount lands in
 * pieces, and reading the first piece as "not JSON" deleted the envelope.
 */
const ENVELOPE_SETTLE_MS = 2_000;
/**
 * After a timed-out command is killed, how long to wait for its streams to
 * close. A grandchild that inherited stdout keeps them open for as long as it
 * lives, and waiting for that kept the lane busy forever.
 */
const KILL_GRACE_MS = 5_000;

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

/**
 * Quote one argument the way `cmd.exe` takes it back apart unchanged.
 *
 * Only reached on Windows, and only for a `.cmd`/`.bat` entry point, which is
 * what `pnpm` and `just` are there.
 */
export function quoteForCmd(arg) {
  const escaped = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1");
  return `"${escaped}"`;
}

/**
 * Build the `/c` argument for `cmd.exe /d /s /c` that launches a
 * `.cmd`/`.bat` entry point.
 *
 * `cmd /s` strips only the very first and the very last quote character off
 * the whole command line — not each token's own quotes. Quoting just the
 * resolved executable (`"C:\...\pnpm.cmd" "vitest" "run"`) leaves cmd
 * reading `C:\...\pnpm.cmd" "vitest" "run` once that strip runs, which is
 * where the classic `'C:\Program' is not recognized` failure comes from.
 * Node's own `shell: true`, cross-spawn, and this repo's own
 * `Invoke-CheckedCommand` (WindowsDev.psm1) all wrap the *entire* line in
 * one more pair of quotes for exactly this reason: the strip then removes
 * only that outer pair, and every inner quote survives untouched.
 */
export function buildCmdLine(resolved, argv) {
  const shellCommand = [quoteForCmd(resolved), ...argv.map(quoteForCmd)].join(
    " ",
  );
  return `"${shellCommand}"`;
}

/** Confine a value to `[min, max]`. */
export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/** Keep the end of a stream, which is where the failure is. */
export function tail(text, limit = TAIL_LIMIT) {
  if (text.length <= limit) return text;
  const dropped = text.length - limit;
  return `…${dropped} earlier characters are in the log file…\n${text.slice(-limit)}`;
}

/**
 * Where an `exec` envelope is allowed to run.
 *
 * Returns the resolved directory, or `null` when the envelope pointed outside
 * both roots. A relative path is read against the repository, which is what
 * every command in the plan wants.
 */
export function resolveCwd(requested, repoRoot, relayRoot) {
  const cwd = path.resolve(repoRoot, requested ?? ".");
  const inside = (root) => cwd === root || cwd.startsWith(root + path.sep);
  return inside(repoRoot) || inside(relayRoot) ? cwd : null;
}

/**
 * Find what `pnpm` actually is on this machine.
 *
 * On Windows it is `pnpm.cmd`, and since Node 20 a `.cmd` cannot be spawned
 * without a shell. Rather than hand a whole command line to `cmd.exe` and hope
 * the quoting survives, resolve the file here and invoke the interpreter
 * explicitly — the one arrangement where argument boundaries stay ours.
 */
export function resolveExecutable(
  name,
  env = process.env,
  platform = process.platform,
) {
  // Windows cannot execute an extensionless file, yet npm drops one next to
  // every `.cmd` shim (a bash script for Git Bash). Trying the bare name first
  // picked that script for `pnpm` and the spawn failed with ENOENT, so on
  // Windows only the PATHEXT forms count unless the name already carries one.
  const pathExt = (env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean);
  const extensions =
    platform !== "win32" || path.extname(name) !== "" ? [""] : pathExt;
  for (const dir of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const ext of extensions) {
      const candidate = path.join(dir, name + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Write a file the other side can only ever see whole.
 *
 * The agent polls `outbox/` across a network mount, so a half-written answer
 * is not a theoretical race: it is the first bug this relay would have had.
 */
function writeAtomic(file, text) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, file);
}

/**
 * Kill a command and everything it started.
 *
 * On Windows `pnpm` and `just` run under `cmd.exe /c`, and killing that shell
 * leaves the real work (node, cargo, powershell) running with our pipes still
 * open, so the command never finished. `taskkill /T` takes the whole tree.
 */
function killTree(child) {
  if (process.platform === "win32" && child.pid) {
    const args = ["/pid", String(child.pid), "/T", "/F"];
    const killer = spawn("taskkill", args, {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.on("error", () => child.kill("SIGKILL"));
    return;
  }
  child.kill("SIGKILL");
}

// ---------------------------------------------------------------------------
// the relay
// ---------------------------------------------------------------------------

export function createRelay({
  root,
  port = 9999,
  token = null,
  repoRoot = DEFAULT_REPO_ROOT,
  onLog = () => {},
} = {}) {
  const ROOT = path.resolve(root);
  const INBOX = path.join(ROOT, "inbox");
  const OUTBOX = path.join(ROOT, "outbox");
  const LOGS = path.join(ROOT, "logs");
  const FAILED = path.join(ROOT, "failed");
  const HEARTBEAT = path.join(ROOT, "heartbeat.json");
  for (const dir of [ROOT, INBOX, OUTBOX, LOGS]) {
    mkdirSync(dir, { recursive: true });
  }

  const allowed = new Set(ALLOWED_COMMANDS);
  const busy = { driver: false, exec: false, control: false };
  const claimed = new Set();
  /**
   * Bodies that were produced but could not be written to `outbox/` yet
   * (a reader holding the target open, most often on Windows). The envelope
   * that produced a body is always spent — it is removed from `inbox/`
   * (or moved to `failed/` if even that fails) the moment `handle()`
   * resolves, before the write is attempted — so a body only ever needs
   * retrying here, never recomputing by running the command again.
   */
  const pendingAnswers = new Map();
  let driverReachable = null;
  let stopped = false;

  /**
   * One command, one connection.
   *
   * The plugin will take as many newline-delimited commands as you send down
   * one socket, but a long-lived socket here would mean holding state across an
   * app restart — and restarting mid-run is one of the things the agent is here
   * to test. A fresh connection per command cannot go stale.
   */
  function sendToDriver(command, timeoutMs) {
    return new Promise((resolve) => {
      let settled = false;
      let buffer = "";
      const finish = (value) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(value);
      };

      const socket = net.createConnection({ port, host: "127.0.0.1" });
      // Attached before `setTimeout`: a connection failure (ECONNREFUSED, the
      // app not running) can arrive before anything else, and an `'error'`
      // event with no listener at all crashes the whole relay process — not
      // just this one command.
      socket.on("error", (error) =>
        finish({
          ok: false,
          error:
            `Cannot reach the app test driver on 127.0.0.1:${port} (${error.message}). ` +
            "Is the app running from a build with the app-test-driver feature?",
        }),
      );
      socket.setTimeout(timeoutMs);
      socket.on("connect", () => socket.write(`${JSON.stringify(command)}\n`));
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        const newline = buffer.indexOf("\n");
        if (newline === -1) return;
        const line = buffer.slice(0, newline).trim();
        try {
          finish({ ok: true, result: JSON.parse(line) });
        } catch {
          finish({
            ok: false,
            error: `Driver sent a line that is not JSON: ${line}`,
          });
        }
      });
      socket.on("timeout", () =>
        finish({
          ok: false,
          error: `Driver did not answer within ${timeoutMs}ms on port ${port}.`,
        }),
      );
      socket.on("close", () =>
        finish({
          ok: false,
          error: "Driver closed the connection before answering.",
        }),
      );
    });
  }

  async function handleDriver(envelope) {
    if (typeof envelope.action !== "string" || envelope.action.length === 0) {
      return { ok: false, error: 'A driver envelope needs an "action".' };
    }
    const timeoutMs = Number.isInteger(envelope.timeout)
      ? clamp(envelope.timeout, 0, MAX_DRIVER_TIMEOUT_MS) + 5_000
      : DEFAULT_DRIVER_TIMEOUT_MS;
    const command = { action: envelope.action };
    if (token) command.token = token;
    for (const field of ["selector", "value", "timeout"]) {
      if (envelope[field] !== undefined) command[field] = envelope[field];
    }

    const answer = await sendToDriver(command, timeoutMs);
    if (!answer.ok) return { ok: false, error: answer.error };
    const result = answer.result ?? {};
    return {
      ok: result.success === true,
      success: result.success === true,
      data: result.data ?? null,
      error: result.error ?? null,
    };
  }

  function runProcess(file, argv, options) {
    return new Promise((resolvePromise) => {
      const child = spawn(file, argv, options);
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let exitCode = null;
      let exitSignal = null;
      let grace = null;
      let settled = false;
      const resolve = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(grace);
        resolvePromise(value);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
        grace = setTimeout(() => {
          // Something the command started still holds its output open. Stop
          // listening rather than wait for it: the answer is "timed out".
          child.stdout?.destroy();
          child.stderr?.destroy();
          resolve({
            code: exitCode,
            signal: exitSignal,
            stdout,
            stderr,
            timedOut,
          });
        }, KILL_GRACE_MS);
      }, options.timeoutMs);

      child.stdout?.on("data", (c) => {
        stdout += c.toString();
      });
      child.stderr?.on("data", (c) => {
        stderr += c.toString();
      });
      child.on("exit", (code, signal) => {
        exitCode = code;
        exitSignal = signal;
      });
      child.on("error", (error) => {
        resolve({ spawnError: error.message, stdout, stderr, timedOut });
      });
      child.on("close", (code, signal) => {
        resolve({ code, signal, stdout, stderr, timedOut });
      });
    });
  }

  async function handleExec(envelope, id) {
    const cmd = envelope.cmd;
    if (typeof cmd !== "string" || !allowed.has(cmd)) {
      return {
        ok: false,
        error: `"${cmd}" is not an allowed command. The relay runs only: ${ALLOWED_COMMANDS.join(", ")}.`,
      };
    }
    const argv = Array.isArray(envelope.args) ? envelope.args.map(String) : [];
    // cmd.exe expands %NAME% even inside quotes, so an argument carrying a
    // percent sign cannot be passed through faithfully. Refusing beats running
    // something other than what was asked for.
    if (process.platform === "win32" && argv.some((a) => a.includes("%"))) {
      return {
        ok: false,
        error: "Arguments containing % cannot be passed through cmd.exe.",
      };
    }

    const cwd = resolveCwd(envelope.cwd, repoRoot, ROOT);
    if (cwd === null) {
      return {
        ok: false,
        error: `cwd must be inside ${repoRoot} or ${ROOT}, got ${envelope.cwd}`,
      };
    }
    if (!existsSync(cwd))
      return { ok: false, error: `cwd does not exist: ${cwd}` };

    const resolved = resolveExecutable(cmd);
    if (!resolved) {
      return {
        ok: false,
        error: `"${cmd}" was not found on this relay's PATH. Start the relay from a terminal where it works.`,
      };
    }

    const timeoutMs = Number.isInteger(envelope.timeoutMs)
      ? envelope.timeoutMs
      : DEFAULT_EXEC_TIMEOUT_MS;
    const isBatch = /\.(cmd|bat)$/i.test(resolved);
    const [file, spawnArgs, extra] = isBatch
      ? [
          process.env.ComSpec ?? "cmd.exe",
          ["/d", "/s", "/c", buildCmdLine(resolved, argv)],
          { windowsVerbatimArguments: true },
        ]
      : [resolved, argv, {}];

    const started = Date.now();
    const outcome = await runProcess(file, spawnArgs, {
      cwd,
      timeoutMs,
      windowsHide: true,
      env: process.env,
      ...extra,
    });

    const logFile = path.join(LOGS, `${id}.log`);
    writeAtomic(
      logFile,
      [
        `$ ${cmd} ${argv.join(" ")}`,
        `cwd: ${cwd}`,
        "",
        "--- stdout ---",
        outcome.stdout,
        "--- stderr ---",
        outcome.stderr,
      ].join("\n"),
    );

    if (outcome.spawnError) {
      return {
        ok: false,
        error: `Could not start ${cmd}: ${outcome.spawnError}`,
        logFile,
      };
    }
    return {
      ok: outcome.code === 0 && !outcome.timedOut,
      code: outcome.code,
      signal: outcome.signal ?? null,
      timedOut: outcome.timedOut,
      ms: Date.now() - started,
      stdoutTail: tail(outcome.stdout),
      stderrTail: tail(outcome.stderr),
      logFile,
    };
  }

  async function handle(envelope, id) {
    const kind = envelope.kind ?? "driver";
    if (kind === "driver") return handleDriver(envelope);
    if (kind === "exec") return handleExec(envelope, id);
    if (kind === "control") {
      if (envelope.action === "ping") {
        return { ok: true, pong: true, pid: process.pid, root: ROOT, port };
      }
      if (envelope.action === "shutdown") {
        queueMicrotask(stop);
        return { ok: true, stopping: true };
      }
      return { ok: false, error: `Unknown control action: ${envelope.action}` };
    }
    return { ok: false, error: `Unknown envelope kind: ${kind}` };
  }

  function answer(id, body) {
    writeAtomic(
      path.join(OUTBOX, `${id}.json`),
      `${JSON.stringify({ id, finishedAt: Date.now(), ...body }, null, 2)}\n`,
    );
  }

  function stillBeingWritten(file) {
    try {
      return Date.now() - statSync(file).mtimeMs < ENVELOPE_SETTLE_MS;
    } catch {
      return false;
    }
  }

  function claim(file) {
    const id = path.basename(file, ".json");
    const full = path.join(INBOX, file);
    let envelope;
    try {
      envelope = JSON.parse(readFileSync(full, "utf8"));
    } catch (error) {
      if (stillBeingWritten(full)) return null;
      answer(id, {
        ok: false,
        error: `Envelope is not valid JSON: ${error.message}`,
      });
      rmSync(full, { force: true });
      return null;
    }
    const lane =
      envelope.kind === "exec"
        ? "exec"
        : envelope.kind === "control"
          ? "control"
          : "driver";
    return { id, full, envelope, lane };
  }

  /**
   * Retry every body that could not be written to `outbox/` last time.
   *
   * The envelope that produced these is already gone from `inbox/`, so a
   * retry here can only ever repeat a file write — never `handle()`, never
   * the side effect it had.
   */
  function flushPendingAnswers() {
    for (const [id, body] of pendingAnswers) {
      try {
        answer(id, body);
        pendingAnswers.delete(id);
      } catch (error) {
        onLog(`${id} -> answer still not written: ${error.message}`);
      }
    }
  }

  function poll() {
    flushPendingAnswers();
    let files;
    try {
      files = readdirSync(INBOX)
        .filter((f) => f.endsWith(".json"))
        .sort();
    } catch {
      return;
    }
    for (const file of files) {
      if (claimed.has(file)) continue;
      let job;
      try {
        job = claim(file);
      } catch (error) {
        onLog(`${file} -> not claimed: ${error.message}`);
        continue;
      }
      if (!job || busy[job.lane]) continue;

      claimed.add(file);
      busy[job.lane] = true;
      onLog(
        `${job.lane} ${job.id} ${job.envelope.action ?? job.envelope.cmd ?? ""}`,
      );
      handle(job.envelope, job.id)
        .catch((error) => ({
          ok: false,
          error: `Relay failed: ${error.message}`,
        }))
        .then((body) => {
          // The envelope already produced this body: it must never be
          // executed again, no matter what happens to the answer write
          // below. Spend it first, unconditionally.
          try {
            rmSync(job.full, { force: true });
          } catch {
            try {
              mkdirSync(FAILED, { recursive: true });
              renameSync(job.full, path.join(FAILED, path.basename(job.full)));
            } catch (moveError) {
              // Even the move failed (someone else holds the envelope open).
              // Leaving it in inbox/ risks a re-run, but there is nothing
              // safer left to do; the lane still frees up and the answer
              // still lands, so at least the agent is not left hanging.
              onLog(
                `${job.lane} ${job.id} -> could not remove or move envelope: ${moveError.message}`,
              );
            }
          }
          claimed.delete(file);
          busy[job.lane] = false;

          try {
            answer(job.id, body);
          } catch (error) {
            // A reader holding the file open (Windows refuses the rename
            // then) must not take the whole relay down with an unhandled
            // rejection, and must not cause the command to run again — the
            // envelope is already gone. Cache the body and retry the write
            // only, on the next poll.
            pendingAnswers.set(job.id, body);
            onLog(
              `${job.lane} ${job.id} -> answer not written: ${error.message}`,
            );
          }
          onLog(
            `${job.lane} ${job.id} -> ${body.ok ? "ok" : `error: ${body.error ?? body.code}`}`,
          );
        });
    }
  }

  async function probe() {
    const command = token ? { action: "active", token } : { action: "active" };
    driverReachable = (await sendToDriver(command, 3_000)).ok;
  }

  function heartbeat() {
    try {
      writeHeartbeat();
    } catch (error) {
      // Same as answers: the agent reading heartbeat.json at the moment of
      // the rename is not a reason to crash; the next beat will land.
      onLog(`heartbeat not written: ${error.message}`);
    }
  }

  function writeHeartbeat() {
    writeAtomic(
      HEARTBEAT,
      `${JSON.stringify(
        {
          pid: process.pid,
          now: Date.now(),
          root: ROOT,
          repoRoot,
          driverPort: port,
          driverReachable,
          allowedCommands: ALLOWED_COMMANDS,
          platform: process.platform,
          node: process.version,
        },
        null,
        2,
      )}\n`,
    );
  }

  const timers = [
    setInterval(poll, POLL_INTERVAL_MS),
    setInterval(heartbeat, HEARTBEAT_INTERVAL_MS),
    setInterval(probe, PROBE_INTERVAL_MS),
  ];
  heartbeat();
  probe();

  function stop() {
    if (stopped) return;
    stopped = true;
    for (const timer of timers) clearInterval(timer);
    onLog("stopped");
  }

  return {
    stop,
    paths: {
      root: ROOT,
      inbox: INBOX,
      outbox: OUTBOX,
      logs: LOGS,
      heartbeat: HEARTBEAT,
    },
  };
}

// ---------------------------------------------------------------------------
// cli
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const out = { root: null, port: 9999, token: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") out.root = argv[++i];
    else if (arg === "--port") out.port = Number(argv[++i]);
    else if (arg === "--token") out.token = argv[++i];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(out.port) || out.port < 1 || out.port > 65_535) {
    throw new Error("--port must be an integer between 1 and 65535");
  }
  return out;
}

const USAGE = [
  "Usage: node scripts/agent-driver/relay.mjs [options]",
  "",
  "  --root <dir>   Folder holding inbox/ and outbox/.",
  "                 Default: <repo>/../agent-driver",
  "  --port <n>     app-test-driver port. Default: 9999 (legacy mode)",
  "  --token <s>    Driver token. Only needed in isolated mode.",
  "",
].join("\n");

function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE);
    return;
  }
  const args = parseArgs(argv);
  const root = args.root ?? path.join(DEFAULT_REPO_ROOT, "..", "agent-driver");
  const log = (line) => process.stdout.write(`[relay] ${line}\n`);
  const relay = createRelay({ ...args, root, onLog: log });

  log(`root      ${relay.paths.root}`);
  log(`repo      ${DEFAULT_REPO_ROOT}`);
  log(`driver    127.0.0.1:${args.port}`);
  log("watching inbox/ — Ctrl+C to stop");

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      relay.stop();
      process.exit(0);
    });
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2));
}
