/**
 * "The conductor is doing the work itself" — the Q6 badge.
 *
 * The conductor is prompt-only: `CONDUCTOR_PROTOCOL_PROMPT` tells it to plan or
 * to answer and never to execute. It is nonetheless an ordinary session with an
 * ordinary toolset, so the instruction can leak; the operator decision (Q6) was
 * to make a leak *visible* rather than to enforce it at the harness, and to
 * revisit only if it turns out to happen for real.
 *
 * It happened for real — in the other direction. Live waves showed the badge
 * crying wolf: a conductor that greps a file to answer a question, or reads a
 * report before planning, is doing exactly what the protocol wants, and a
 * warning on every such turn teaches the operator to ignore the warning. So
 * the badge is tiered by the ACP tool kind: reading is quiet, *changing
 * something* is the leak. A tool whose kind is unknown counts as changing
 * something, because a warning that fires needlessly costs attention while a
 * mutation that passes silently costs trust in the whole surface.
 *
 * The tiering by kind was half the fix. ACP's `execute` means "running commands
 * or code" — `git log`, `cat` and `rg` carry the same kind as `rm`, and on a
 * harness whose only way to look at a repository is a shell the badge went back
 * to firing on every investigative turn. So an `execute` call is read a second
 * time, by its command: a command this module can parse and finds to be
 * read-only stays quiet, and everything else — unparseable, unknown, or
 * genuinely writing — keeps the badge. The asymmetry is deliberate. Missing a
 * read costs a needless warning; missing a write costs the trust the badge
 * exists to hold, so the parser bails towards "mutating" at every ambiguity.
 *
 * Visible still means cheap and read-only: a predicate over the content of one
 * turn. No store, no bookkeeping, nothing persisted — a mutating tool call in a
 * conductor's assistant message *is* the leak, and the badge is derived from it
 * wherever that message is rendered.
 */

import type {
  MessageContent,
  ToolKind,
  ToolRequestContent,
} from "@/shared/types/messages";

/**
 * Tool kinds that only look at the world.
 *
 * `read`, `search` and `fetch` are self-evident; `think` runs no tool at all;
 * `switch_mode` reconfigures the session rather than touching the workspace.
 * Everything else — `edit`, `delete`, `move`, `execute`, `other` — either
 * changes state or (`execute`, `other`) can, and gets the badge.
 *
 * `list` is not an ACP kind at all, which is why the set is typed over
 * strings: the grok bridge reports its `list_dir` tool as `"kind":"list"`, the
 * cast in the notification handler lets any string through, and a directory
 * listing branded as a mutation is the cry-wolf badge back under another name.
 * The same bridge then says `other` on every `tool_call_update`; the handler
 * refuses that downgrade (`toolCallUpdatePatchFor`), which is what keeps
 * `list` in the stored block for this predicate to read.
 */
const READ_ONLY_TOOL_KINDS: ReadonlySet<string> = new Set<ToolKind | "list">([
  "read",
  "search",
  "think",
  "fetch",
  "switch_mode",
  "list",
]);

/**
 * True when this tool kind can change state.
 *
 * `undefined` is mutating on purpose: a harness that reports no kind gives us
 * nothing to be lenient on, and the pre-tiering behaviour — badge every tool
 * call — is the right fallback there.
 *
 * This is the kind tier alone. `execute` is mutating here and is given its
 * second reading by {@link isMutatingToolCall}, which is what callers with a
 * whole tool call in hand should use.
 */
export function isMutatingToolKind(kind: ToolKind | undefined): boolean {
  return kind === undefined || !READ_ONLY_TOOL_KINDS.has(kind);
}

/**
 * Argument keys a harness puts a shell command under.
 *
 * Claude Code's `Bash` and Goose's shell use `command`; Codex passes an argv
 * array under the same key. The rest are the spellings seen on other bridges.
 * A key that is not here means the command was not found, which reads as
 * mutating — the same answer as before this parser existed.
 */
const COMMAND_ARGUMENT_KEYS: readonly string[] = [
  "command",
  "cmd",
  "commandLine",
  "command_line",
  "shell_command",
  "script",
];

/** Shells whose `-c`-style argv wraps the command we actually want to read. */
const SHELL_WRAPPERS: ReadonlySet<string> = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "pwsh",
  "powershell",
  "cmd",
]);

