# AI Providers

## Kimi Code

In Settings > AI providers, install Kimi Code and choose Sign in. Distill runs
the official `@moonshot-ai/kimi-code` CLI (`kimi login`); follow the verification
URL and device code in the setup output to authorize your Kimi account in a
browser. The CLI owns credentials under `~/.kimi-code` (or `KIMI_CODE_HOME`).
Distill verifies readiness and signs out through ACP without reading tokens.
Google accounts may be redirected from kimi.com to kimi.ai by Kimi's sign-in
page. Complete the same device authorization flow there; do not restart login
if the CLI has already confirmed success.

The status bar uses the same provider catalog as Settings and model selection.
Every installed provider appears, including providers without a quota API.
Kimi Code's managed accounts expose 5-hour, weekly, monthly total, and monthly
coding limits when the service supplies them. The usage adapter briefly starts
the CLI's authenticated loopback API with `kimi web --port 0 --no-open`, reads
its structured quota response, and shuts it down. Kimi renews expired tokens
itself; Distill does not read or rewrite OAuth files, open a browser, or send
a chat message to obtain usage. Both official regions are supported. Custom
endpoints show connection status without subscription limits.

After sign-in, select Kimi Code and a model in the composer or agent settings.
Models and thinking options come from the installed CLI's live ACP inventory;
Distill does not pin model names. Existing API-key provider configuration in
Kimi Code also works when the CLI's default model passes its auth gate.
Use the current Kimi Code CLI, not the archived Python `kimi-cli` package.
On Windows, Kimi Code also requires Git for Windows; a custom Git Bash path
can be set with `KIMI_SHELL_PATH`.

Reference: https://www.kimi.com/code/docs/en/kimi-code-cli/guides/getting-started

## Connection troubleshooting

A provider connects a session's chosen model to Distill. After credentials are
saved, Distill fetches the provider's live model list as a side effect — that
request doubles as connection verification (it validates the key, URL, and
network in one shot). Raw provider errors are mapped to a stable set of
actionable causes worth knowing directly, since this mapping is a
deliberate, documented behavior rather than an implementation detail likely
to move:

- **401/403 or "unauthorized"/"invalid API key"** → the credential itself
  was rejected. Have the user re-check the key.
- **404 / "not found"** → the server was reachable but the path was wrong.
  Most often a missing `/v1` suffix on a custom provider URL.
- **Connection refused, timeout, DNS failure, "network error"** → nothing
  answered at all. Check the URL, network, and whether the provider's
  service is up.
- **429 / "rate limit" / "too many requests"** → the key works; the
  provider is throttling. Not a configuration problem.

For provider setup that runs through a CLI installer (some providers install
a local binary), a different, narrower failure taxonomy applies — an
existing file at the target path, or an unsupported OS/architecture
combination — see `src/features/providers/lib/agentSetupTroubleshooting.ts`.
Do not guess at which specific providers are available, curated, or
custom-only from memory; verify against `src/features/providers/`
(`curatedProviders.ts`, `providerCatalog.ts`) since the provider list and
setup flow are active areas of change.
