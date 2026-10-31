/**
 * Reading a shell command the way a person skims it: does it only look at the
 * workspace, and what kind of looking is it.
 *
 * Two readers ask. The transcript folds an agent's lookups into one
 * "explored" line, and the conductor's self-execution badge warns when a
 * conductor changed something itself. Both need the same answer, and both can
 * afford to be wrong in one direction only: a lookup shown as a command costs
 * a line, a write shown as a lookup costs the operator's trust. So the parser
 * bails towards "changes something" at every ambiguity — a redirect into a
 * file, an unknown program, a construct it cannot balance — and a command it
 * can read is read-only only when every part of it is.
 *
 * Pure.
 */

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
  "printf",
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
  "comm",
  "nl",
  "jq",
  "column",
  "cut",
  "tr",
  "rev",
  "tac",
  "fold",
  "paste",
  "seq",
  "uname",
  "hostname",
  "whoami",
  "printenv",
  "tasklist",
  "ps",
  "md5sum",
  "sha1sum",
  "sha256sum",
  "true",
  "false",
  // Builtins that touch only the shell itself: its directory, its variables,
  // its exit status. None of them can reach a file.
  "cd",
  "pushd",
  "popd",
  "test",
  "[",
  "[[",
  "read",
  // PowerShell reads (matched lowercased, aliases included)
  "set-location",
  "sl",
  "get-content",
  "get-childitem",
  "get-item",
  "get-location",
  "get-command",
  "get-date",
  "get-process",
  "get-ciminstance",
  "get-wmiobject",
  "get-service",
  "get-itemproperty",
  "get-filehash",
  "get-acl",
  "convertfrom-json",
  "convertto-json",
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
  "out-null",
  "gci",
  "gc",
  "gi",
  "gcm",
  "sls",
]);

/**
 * Words that open or close a shell construct rather than run a command.
 *
 * `do grep x` runs `grep x`, so the keyword is stepped over and the rest of
 * the segment is read as the command it is. A keyword alone (`done`, `fi`)
 * runs nothing.
 */
const SHELL_KEYWORDS: ReadonlySet<string> = new Set([
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "do",
  "done",
  "while",
  "until",
  "!",
  "{",
  "}",
  "time",
]);

/**
 * Where a redirect may point without writing anything: the null device and a
 * duplicate of a descriptor that is already open (`2>&1`). Anything else after
 * a `>` is a file the command writes.
 */
const DISCARD_REDIRECT_TARGETS: ReadonlySet<string> = new Set([
  "/dev/null",
  "nul",
  "$null",
]);
const DESCRIPTOR_REDIRECT_TARGET = /^(?:\d+|-)$/;
/** A character that ends an unquoted redirect target. */
const REDIRECT_TARGET_END = /[\s;|&<>()]/;

/** `xargs` options that take the next word as their value. */
const XARGS_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set([
  "-n",
  "-L",
  "-P",
  "-s",
  "-I",
  "-d",
  "-E",
  "-a",
]);

/** `uniq` options that take the next word as their value. */
const UNIQ_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set([
  "-f",
  "-s",
  "-w",
]);

/**
 * Stands in for the text of a command substitution once its command has been
 * read and found to be read-only. It is never a command name, so a
 * substitution used as a command (`$(echo rm) -rf x`) still reads as unknown.
 */
const SUBSTITUTION_PLACEHOLDER = "\u0000substitution";

/** `git` subcommands that only ever read the repository. */
/**
 * `flockctl` verbs that only report: the app's own CLI, which a conductor
 * reads its context, agents and sessions through. Every other verb creates,
 * sends, moves or archives something, and `--help` on any verb only prints.
 * `distillctl` is the name an upgraded install still carries.
 */
const FLOCKCTL_COMMANDS: ReadonlySet<string> = new Set([
  "flockctl",
  "distillctl",
]);
const READ_ONLY_FLOCKCTL_VERBS: ReadonlySet<string> = new Set([
  "list",
  "get",
  "context",
  "models",
  "harnesses",
  "help",
]);

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
 * Index of the `)` that closes the `(` at `open`, or -1.
 *
 * Quotes and escapes are honoured so that `$(grep ")" x)` closes where the
 * shell closes it. A construct this cannot balance returns -1, which the
 * caller reads as "do not reason about this command".
 */