/** The `-c` spellings those shells take the script in. */
const SHELL_SCRIPT_FLAGS: ReadonlySet<string> = new Set([
  "-c",
  "-lc",
  "-lic",
  "-ic",
  "-command",
  "/c",
  "/k",
]);

/**
 * Commands that cannot change anything on their own.
 *
 * Every entry is a command with no write mode at all: the ways they could
 * still touch a file — a `>` redirect, a subshell, a pipe into something else
 * — are handled by the parser, which refuses to reason about a command
 * containing any of them. Commands with a write *flag* (`sed -i`, `find
 * -delete`) are not here; they get an explicit guard below.
 *
 * PowerShell verbs are included because this app runs on Windows, where a
 * conductor's only way to read a repository may be `Get-Content` or
 * `Select-String`. `Out-File`, `Set-*`, `Remove-*` and `Invoke-Expression` are
 * deliberately absent.
 */
const READ_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  // POSIX-ish reads
  "cat",
  "head",
  "tail",
  "wc",
  "ls",
  "dir",
  "pwd",
  "echo",
  "stat",
  "file",
  "du",
  "df",
  "tree",
  "which",
  "type",
  "basename",
  "dirname",
  "realpath",
  "readlink",
  "rg",
  "grep",
  "egrep",
  "fgrep",
  "fd",
  "diff",
  "cmp",
  "nl",
  "jq",
  "column",
  "seq",
  "uname",
  "hostname",
  "whoami",
  "printenv",
  "true",
  // PowerShell reads (matched lowercased, aliases included)
  "get-content",
  "get-childitem",
  "get-item",
  "get-location",
  "get-command",
  "get-date",
  "get-process",
  "select-string",
  "select-object",
  "sort-object",
  "measure-object",
  "resolve-path",
  "test-path",
  "format-table",
  "format-list",
  "out-string",
  "write-output",
  "write-host",
  "gci",
  "gc",
  "gi",
  "gcm",
  "sls",
]);

/** `git` subcommands that only ever read the repository. */
const READ_ONLY_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "log",
  "status",
  "diff",
  "show",
  "blame",
  "shortlog",
  "describe",
  "grep",
  "rev-parse",
  "rev-list",
  "ls-files",
  "ls-tree",
  "ls-remote",
  "cat-file",
  "show-ref",
  "for-each-ref",
  "diff-tree",
  "diff-index",
  "merge-base",
  "name-rev",
  "count-objects",
  "check-ignore",
  "whatchanged",
  "version",
]);

/** `git` options that swallow the word after them before the subcommand. */
const GIT_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
]);

/**
 * Flags that turn an otherwise read-only search into "run this on every hit".
 *
 * A searcher with an exec flag is a loop around an arbitrary command, so the
 * allowlist has to stop reading the command name and start reading the flags.
 */
const SEARCH_EXEC_FLAGS: Record<string, ReadonlySet<string>> = {
  find: new Set([
    "-delete",
    "-exec",
    "-execdir",
    "-ok",
    "-okdir",
    "-fls",
    "-fprint",
    "-fprint0",
    "-fprintf",
  ]),
  fd: new Set(["-x", "-X", "--exec", "--exec-batch"]),
  rg: new Set(["--pre", "--hostname-bin"]),
};

/**
 * The command text inside a tool call's arguments, or `null` when there is
 * none to read.
 *
 * An argv array is unwrapped when it is a shell invoking a script (`["bash",
 * "-lc", "git log"]` is the command `git log`); otherwise its words are joined
 * back into a line. Joining loses the original quoting, which can only make
 * the parser more suspicious, never less.
 */
export function toolCallCommandText(
  args: Record<string, unknown> | undefined,
): string | null {
  if (!args) return null;
  for (const key of COMMAND_ARGUMENT_KEYS) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value;
    if (Array.isArray(value)) {
      const words = value.filter(
        (entry): entry is string => typeof entry === "string",
      );
      if (words.length !== value.length || words.length === 0) continue;
      const unwrapped = unwrapShellInvocation(words);
      if (unwrapped.trim()) return unwrapped;
    }
  }
  return null;
}

function unwrapShellInvocation(words: readonly string[]): string {
  const [shell, flag, ...rest] = words;
  if (
    shell &&
    flag &&
    rest.length > 0 &&
    SHELL_WRAPPERS.has(commandName(shell)) &&
    SHELL_SCRIPT_FLAGS.has(flag.toLowerCase())
  ) {
    return rest.join(" ");
  }
  return words.join(" ");
}

