# Z.ai Coding Plan

Flock runs GLM models through OpenCode's native ACP interface. In Settings >
AI providers, install the Z.ai Coding Plan runtime, choose Add account on the
Z.ai card, and paste a key from the
[Z.ai API console](https://z.ai/manage-apikey/apikey-list). An active GLM
Coding Plan is required. A login at chat.z.ai alone does not provide this
subscription. The Z.ai card is the same card every provider has (see
[provider accounts](provider-accounts.md)); what sets it apart is data in the
account model: its connection flow is an API key only, so the Add account
dialog offers no browser sign-in, and the key is the Coding Plan key, so the
billing chip reads API key while benchmark configurations record the plan
as a subscription.

The account uses `https://api.z.ai/api/coding/paas/v4`, the subscription endpoint
documented in [Z.ai's OpenCode guide](https://docs.z.ai/devpack/tool/opencode).
Only the `zai-coding-plan` provider is enabled. There is no automatic fallback
to the separately billed general API. Model availability still depends on the
account's plan. The model and effort pickers use OpenCode's live ACP inventory.
The newest GLM generation appears first; earlier generations are in More models.
When the inventory offers both a model and its Highspeed variant, Fast mode
selects between them. Flash remains a separate model. Effort uses the composer’s
separate control and is retained when changing speed if the variant supports it.

Keys use the same Windows DPAPI storage as other managed Flock accounts.
The model runtime receives only its account's key; usage checks send it only to
Z.ai's quota endpoint. OpenCode's config, data, cache
and state directories are private to each account. Its own project configuration
is disabled for this integration so it cannot change the selected provider or
endpoint. Flock still supplies the chat's project context through its normal
session flow. Automatic conversation sharing is disabled.

Auto mode allows tools, approval mode asks for tools, smart approval allows file
reads and edits while asking for other tools, and chat mode uses OpenCode's plan
agent. Sign out clears the saved key while retaining account identity and chats.

The account row names the plan as GLM Coding Plan (Lite, Pro or Max, as
reported). Saving a key does not purchase a subscription. Flock reads account quota from Z.ai's
`/api/monitor/usage/quota/limit` endpoint with the saved key, following the
[official usage plugin](https://docs.z.ai/devpack/extension/usage-query-plugin).
The account card and Usage menu show five-hour and weekly consumption and
reported reset times. Account details also show credit balances and any reported
MCP tool-call allowance. Missing values remain unknown. A failed refresh preserves
previous measurements with an error; a telemetry cooldown is not an exhausted
model allowance. The integration never redeems quota resets automatically.

## Benchmarks

Benchmark sessions run the Linux build of the same OpenCode release inside the
`distill-bench` sandbox (see [benchmark operations](benchmark-operations.md)).
Benchmark configurations record Coding Plan use as `subscription`, since the
plan's endpoint is the only one configured. The sandbox keeps no key of its
own: before each session starts, Flock stages the account's saved key into
that session's private folder (`bench-auth stage`, on the helper's standard
input, never as an argument or in a log), so a changed key is used from the
next session on, and removing the key in Flock stops Z.ai benchmarks.

Each attempt gets its private copy of the key and may reach only `api.z.ai` on
port 443, at the addresses it resolves to when the attempt starts; it has no
DNS and no other host. OpenCode runs with its project configuration, Claude
compatibility, external skills, default plugins, model catalog fetch, sharing,
title requests and updates turned off, and with a root-owned configuration home
holding only the Flock policy plugin. The plugin makes the profile's prompt
the whole system prompt. The native text profile has no tools; the protected
repository profile allows OpenCode's file, search, shell and to-do tools, with
the ripgrep release OpenCode would otherwise download. It has no subagents and
no web tools.
