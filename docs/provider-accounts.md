# Provider accounts

Settings > AI providers shows one card per harness, and every card has the
same structure: the harness header (icon, name, description, install or
update state), the Auto-switch accounts switch and the Add account button,
and one row per account with its identity, Default chip, billing chip, plan,
usage windows with reset times, and its own Sign in or Sign out. The host
lists every provider in one account model (`list_provider_accounts`), and the
differences between providers are fields of that model, not separate
screens:

| Provider | Connection | Accounts | Usage reported | Sign out |
| --- | --- | --- | --- | --- |
| Claude Code, Codex | browser sign-in of the CLI, or an API key | any number, stored by Flock | yes | yes |
| Z.ai | an API key (the Coding Plan key) | any number, stored by Flock | yes | yes |
| Grok, Kimi Code | the CLI's own sign-in | one, named by Flock | yes | yes |
| Copilot, Amp | the CLI's own sign-in | one, named by Flock | not reported | no sign-out flow |

Claude Code, Codex and Z.ai accounts are stored by Flock. Add each
subscription account in Flock and complete its initial browser authorization
once. API accounts accept a separate key. Switching uses that account's saved
credentials; it does not sign out another account. The provider CLI refreshes
OAuth credentials. Revoked authorization still requires a new sign-in.

Grok, Kimi Code, Copilot and Amp keep one sign-in in their own CLI. Flock
names that sign-in as the provider's one account (`cli-login-<provider>`),
shows it as the only row of the card, and runs the CLI's own sign-in and
sign-out from that row (`grok login --oauth` and `grok logout`, `kimi login`
and Kimi's ACP logout, `copilot login`, `amp login`), with the CLI's streamed
output in the card header as before. Flock never holds these credentials.
Because the CLI holds one sign-in, the card's switch and Add account button
are disabled and the card says why; sign out of the sign-in to connect
another. A harness without a sign-out flow (Copilot, Amp) offers none, and
a harness without a usage source shows "Usage limits not reported" rather
than a claim.
Adding a subscription with the same name under the same provider reuses its
existing connection, ignoring surrounding whitespace and letter case. This
also resumes an unfinished sign-in without creating another account card or
replacing the account's saved credentials and chat references.

Each connected account offers Sign out. Stored subscription accounts use the
official logout command in that account's private home; API accounts clear only
their saved credentials; a CLI sign-in runs the CLI's own sign-out. Sign-out
keeps account IDs, defaults, and chat history, then shows Sign in on the same
row. Busy accounts reject credential changes. Signing back into an API account
requires a new key. Account rows do not offer editing or removal, and the
reported identity is shown only once.

Manage accounts only in Settings > AI providers: select a provider default for
new chats and configure automatic switching there. Chat composers have no account
selector or account-management dialog. Concurrent chats can use different
accounts. An automatic switch preserves the Flock transcript and selected
model; native CLI session state does not move between accounts.

## Limits and automatic switching

Browser sign-in can be cancelled from the account card and expires after five
minutes. Cancellation waits for the native login process to exit before releasing
the account and provider locks, so the callback port is free for retry. Other
accounts keep their credentials. Attempt IDs prevent delayed completion messages
from an earlier attempt from replacing the state of a new sign-in. Pending
sign-in shows its browser instruction and cancellation action without quota
errors caused by the temporary credential lock.
Codex signs in through its native app-server account protocol and uses the
provider's hosted completion page. Finishing sign-in no longer leaves the
browser on a short-lived localhost success page. Flock waits for the matching
login ID, verifies saved authorization, and reaps the account process before
allowing another attempt. OAuth URLs and provider error details are not logged
or sent to the renderer.

The account panel polls every minute and refreshes on window focus or request.
It shows reported subscription, quota windows, reset times, account identity,
reset-credit inventory, and freshness. Missing provider telemetry is displayed
as unknown, never as an unlimited allowance. API-key accounts do not expose a
subscription quota meter. Claude's `get_usage` reply omits reset grants, so
Flock reads quota and `cedar_ember` grants together through the native CLI's
first-party usage endpoint. Full and five-hour grants show their availability
and expiry; missing telemetry stays unknown. Failed reads retain the last known
values as stale. A 429 pauses usage requests for at least one minute, increasing
to five minutes on repeated failures, or longer if requested by Retry-After.
One Refresh action at the top updates the panel; account cards have no duplicate.
Manual refresh respects this pause. Expired or removed OAuth authorization
invalidates the cached pause so it cannot hide the need to sign in; once the
CLI restores the token, the provider's pause and its escalation still apply.
During a valid authorization's pause, the monitor skips native CLI probes. The
account card shows a countdown instead of a red usage error; the stored error
carries no countdown, so no view shows a number frozen at the time of the 429.
The native account identity and plan survive a failed usage read, including the
first read after startup and a reply without quota. A malformed reset inventory
leaves reset credits unknown without discarding valid quota. Saved quota values
remain explicitly stale until a successful update.
Telemetry failures do not change a connected account into a signed-out account.

Plan labels use public product names instead of internal provider codes. Codex
`prolite`, `pro`, and `promax` map to ChatGPT Pro 100, 200, and 500; a reported
usage plan takes precedence over the cached token's plan. Claude uses the native
profile's organization type and individual/organization rate-limit tier for the
same signed-in email: the 20x tier shows as Claude Ultra and the 5x tier as
Claude Max, the names Anthropic gave those plans in October 2026, although the
profile still reports both as Max with the old tier codes. This profile takes
precedence over the credential's subscription type, which can retain the old
plan after an upgrade. Missing tier metadata falls back to the reported plan
family without guessing a multiplier. These names are not invoice amounts or
renewal prices. Credit balances are rounded and grouped for display while the
original provider value remains unchanged.

Balances share one contract: label, remaining amount, optional total, currency,
expiry, and an explicit unlimited flag. Currency amounts use major units and
locale-aware currency precision; nonmonetary credits display as rounded counts.
Claude usage includes credit grants and purchased usage balances when reported.
Kimi's local API supplies the profile's plan name and account identity, plus its
extra-usage wallet. Optional profile failure does not discard valid Kimi quotas.
Missing balances do not become zero. Grants do not count as blocking subscription
quotas, and reset actions appear only where a provider supports them.

One account monitor reads every account's status, whether Flock stores the
account or the provider's CLI keeps it: Claude and Codex through their native
account protocols, Z.ai through its quota endpoint, Grok through its CLI's
billing endpoint, Kimi through the CLI's authenticated local API. The status
bar shows each provider's default account from that same read. One refresh
action updates everything, with one last-checked timestamp beside it. No
provider section starts another poller, and an isolated E2E run never
probes the machine's own CLI sign-ins.

Account cards and status details share the same usage
projection and quota row component. Reported durations identify the five-hour,
weekly, and monthly windows; provider field names are not display labels.
Only reported windows appear. The status bar selects the provider's default
account from the account monitor, without fetching a separate quota snapshot.

Automatic switching is controlled by one compact switch in each provider's
card. It applies to all saved accounts in that group; individual accounts have
no enable or inclusion switches. A provider whose CLI keeps one sign-in has
nothing to switch between, so its switch stays off and disabled. Legacy account-level opt-outs are cleared when
the account index is read, while each provider's saved switch stays unchanged.
The current account remains selected while usable. A quota failure can select
another available account for the same provider and billing mode; a subscription
chat does not automatically become a paid API chat. An API chat can switch to
another API account in its provider group.

**Purchased Codex credits keep an account usable**, as in the Codex app. A
spent plan window of a bucket whose credits snapshot reports credits (the
server's `hasCredits`, an unlimited flag, or a balance above zero) does not
block, and the account shows Running on credits. A spending allowance
(`spendControlReached`, a spent `individualLimit`, a credits-depleted or
workspace usage block) still blocks, and a zero balance leaves the account
limited. Plan usage goes first: the current account's, then a spare's with
automatic switching, and only then credits. Chats and application tasks may
run on credits. Benchmark turns may only within the credit limit set in
Settings > Benchmarks; judges never do. A provider refusal outranks the
credit balance it last reported.

When every eligible account is exhausted, the message stays queued. Flock
waits for the earliest time at which an account's blocking windows have all
reset. Unknown reset times are polled again. A manual account change or fresh
available quota wakes the queue. A partially executed turn is never replayed
automatically; transparent retry requires proof that the provider accepted no
prompt activity and the host removed its rejected turn.

**Reset credits are operator-only.** Polling, routing and queued retries never
consume them. The operator selects Use reset and confirms the specific account.
Both providers' operations carry an idempotency UUID. The dialog retains the
selected credit and UUID after an uncertain response, so retrying cannot
silently spend a different grant. Claude uses the provider's grant eligibility
and `reset_rate_limits` response; an unconfirmed response is never success.
A previously reported, unexpired grant remains selectable during a telemetry
failure. Confirmation pins that grant's ID, and the provider checks its current
eligibility on redemption. An aggregate count without grant IDs still requires
fresh telemetry. Automatic routing continues to require fresh quota data.

## Storage and protocol

`provider-accounts/index.json` in the Flock folder stores account IDs, labels, provider
defaults and routing preferences. Each managed UUID has a separate home in this
directory. The provider runtime installed by Flock owns its OAuth token lifecycle. Windows account
directories are restricted to the current user and SYSTEM; API keys use Windows
DPAPI. Credentials are not returned to renderer stores or included in chat
metadata. Keep this directory private when copying or backing up a data root.

Host sessions persist `account_id` in SQLite. Processes, event routing, model
inventories and native session IDs are scoped to the provider and account.
Inherited credentials from a different account are removed for managed entries.
Updating credentials or removing an account is blocked while it runs a turn.

Benchmark sessions in the dedicated WSL sandbox run on leases of the selected
account's sign-in in Flock: a copy of its current grant without a refresh
token, staged for each session (see
[benchmark operations](benchmark-operations.md)). Flock is the only place an
account signs in and the only process that refreshes its grant, so a sandbox
session spends the same allowance under the same sign-in, and dispatch reads
the same account status for it as for chats: a quota rejection in the sandbox
blocks the account in Settings too. Owned sessions retain their frozen account.

Benchmarks run Codex on the same account home, and Codex loads that home into
every thread. A Codex account is benchmarked only while its home holds no
`AGENTS.md`, `AGENTS.override.md`, `hooks.json` or `hooks/` and its
`config.toml` sets nothing but the `cli_auth_credentials_store` Flock writes;
otherwise its benchmark rows say why they are unavailable. Chats are unaffected.

There is no system CLI account or fallback to credentials from another app.
Every stored provider uses the same account flow and isolated storage.

Grok, Kimi Code, Copilot and Amp store no accounts; their CLI keeps the
sign-in. Flock names it with one fixed CLI sign-in identity per provider,
`cli-login-<provider>`, so Settings can show it as the provider's one account
and benchmarks can key configurations, bridge routes and account activity by
it. The identity is never stored and has no home or key file of its own: the
account environment for it is the shell environment unchanged. Its status
comes from the provider's own usage source where one exists (Grok's billing
endpoint, Kimi's local API); Copilot and Amp have none, so their row reports
no usage and takes its sign-in state from the harness probe in the doctor
report. Chats keep running on the CLI without an account, and their activity
counts as the identity's activity, since both share one sign-in and one
allowance. A Grok benchmark session in the sandbox runs on a lease of the
user's Grok CLI sign-in: its access token, issue and expiry times and identity (`key`,
`auth_mode`, `create_time`, `expires_at`, `user_id`, `email`), with no refresh
or other token, staged for that session alone, so it can never rotate the
sign-in the user's own Grok keeps. Flock reads the user's `auth.json` and
never writes it; when a session needs the sign-in to last longer, a short
Grok process on Windows renews it the CLI's own way (see
[benchmark operations](benchmark-operations.md)). A Kimi benchmark session runs
on Kimi's own sandbox sign-in, never a copy of the user's Kimi home. The v2 account
index drops the old external-login entries while retaining saved Flock
accounts, their credentials and routing preferences. The database migration
clears external account references without changing transcripts. Selecting a
connected account resumes these chats through transcript transfer. Importing
native CLI session state and any authorization needed for that import are
separate from connecting a Flock account.

Codex status and manual reset use its native app-server account APIs. Claude
status uses the pinned CLI's `initialize` control request with
hooks, tools, MCP and session persistence disabled. Neither telemetry adapter
sends prompts or starts model inference. The CLI determines effective billing
and refreshes expired or rejected OAuth credentials through `get_usage`, including
accounts idle between uses. Flock asks for that refresh within the CLI's own
five-minute margin before expiry, so a token cannot lapse during the probe, and
checks the token before a usage request. The account requires sign-in only on
positive evidence: no saved refresh token, the CLI reporting it signed out, or
a second rejection after the refresh. A refresh that fails for a passing reason,
such as a network that is not back after wake, is a telemetry failure: the
account stays connected with its last known values and the next poll retries.
Signing in again clears the previous usage cooldown; a routine token refresh
does not. Normal polls make a single usage request, avoiding a second
read of the same endpoint for reset inventory. Claude requests read only the
selected account's credentials in the backend and use the native CLI's reported
version for eligibility. Credentials never enter the renderer. Redirects are disabled;
reset requests go only to the first-party Anthropic API. The operator must
confirm the displayed account before the selected grant is redeemed.