function closingParenIndex(command: string, open: number): number {
  let depth = 0;
  let quote: '"' | "'" | null = null;
  for (let index = open; index < command.length; index += 1) {
    const char = command[index];
    if (quote === "'") {
      if (char === "'") quote = null;
      continue;
    }
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** Index of the backtick that closes the one at `open`, or -1. */
function closingBacktickIndex(command: string, open: number): number {
  for (let index = open + 1; index < command.length; index += 1) {
    const char = command[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === "`") return index;
  }
  return -1;
}

/**
 * Reads the redirect whose operator starts at `start` (`>`, `>>`, `>|`, `>&`,
 * or `&>`), and says whether it only discards output.
 *
 * `end` is the last index the redirect occupies, target included.
 */
function readRedirect(
  command: string,
  start: number,
): { end: number; discards: boolean } {
  let index = start;
  if (command[index] === "&") index += 1;
  index += 1;
  if (command[index] === ">" || command[index] === "|") index += 1;
  const duplicates = command[index] === "&";
  if (duplicates) index += 1;
  while (command[index] === " " || command[index] === "\t") index += 1;

  let target = "";
  const quote = command[index];
  if (quote === '"' || quote === "'") {
    const close = command.indexOf(quote, index + 1);
    if (close < 0) return { end: command.length, discards: false };
    target = command.slice(index + 1, close);
    index = close;
  } else {
    for (
      let char = command[index];
      char !== undefined && !REDIRECT_TARGET_END.test(char);
      char = command[index]
    ) {
      target += char;
      index += 1;
    }
    index -= 1;
  }

  const discards =
    DISCARD_REDIRECT_TARGETS.has(target.toLowerCase()) ||
    (duplicates && DESCRIPTOR_REDIRECT_TARGET.test(target));
  return { end: index, discards };
}

/**
 * The command split into segments of words, or `null` when it contains
 * something this module will not reason about.
 *
 * Bailing out is the point of the `null`: a redirect into a file, an
 * unbalanced construct, or a nested command that is not itself read-only can
 * hide a write behind a name that reads as harmless. Nested commands — a
 * `$(…)` or backtick substitution, a `( … )` subshell — are read with the same
 * rules as the command around them, inside double quotes too, because the
 * shell runs them there as well. Operators inside quotes are otherwise
 * ordinary characters and do not split anything — `rg "a|b"` is one segment —
 * which is why this walks the string instead of splitting it.
 */
function parseShellSegments(command: string): string[][] | null {
  const segments: string[][] = [];
  let words: string[] = [];
  let word = "";
  let quote: '"' | "'" | null = null;
  /** Set by an input redirect: the next word is its source, not an argument. */
  let dropNextWord = false;

  const endWord = (): void => {
    if (word && !dropNextWord) words.push(word);
    if (word) dropNextWord = false;
    word = "";
  };
  const endSegment = (): void => {
    endWord();
    dropNextWord = false;
    if (words.length) segments.push(words);
    words = [];
  };
  /** Reads a nested command; returns where it ends, or -1 to bail. */
  const readSubstitution = (open: number, close: number): number => {
    if (close < 0) return -1;
    if (!isReadOnlyShellCommand(command.slice(open + 1, close))) return -1;
    word += SUBSTITUTION_PLACEHOLDER;
    return close;
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (!char) continue;

    if (quote === "'") {
      if (char === "'") quote = null;
      else word += char;
      continue;
    }
    if (quote === '"') {
      if (char === '"') {
        quote = null;
      } else if (char === "\\") {
        const next = command[index + 1];
        if (next !== undefined && '$`"\\\n'.includes(next)) {
          index += 1;
          if (next !== "\n") word += next;
        } else {
          word += char;
        }
      } else if (char === "`") {
        index = readSubstitution(index, closingBacktickIndex(command, index));
        if (index < 0) return null;
      } else if (char === "$" && command[index + 1] === "(") {
        index = readSubstitution(
          index + 1,
          closingParenIndex(command, index + 1),
        );
        if (index < 0) return null;
      } else {
        word += char;
      }
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
    if (char === ">" || (char === "&" && command[index + 1] === ">")) {
      // A bare number before the operator names the descriptor (`2>`), and
      // is not a word of the command.
      if (/^\d+$/.test(word)) word = "";
      else endWord();
      const redirect = readRedirect(command, index);
      if (!redirect.discards) return null;
      index = redirect.end;
      continue;
    }
    if (char === "<") {
      // `< file` and `<&3` only read. A here-document (`<<`), a here-string
      // (`<<<`), a read-write open (`<>`) and a process substitution (`<(`)
      // are not read here.
      // The source is read as an ordinary word, so a substitution inside it
      // is checked like any other, and then dropped from the command.
      const next = command[index + 1];
      if (next === "<" || next === ">" || next === "(") return null;
      if (/^\d+$/.test(word)) word = "";
      else endWord();
      if (next === "&") index += 1;
      dropNextWord = true;
      continue;
    }
    if (char === "`") {
      index = readSubstitution(index, closingBacktickIndex(command, index));
      if (index < 0) return null;
      continue;
    }
    if (char === "$" && command[index + 1] === "(") {
      index = readSubstitution(
        index + 1,
        closingParenIndex(command, index + 1),
      );
      if (index < 0) return null;
      continue;
    }
    if (char === "(") {
      // A subshell is its own command; a `(` inside a word (`<(…)`,
      // `$((…))` once past the `$`) is a construct this does not read.
      if (word) return null;
      const close = closingParenIndex(command, index);
      if (close < 0) return null;
      const inner = parseShellSegments(command.slice(index + 1, close));
      if (!inner) return null;
      endSegment();
      segments.push(...inner);
      index = close;
      continue;
    }
    if (char === ")") return null;
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

/** `FOO=bar`: an assignment, which belongs to the command after it. */
const ASSIGNMENT_WORD = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** True when one already-split segment cannot change anything. */
function isReadOnlySegment(words: readonly string[]): boolean {
  let start = 0;
  while (start < words.length) {
    const word = words[start] ?? "";
    if (!SHELL_KEYWORDS.has(word) && !ASSIGNMENT_WORD.test(word)) break;
    start += 1;
  }
  const rest = words.slice(start);
  const head = rest[0];
  if (!head) return true;

  const name = commandName(head);
  const flags = rest.slice(1);

  // `for name in words` only expands its words, and any substitution among
  // them has already been read.
  if (name === "for") return true;
  if (name === "git") return isReadOnlyGit(flags);
  if (FLOCKCTL_COMMANDS.has(name)) return isReadOnlyFlockctl(flags);
  if (name === "xargs") return isReadOnlyXargs(flags);
  if (name === "sed") {
    return !flags.some(
      (flag) => flag.startsWith("-i") || flag === "--in-place",
    );
  }
  if (name === "sort") {
    // `-o file` writes the result; it can hide in a cluster (`-no file`).
    return !flags.some(
      (flag) =>
        flag === "--output" ||
        flag.startsWith("--output=") ||
        (/^-[^-]/.test(flag) && flag.includes("o")),
    );
  }
  if (name === "uniq") return isReadOnlyUniq(flags);
  const execFlags = SEARCH_EXEC_FLAGS[name];
  if (execFlags) {
    // `--pre cmd` and `--pre=cmd` are the same flag.
    return !flags.some(
      (flag) => execFlags.has(flag) || execFlags.has(flag.split("=")[0] ?? ""),
    );
  }
  return READ_ONLY_COMMANDS.has(name);
}

/** `flockctl <noun> <verb>`: read-only when the verb only reports. */
function isReadOnlyFlockctl(args: readonly string[]): boolean {
  if (args.some((arg) => arg === "--help" || arg === "-h")) return true;
  const words = args.filter((arg) => !arg.startsWith("-"));
  const verb = words[1] ?? words[0];
  return verb !== undefined && READ_ONLY_FLOCKCTL_VERBS.has(verb.toLowerCase());
}

/** `xargs` runs the command after its options; with none, `echo`. */
function isReadOnlyXargs(args: readonly string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (XARGS_OPTIONS_WITH_VALUE.has(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    return isReadOnlySegment(args.slice(index));
  }
  return true;
}

/** `uniq input output` writes `output`; with one file or none it only reads. */
function isReadOnlyUniq(args: readonly string[]): boolean {
  let files = 0;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (UNIQ_OPTIONS_WITH_VALUE.has(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith("-") && arg !== "-") continue;
    files += 1;
  }
  return files < 2;
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

/** What kind of looking a read-only command does. */
export type ShellLookupKind = "read" | "search" | "list";

const SEARCH_COMMANDS: ReadonlySet<string> = new Set([
  "rg",
  "grep",
  "egrep",
  "fgrep",
  "fd",
  "find",
  "select-string",
  "sls",
]);
const LIST_COMMANDS: ReadonlySet<string> = new Set([
  "ls",
  "dir",
  "tree",
  "du",
  "gci",
  "get-childitem",
]);
const READ_COMMANDS: ReadonlySet<string> = new Set([
  "cat",
  "head",
  "tail",
  "sed",
  "nl",
  "tac",
  "jq",
  "diff",
  "cmp",
  "stat",
  "file",
  "get-content",
  "gc",
  "type",
]);

/** The kind of the first segment that looks at something, or null. */
function segmentLookupKind(words: readonly string[]): ShellLookupKind | null {
  const head = words.find(
    (word) => !SHELL_KEYWORDS.has(word) && !ASSIGNMENT_WORD.test(word),
  );
  if (!head) return null;
  const name = commandName(head);
  if (name === "git") {
    const subcommand = words
      .slice(words.indexOf(head) + 1)
      .find((word) => !word.startsWith("-"));
    if (subcommand === "grep") return "search";
    if (subcommand === "ls-files" || subcommand === "ls-tree") return "list";
    return "read";
  }
  if (SEARCH_COMMANDS.has(name)) return "search";
  if (LIST_COMMANDS.has(name)) return "list";
  if (READ_COMMANDS.has(name)) return "read";
  return null;
}

/**
 * What a read-only command is doing — reading, searching or listing — or
 * `null` when the command is not provably read-only.
 *
 * One kind per command, taken from the first part that looks at something:
 * `cd x && grep -n y z | head` is a search. The plumbing around it (`cd`,
 * `echo`, `sort`, `wc`) only shapes the output. A read-only command whose
 * parts are all plumbing reads as a read.
 */
export function shellLookupKind(command: string): ShellLookupKind | null {
  if (!isReadOnlyShellCommand(command)) return null;
  for (const segment of parseShellSegments(command) ?? []) {
    const kind = segmentLookupKind(segment);
    if (kind) return kind;
  }
  return "read";
}
