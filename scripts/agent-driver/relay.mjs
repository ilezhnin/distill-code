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
const DEFAULT_EXEC_TIMEOUT_MS = 15 * 60_000;
/** How much of each stream rides back inside the answer file. */
const TAIL_LIMIT = 8_000;

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
  const pathExt = (env.PATHEXT ?? "").split(";").filter(Boolean);
  const extensions = platform === "win32" ? ["", ...pathExt] : [""];
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
  const HEARTBEAT = path.join(ROOT, "heartbeat.json");
  for (const dir of [ROOT, INBOX, OUTBOX, LOGS]) {
    mkdirSync(dir, { recursive: true });
  }

  const allowed = new Set(ALLOWED_COMMANDS);
  const busy = { driver: false, exec: false, control: false };
  const claimed = new Set();
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
      socket.on("error", (error) =>
        finish({
          ok: false,
          error:
            `Cannot reach the app test driver on 127.0.0.1:${port} (${error.message}). ` +
            "Is the app running from a build with the app-test-driver feature?",
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
      ? envelope.timeout + 5_000
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
    return new Promise((resolve) => {
      const child = spawn(file, argv, options);
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, options.timeoutMs);

      child.stdout?.on("data", (c) => {
        stdout += c.toString();
      });
      child.stderr?.on("data", (c) => {
        stderr += c.toString();
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        resolve({ spawnError: error.message, stdout, stderr, timedOut });
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
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
          [
            "/d",
            "/s",
            "/c",
            [quoteForCmd(resolved), ...argv.map(quoteForCmd)].join(" "),
          ],
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

  function claim(file) {
    const id = path.basename(file, ".json");
    const full = path.join(INBOX, file);
    let envelope;
    try {
      envelope = JSON.parse(readFileSync(full, "utf8"));
    } catch (error) {
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

  function poll() {
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
      const job = claim(file);
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
          answer(job.id, body);
          rmSync(job.full, { force: true });
          claimed.delete(file);
          busy[job.lane] = false;
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
