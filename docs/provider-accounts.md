# Provider accounts

Settings > Providers shows every provider in the same setup and usage section.
Claude Code and Codex use managed account profiles; Grok and Kimi keep their
native CLI authorization and feed the same plan, quota, and credit presentation.
Install/update and sign-in controls live in the provider's section. Add each
subscription account in Distill and complete its initial browser authorization once. API accounts
accept a separate key. Switching uses that account's saved credentials; it does
not sign out another account. The provider CLI refreshes OAuth credentials.
Revoked authorization still requires a new sign-in.
Adding a subscription with the same name under the same provider reuses its
existing connection, ignoring surrounding whitespace and letter case. This
also resumes an unfinished sign-in without creating another account card or
replacing the account's saved credentials and chat references.

Each connected profile offers Sign out. Subscription accounts use the
official logout command in that account's private home; API accounts clear only
their saved credentials. Sign-out keeps account IDs, defaults, and chat history,
then shows Sign in on the same profile. Busy accounts reject credential changes.
Signing back into an API account requires a new key. Account cards do not offer
editing or removal, and the reported identity is shown only once.

Set a provider default for new chats, or use the account selector in an existing
chat. Existing chats without an account ask the user to choose a connected
account before continuing. Concurrent chats can
use different accounts. A switch preserves the Distill transcript and selected
model; native CLI session state does not move between accounts. Switching a busy
chat is rejected until its current turn ends.

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
browser on a short-lived localhost success page. Distill waits for the matching
login ID, verifies saved authorization, and reaps the account process before
allowing another attempt. OAuth URLs and provider error details are not logged
or sent to the renderer.

The account panel polls every minute and refreshes on window focus or request.
It shows reported subscription, quota windows, reset times, account identity,
reset-credit inventory, and freshness. Missing provider telemetry is displayed
as unknown, never as an unlimited allowance. API-key accounts do not expose a
subscription quota meter. Claude's `get_usage` reply omits reset grants, so
Distill reads quota and `cedar_ember` grants together through the native CLI's
first-party usage endpoint. Full and five-hour grants show their availability
and expiry; missing telemetry stays unknown. Failed reads retain the last known
values as stale. A 429 pauses usage requests for at least one minute, increasing
to five minutes on repeated failures, or longer if requested by Retry-After.
Manual refresh respects this pause.
Telemetry failures do not change a connected account into a signed-out account.

Plan labels use public product names instead of internal provider codes. Codex
`prolite`, `pro`, and `promax` map to ChatGPT Pro 100, 200, and 500; a reported
usage plan takes precedence over the cached token's plan. Claude uses the native
profile's organization type and individual/organization rate-limit tier for the
same signed-in email, preserving Max (5x) and Max (20x). This profile takes
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

Settings reuses the existing native usage poller for Grok and Kimi and the
account monitor for Claude and Codex. One refresh action updates both, with one
last-checked timestamp beside it. No provider section starts another poller.

Account cards, the account picker, and status details share the same usage
projection and quota row component. Reported durations identify the five-hour,
weekly, and monthly windows; provider field names are not display labels.
Only reported windows appear. The status bar selects the provider's default
account from the account monitor, without fetching a separate quota snapshot.

Automatic switching is controlled by one compact switch in each provider's
header. It applies to all saved accounts in that group; individual accounts have
no enable or inclusion switches. Legacy account-level opt-outs are cleared when
the account index is read, while each provider's saved switch stays unchanged.
The current account remains selected while usable. A quota failure can select
another available account for the same provider and billing mode; a subscription
chat does not automatically become a paid API chat. An API chat can switch to
another API account in its provider group.

When every eligible account is exhausted, the message stays queued. Distill
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

`<DISTILL_ROOT>/provider-accounts/index.json` stores account IDs, labels, provider
defaults and routing preferences. Each managed UUID has a separate home in this
directory. The provider runtime installed by Distill owns its OAuth token lifecycle. Windows account
directories are restricted to the current user and SYSTEM; API keys use Windows
DPAPI. Credentials are not returned to renderer stores or included in chat
metadata. Keep this directory private when copying or backing up a data root.

Host sessions persist `account_id` in SQLite. Processes, event routing, model
inventories and native session IDs are scoped to the provider and account.
Inherited credentials from a different account are removed for managed entries.
Updating credentials or removing an account is blocked while it runs a turn.

There is no system CLI account or fallback to credentials from another app.
Both providers use the same account flow and isolated storage. The v2 account
index drops the old external-login entries while retaining saved Distill
accounts, their credentials and routing preferences. The database migration
clears external account references without changing transcripts. Selecting a
connected account resumes these chats through transcript transfer. Importing
native CLI session state and any authorization needed for that import are
separate from connecting a Distill account.

Codex status and manual reset use its native app-server account APIs. Claude
status uses the pinned CLI's `initialize` control request with
hooks, tools, MCP and session persistence disabled. Neither telemetry adapter
sends prompts or starts model inference. The CLI determines effective billing
and refreshes rejected OAuth credentials through `get_usage`, including accounts
idle between uses. Normal polls make a single usage request, avoiding a second
read of the same endpoint for reset inventory. Claude requests read only the
selected account's credentials in the backend and use the native CLI's reported
version for eligibility. Credentials never enter the renderer. Redirects are disabled;
reset requests go only to the first-party Anthropic API. The operator must
confirm the displayed account before the selected grant is redeemed.
