import { describe, expect, it } from "vitest";

import { isReadOnlyShellCommand } from "./shellCommandReading";

/**
 * The badge exists to hold the operator's trust: a write that reads as a
 * lookup is the one failure it may not have. Reading commands are the other
 * half — a badge on every investigative turn is a badge nobody reads.
 */
describe("isReadOnlyShellCommand", () => {
  it.each([
    "echo hi > out.txt",
    "echo hi >> out.txt",
    "ls 2> err.log",
    "ls &> all.log",
    "cmd 2>&1 > out",
    "echo x >&file",
    'echo "$(rm -rf x)"',
    "echo `rm x`",
    'echo "`touch y`"',
    "x=$(rm -f y)",
    "$(echo rm) -rf x",
    "(rm x)",
    "cd a && (ls; rm b)",
    "for f in a b; do rm $f; done",
    "if true; then mv a b; fi",
    "sort -o out.txt in.txt",
    "sort -no out in",
    "uniq a b",
    "ls | xargs rm",
    "find . -delete",
    "sed -i s/a/b/ f",
    "git commit -m x",
    "cat <(rm x)",
    "cat <> f",
    'wc < "$(rm x)"',
    "tee out.txt",
    'echo ")" ; rm x',
    "grep x f | sh",
    "flockctl session send --session-id x --prompt list",
    "flockctl session create --prompt get",
  ])("reads %j as a write", (command) => {
    expect(isReadOnlyShellCommand(command)).toBe(false);
  });

  it.each([
    'cd "/e/Unity/Fallout Mod" && ls -la .distill/wiki 2>/dev/null && cat index.md',
    "ls >/dev/null 2>&1",
    "Get-ChildItem 2>$null",
    'n=$(grep -rl "x" src | wc -l); echo "$n"',
    'for d in a b; do echo "== $d"; ls $d | head -30; [ -f $d/x ] && head -60 $d/x; done',
    'ls *.cs | xargs -n1 basename | tr "\\n" " "',
    'find s -name "*.cs" | sed "s|/[^/]*$||" | sort | uniq -c | sort -rn | head -40',
    "(cd x && ls)",
    "if [ -f x ]; then cat x; else echo none; fi",
    "while read l; do echo $l; done < f",
    "flockctl info context --session-id x --json",
    "flockctl agent list --json",
    "flockctl session get --help",
    '(tasklist 2>/dev/null | grep -i "Unity.exe" || echo "none")',
  ])("reads %j as a lookup", (command) => {
    expect(isReadOnlyShellCommand(command)).toBe(true);
  });
});