/** A command word reduced to its name: no directory, no `.exe`, lowercased. */
function commandName(word: string): string {
  const base = word.split(/[\\/]/).pop() ?? word;
  return base.toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, "");
}

/**
 * The command split into segments of words, or `null` when it contains
 * something this module will not reason about.
 *
 * Bailing out is the point of the `null`: a redirect (`>`), a command
 * substitution (`$(…)`, backticks) or a subshell can hide a write behind a
 * name that reads as harmless, and no allowlist can see through them.
 * Operators inside quotes are ordinary characters and do not split anything —
 * `rg "a|b"` is one segment — which is why this walks the string instead of
 * splitting it.
 */
function parseShellSegments(command: string): string[][] | null {
  const segments: string[][] = [];
  let words: string[] = [];
  let word = "";
  let quote: '"' | "'" | null = null;

  const endWord = (): void => {
    if (word) words.push(word);
    word = "";
  };
  const endSegment = (): void => {
    endWord();
    if (words.length) segments.push(words);
    words = [];
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (!char) continue;

    if (quote) {
      if (char === quote) quote = null;
      else word += char;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "\\") {
      const next = command[index + 1];
      if (!next) continue;
      index += 1;
      if (next === "\n") endWord();
      else word += next;
      continue;
    }
    // Anything that can write a file or hide another command ends the reading.
    if (char === ">" || char === "`" || char === "(" || char === ")") {
      return null;
    }
    if (char === "$" && command[index + 1] === "(") return null;
    if (char === ";" || char === "|" || char === "&" || char === "\n") {
      endSegment();
      continue;
    }
    if (char === " " || char === "\t" || char === "\r") {
      endWord();
      continue;
    }
    word += char;
  }

  if (quote) return null;
  endSegment();
  return segments;
}

/** True when one already-split segment cannot change anything. */
function isReadOnlySegment(words: readonly string[]): boolean {
  // Leading `FOO=bar` assignments belong to the command that follows them.
  const start = words.findIndex(
    (word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word),
  );
  if (start < 0) return true;
  const rest = words.slice(start);
  const head = rest[0];
  if (!head) return true;

  const name = commandName(head);
  const flags = rest.slice(1);

  if (name === "git") return isReadOnlyGit(flags);
  if (name === "sed") {
    return !flags.some(
      (flag) => flag.startsWith("-i") || flag === "--in-place",
    );
  }
  const execFlags = SEARCH_EXEC_FLAGS[name];
  if (execFlags) {
    // `--pre cmd` and `--pre=cmd` are the same flag.
    return !flags.some(
      (flag) => execFlags.has(flag) || execFlags.has(flag.split("=")[0] ?? ""),
    );
  }
  return READ_ONLY_COMMANDS.has(name);
}

function isReadOnlyGit(args: readonly string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    if (GIT_OPTIONS_WITH_VALUE.has(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    return READ_ONLY_GIT_SUBCOMMANDS.has(arg.toLowerCase());
  }
  // `git` with no subcommand prints its usage.
  return true;
}

/**
 * True when this command only looks at the workspace.
 *
 * Conservative by construction: an unknown command, an unparseable line, or
 * any single segment that is not provably read-only makes the whole command
 * mutating.
 */
export function isReadOnlyShellCommand(command: string): boolean {
  if (!command.trim()) return false;
  const segments = parseShellSegments(command);
  if (!segments || segments.length === 0) return false;
  return segments.every(isReadOnlySegment);
}

/**
 * True when this tool call can change state.
 *
 * The kind decides, except for `execute`, where the command decides — that is
 * the kind a shell arrives under whether it is reading or writing.
 */
export function isMutatingToolCall(block: ToolRequestContent): boolean {
  if (block.toolKind === "execute") {
    const command = toolCallCommandText(block.arguments);
    return command === null || !isReadOnlyShellCommand(command);
  }
  return isMutatingToolKind(block.toolKind);
}

/**
 * True when this assistant turn ran a tool that can change state.
 *
 * The caller supplies the "is this a conductor" half. Legacy orchestrator
 * shells share that flag in the transcript context but can never match here:
 * they are short-circuited in `sendCore` and never reach a model at all, so
 * they have no tool calls to find.
 */
export function turnHasMutatingToolCall(
  content: readonly MessageContent[] | undefined,
): boolean {
  return Boolean(
    content?.some(
      (block) => block.type === "toolRequest" && isMutatingToolCall(block),
    ),
  );
}
