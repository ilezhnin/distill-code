# Security policy

Levocat Flock runs agent harnesses on your machine with your provider
accounts, so a vulnerability in it can reach your code, your credentials, and
your conversations. Please report one privately.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository:
[Report a vulnerability](https://github.com/ilezhnin/distill-code/security/advisories/new).
If that form is unavailable to you, email <ilezhnin@gmail.com> with
"Flock security" in the subject.

Include the app version (Settings, or `package.json` in your checkout), the
steps to reproduce, and what an attacker could gain. Do not include real
credentials, tokens, or private conversations in the report.

You will get an acknowledgement, a fix or a reason why not, and credit in the
release notes if you want it. Please give the fix a reasonable time to ship
before publishing details.

## Scope

In scope: the desktop app, the bundled `flockctl` and `flock-monitor`
command-line tools, the managed agent bridges the app installs, the benchmark
sandbox, and this repository's build and release scripts.

Out of scope: the third-party agent harnesses and model providers themselves.
Report those to their vendors.
